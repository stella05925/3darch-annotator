// Layout tools on a multi-selection (PowerPoint-like). The primary element (the last one clicked) is the reference.
// Each tool is one undoable command; every change is a parametric field change.
import * as M from './model.js';
import { TYPES, readOnlyReason } from './registry.js';
import { S, EL, mm, toast, log, recOf } from './state.js';
import { editMany, insertRecord } from './commands.js';
import { orderedSelection } from './gumball.js';
import { startModal } from './modal.js';
import { TransformSession, transformable } from './transform.js';
import { selectMany } from './selection.js';

const DEG = 180 / Math.PI;
const editable = (ids) => ids.map((id) => EL.get(id)).filter((el) => el && !readOnlyReason(el));

/** Walls: move each wall parallel to the reference so its axis / face lies on the reference's axis / face line. */
export function alignWalls(mode = 'axis') {
  const [ref, ...rest] = editable(orderedSelection()).filter((e) => e.kind === 'wall' && e.rec.shape !== 'arc');
  if (!ref || !rest.length) { toast('Select two or more straight walls (the last one clicked is the reference).'); return false; }
  const f0 = M.wallFrame(ref.rec), h0 = ref.rec.thickness / 2, n = f0.n;
  const skipped = [];
  const ok = editMany(rest.map((e) => e.id), (el) => {
    const w = el.rec, f = M.wallFrame(w);
    if (Math.abs(f.t[0] * f0.t[1] - f.t[1] * f0.t[0]) > Math.sin(5 / DEG)) { skipped.push(el.id); return; }   // not parallel
    const dist = (w.axis.start[0] - f0.s[0]) * n[0] + (w.axis.start[1] - f0.s[1]) * n[1], h = w.thickness / 2;
    // the face of this wall on the reference's +n side sits at dist + h, the one on its -n side at dist - h
    const shift = mode === 'axis' ? -dist : mode === 'faceL' ? h0 - (dist + h) : -h0 - (dist - h);
    w.axis.start = [mm(w.axis.start[0] + n[0] * shift), mm(w.axis.start[1] + n[1] * shift)];
    w.axis.end = [mm(w.axis.end[0] + n[0] * shift), mm(w.axis.end[1] + n[1] * shift)];
  }, { opName: 'wall.align', label: `align walls to ${ref.id} (${mode})`, via: 'layout', input: 'layout', constraint: { mode, reference: ref.id } });
  if (skipped.length) toast(`Not parallel to ${ref.id} (more than 5°), left as they are: ${skipped.join(', ')}`, 5000);
  return ok;
}

/** Openings: same sill (or head) height as the reference, keeping each opening's own height. */
export function alignOpenings(which = 'sill') {
  const [ref, ...rest] = editable(orderedSelection()).filter((e) => e.kind === 'opening');
  if (!ref || !rest.length) { toast('Select two or more openings (the last one clicked is the reference).'); return false; }
  return editMany(rest.map((e) => e.id), (el) => {
    const o = el.rec, h = o.head_z - o.sill_z;
    if (which === 'sill') { o.sill_z = ref.rec.sill_z; o.head_z = mm(ref.rec.sill_z + h); }
    else { o.head_z = ref.rec.head_z; o.sill_z = mm(ref.rec.head_z - h); }
  }, { opName: `opening.align_${which}`, label: `align ${which}s to ${ref.id}`, via: 'layout', input: 'layout', constraint: { mode: which, reference: ref.id } });
}

