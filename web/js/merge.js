// Merging floors and ceilings by polygon union (polygon-clipping, vendored). Each merge is one undoable command: the
// kept record (the last one clicked) gets the united outline(s), the others are deleted (to the trash, restorable).
//   Floors: their outlines are united into one; they must touch or overlap.
//   Ceilings: all patches of the selected ceilings go to the kept one, and flat patches at the same height (within
//   2 cm) that touch or overlap become one patch. Sloped and cone patches, and patches at other heights, are kept.
import '../vendor/polygon-clipping/polygon-clipping.umd.js';     // defines globalThis.polygonClipping
import * as M from './model.js';
import * as B from './build.js';
import { S, ctx, EL, num, mm, toast, log } from './state.js';
import { commit } from './commands.js';
import { deleteCommands } from './tools.js';
import { orderedSelection } from './gumball.js';

const PC = globalThis.polygonClipping;
const Z_TOL = 0.02;

/** Our polygon (+ holes) as a polygon-clipping polygon, and back (closing points and collinear points dropped). */
const toPC = (poly, holes) => [poly, ...(holes || [])].map((r) => r.map((p) => [p[0], p[1]]));
function clean(ring) {
  let r = ring.map((p) => [M.r4(p[0]), M.r4(p[1])]);
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r = r.slice(0, -1);
  for (let changed = true; changed && r.length > 3;) {               // drop duplicate and collinear corners
    changed = false;
    for (let i = 0; i < r.length; i++) {
      const a = r[(i - 1 + r.length) % r.length], b = r[i], c = r[(i + 1) % r.length];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(cross) < 1e-6 || (b[0] === a[0] && b[1] === a[1])) { r.splice(i, 1); changed = true; break; }
    }
  }
  return r;
}
const fromPC = (pg) => ({ polygon: clean(pg[0]), holes: pg.length > 1 ? pg.slice(1).map(clean) : null });
const area = (p) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
function inside(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
const centroidOf = (p) => p.reduce((a, q) => [a[0] + q[0] / p.length, a[1] + q[1] / p.length], [0, 0]);

/** set: the kept record's new fields (exact undo), plus deletes of the others; one command. */
function mergeCommand(kind, keep, after, others, label) {
  const before = {}, beforeAbsent = [], afterAbsent = [];
  for (const k of Object.keys(after)) { if (k in keep.rec) before[k] = M.clone(keep.rec[k]); else beforeAbsent.push(k); }
  for (const [k, v] of Object.entries(after)) if (v === undefined) { delete after[k]; afterAbsent.push(k); }
  const set = { op: 'set', kind, id: keep.id, before, after: M.clone(after), ...(beforeAbsent.length ? { beforeAbsent } : {}), ...(afterAbsent.length ? { afterAbsent } : {}) };
  const cmds = [set, ...deleteCommands(others)];
  commit({ op: 'batch', cmds, opName: `${kind}.merge`, label, via: 'merge', input: 'layout', constraint: { kept: keep.id, merged: others.map((e) => e.id) } });
}

const keptOf = (els) => els.find((e) => e.id === S.sel) || els[0];

export function mergeFloors(ids = orderedSelection()) {
  const els = ids.map((id) => EL.get(id)).filter((e) => e && e.kind === 'floor');
  if (els.length < 2) { toast('Select two or more floors to merge.'); return false; }
  const keep = keptOf(els), others = els.filter((e) => e !== keep);
  const zs = els.map((e) => { const c = centroidOf(e.rec.polygon); return B.floorZ(e.rec)(c[0], c[1]); });
  const dz = Math.max(...zs) - Math.min(...zs);
  if (dz > 0.03 && !confirm(`These floors are at different heights (up to ${num(dz * 100, 1)} cm apart). Merge them at ${keep.id}'s height?`)) return false;
  const U = PC.union(...els.map((e) => toPC(e.rec.polygon, e.rec.holes)));
  if (U.length !== 1) {
    toast(`The floors do not form one connected area (${U.length} separate pieces): they must touch or overlap. Use Points to make their edges meet first.`, 6000);
    log('merge_refused', { kind: 'floor', ids: els.map((e) => e.id), pieces: U.length });
    return false;
  }
  const g = fromPC(U[0]);
  mergeCommand('floor', keep, { polygon: g.polygon, holes: g.holes }, others, `merge ${els.length} floors into ${keep.id}`);
  toast(`Merged ${els.length} floors into ${keep.id} (${num(area(g.polygon), 1)} m²${g.holes ? `, ${g.holes.length} hole${g.holes.length > 1 ? 's' : ''}` : ''}). The rooms stay as they are.`, 5000);
  return true;
}

/** Merge the patches of one or more ceilings (see the top). */
export function mergeCeilings(ids = orderedSelection()) {
  const els = ids.map((id) => EL.get(id)).filter((e) => e && e.kind === 'ceiling');
  if (!els.length) { toast('Select one or more ceilings.'); return false; }
  const keep = keptOf(els), others = els.filter((e) => e !== keep);
  const pool = [keep, ...others].flatMap((e) => (e.rec.patches || []).map((p) => M.clone(p)));
  const flat = (p) => p.polygon && p.polygon.length > 2 && !(p.modeled_as === 'cone' && p.cone) && p.modeled_as !== 'plane' && typeof p.z === 'number';
  // clusters of flat patches at the same height (and of the same kind), then their united pieces
  const out = [], used = new Set();
  let merged = 0;
  pool.forEach((p, i) => {
    if (used.has(i)) return;
    if (!flat(p)) { out.push(p); used.add(i); return; }
    const group = pool.map((q, j) => [q, j]).filter(([q, j]) => !used.has(j) && flat(q) && (q.kind || '') === (p.kind || '') && Math.abs(q.z - p.z) <= Z_TOL);
    group.forEach(([, j]) => used.add(j));
    if (group.length === 1) { out.push(p); return; }
    const U = PC.union(...group.map(([q]) => toPC(q.polygon, q.holes)));
    merged += group.length - U.length;                      // patches that became part of another
    for (const piece of U) {
      const g = fromPC(piece);
      const src = group.map(([q]) => q).filter((q) => inside(centroidOf(q.polygon), g.polygon));
      const base = (src.length ? src : group.map(([q]) => q)).reduce((a, q) => (area(q.polygon) > area(a.polygon) ? q : a));
      const n = src.length || 1;
      out.push({ ...base, polygon: g.polygon, holes: g.holes, ...(n > 1 ? { notes: `${base.notes ? `${base.notes}; ` : ''}merged from ${n} patches in the annotation tool` } : {}) });
    }
  });
  if (!merged && !others.length) { toast('No flat patches of this ceiling touch at the same height: nothing to merge.'); return false; }
  const zs = out.flatMap((p) => (typeof p.z === 'number' ? [p.z] : p.z_range || []));
  const after = { patches: out };
  if (zs.length) after.z_range = [mm(Math.min(...zs)), mm(Math.max(...zs))];
  const main = out.find((p) => p.kind === 'main');
  if (main && typeof main.z === 'number' && 'main_z' in keep.rec) after.main_z = main.z;
  mergeCommand('ceiling', keep, after, others, `merge ${els.length > 1 ? `${els.length} ceilings` : 'patches'} into ${keep.id}`);
  toast(`${keep.id}: ${pool.length} patches → ${out.length}${others.length ? ` (from ${els.length} ceilings)` : ''}. Patches at other heights, sloped and cone patches are kept as they are.`, 6000);
  return true;
}