/** Extent of an element along a direction (from its mesh vertices). */
function extentAlong(el, dir) {
  let lo = Infinity, hi = -Infinity;
  for (const m of el.meshes) {
    const p = m.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) { const v = p.getX(i) * dir[0] + p.getY(i) * dir[1]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  return [lo, hi];
}

/**
 * Distribute evenly with equal gaps, keeping the two outermost elements in place: openings along their common host
 * wall, anything else along the line between the two elements farthest apart. Returns the gaps (m).
 */
export function distribute() {
  const els = editable(orderedSelection());
  if (els.length < 3) { toast('Select three or more elements to distribute.'); return null; }
  const hosts = new Set(els.map((e) => e.rec.host_wall));
  if (els.every((e) => e.kind === 'opening') && hosts.size === 1 && recOf([...hosts][0])?.shape === 'arc') {
    toast('Distributing openings along a round wall is not supported yet.'); return null;
  }
  if (els.every((e) => e.kind === 'opening') && hosts.size === 1) {
    const sorted = [...els].sort((a, b) => a.rec.position.u_start - b.rec.position.u_start);
    const widths = sorted.map((e) => e.rec.position.u_end - e.rec.position.u_start);
    const first = sorted[0].rec.position, last = sorted[sorted.length - 1].rec.position;
    const gap = (last.u_start - first.u_end - widths.slice(1, -1).reduce((a, b) => a + b, 0)) / (sorted.length - 1);
    if (gap < 0) { toast('The openings do not fit between the two outer ones.'); return null; }
    let u = first.u_end + gap;
    const place = new Map();
    for (let i = 1; i < sorted.length - 1; i++) { place.set(sorted[i].id, u); u += widths[i] + gap; }
    editMany([...place.keys()], (el) => {
      const P = el.rec.position, w = P.u_end - P.u_start, u0 = place.get(el.id);
      P.u_start = mm(u0); P.u_end = mm(u0 + w);
    }, { opName: 'opening.distribute', label: `distribute ${sorted.length} openings on ${[...hosts][0]}`, via: 'layout', input: 'layout',
      constraint: { mode: 'equal_gaps', along: [...hosts][0] } });
    const g = sorted.slice(1).map((e, i) => mm(EL.get(e.id).rec.position.u_start - EL.get(sorted[i].id).rec.position.u_end));
    toast(`Distributed: gaps ${g.map((x) => x.toFixed(3)).join(' / ')} m`, 5000);
    return g;
  }
  // generic: centres, the line between the two farthest-apart elements
  const ok = els.filter((e) => TYPES[e.kind].xf && TYPES[e.kind].xf.axes.translate.length);
  if (ok.length < 3) { toast('These elements cannot be distributed.'); return null; }
  const c = ok.map((e) => TYPES[e.kind].xf.frame(e.rec).center);
  let a = 0, b = 1, best = -1;
  for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) { const d = Math.hypot(c[i][0] - c[j][0], c[i][1] - c[j][1]); if (d > best) { best = d; a = i; b = j; } }
  const dir = [(c[b][0] - c[a][0]) / best, (c[b][1] - c[a][1]) / best];
  const items = ok.map((e) => ({ e, ext: extentAlong(e, dir) })).sort((x, y) => x.ext[0] - y.ext[0]);
  const sizes = items.map((x) => x.ext[1] - x.ext[0]);
  const gap = (items[items.length - 1].ext[0] - items[0].ext[1] - sizes.slice(1, -1).reduce((s, v) => s + v, 0)) / (items.length - 1);
  if (gap < 0) { toast('The elements do not fit between the two outer ones.'); return null; }
  let pos = items[0].ext[1] + gap;
  const shift = new Map();
  for (let i = 1; i < items.length - 1; i++) { shift.set(items[i].e.id, pos - items[i].ext[0]); pos += sizes[i] + gap; }
  editMany([...shift.keys()], (el, tx) => {
    const k = shift.get(el.id), f = TYPES[el.kind].xf.translate(tx.rec0(el.id), [dir[0] * k, dir[1] * k, 0]);
    for (const [p, v] of Object.entries(f)) M.setPath(el.rec, p, M.clone(v));
  }, { opName: 'multi.distribute', label: `distribute ${items.length} elements`, via: 'layout', input: 'layout', constraint: { mode: 'equal_gaps', dir } });
  const g = items.slice(1).map((x, i) => mm(extentAlong(EL.get(x.e.id), dir)[0] - extentAlong(EL.get(items[i].e.id), dir)[1]));
  toast(`Distributed: gaps ${g.map((x) => x.toFixed(3)).join(' / ')} m`, 5000);
  return g;
}

/** Copy the reference's thickness / heights / type ... (registry `match`) to the other selected elements of its kind. */
export function matchProperties() {
  const [ref, ...rest] = editable(orderedSelection());
  const same = rest.filter((e) => e.kind === (ref && ref.kind) && (e.kind !== 'wall' || (e.rec.shape === 'arc') === (ref.rec.shape === 'arc')));
  const fields = ref && TYPES[ref.kind].match;
  if (!ref || !same.length || !fields) { toast('Select the elements to change, then (last) the one to copy from.'); return false; }
  const r = ref.rec;
  return editMany(same.map((e) => e.id), (el) => {
    const o = el.rec;
    for (const k of fields) {
      if (k === 'width') {                                    // openings: same width about the same centre
        const c = (o.position.u_start + o.position.u_end) / 2, w = r.position.u_end - r.position.u_start;
        o.position.u_start = mm(c - w / 2); o.position.u_end = mm(c + w / 2);
      } else if (k === 'top_z' && o.top_profile) {            // walls under sloped ceilings: shift their profile
        const d = r.top_z - o.top_z; o.top_z = r.top_z; o.top_profile = { ...o.top_profile, z: o.top_profile.z.map((z) => mm(z + d)) };
      } else if (k === 'type' && el.kind === 'opening') {
        o.type = r.type;
        if (r.type === 'door' && !o.door) o.door = { state: 'unknown', kind: null };
        if (r.type === 'window' && !o.window) o.window = {};
      } else if (r[k] !== undefined) o[k] = M.clone(r[k]);
    }
  }, { opName: `${ref.kind}.match_properties`, label: `match ${fields.join(', ')} from ${ref.id}`, via: 'layout', input: 'layout', constraint: { reference: ref.id, fields } });
}

/** Shift+D: duplicate the selection, then move the copies (keyboard move; Esc removes them again). */
export function duplicateSelection() {
  const order = Object.keys(TYPES);                        // walls before openings, so copies can find their copied host
  const els = editable(orderedSelection()).filter((e) => TYPES[e.kind].duplicate).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  if (!els.length) { toast('Nothing to duplicate (round walls and some types cannot be duplicated yet).'); return false; }
  const map = new Map(), newIds = [];
  for (const el of els) {
    const copy = TYPES[el.kind].duplicate(el.rec);
    map.set(el.id, copy.id);
    if (el.kind === 'opening' && map.has(copy.host_wall)) copy.host_wall = map.get(copy.host_wall);
    insertRecord(el.kind, copy);
    newIds.push(copy.id);
  }
  selectMany(newIds, 'duplicate');
  log('duplicate_start', { from: [...map.keys()], ids: newIds });
  return startModal('translate', { ids: newIds, input: 'keyboard', opPrefix: 'duplicate', dup: newIds });
}

/** Shift+R: apply the last transform again to the current selection. */
export function repeatLast() {
  const L = S.lastTransform;
  if (!L) { toast('No transform to repeat yet.'); return false; }
  const { els, reason } = transformable(orderedSelection(), L.mode);
  if (!els.length) { toast(reason || 'Select something first.'); return false; }
  const s = new TransformSession({ els, mode: L.mode, input: 'repeat', space: L.space, pivot: L.pivot });
  s.apply(M.clone(L.params), L.constraint, { noSnap: true });
  return s.confirm();
}

