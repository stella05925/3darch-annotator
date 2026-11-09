// Point editing and drawing of plan shapes: room / floor / ceiling-patch / column / built-in / bulkhead / unscanned
// polygons, railing and separator polylines (each type lists its shapes in the registry: `shapes(el)`).
//   Points mode (Tab): drag a vertex (snaps to wall ends and axes, other shapes' corners; Shift: 45° from the previous
//   corner), drag an edge's midpoint to insert a corner, Alt+click a corner to delete it. A room's floor follows the
//   room while their outlines are the same. Every drag is one undoable command that writes the polygon field.
//   Draw tool: click corners on the current level; Enter, double-click or a click on the first corner finishes,
//   Backspace removes the last corner, Esc cancels. Creates a room (with its floor), column, built-in, bulkhead or
//   unscanned area.
import * as THREE from 'three';
import * as M from './model.js';
import { TYPES, readOnlyReason } from './registry.js';
import { S, ctx, EL, $, esc, mm, log, toast, levelById } from './state.js';
import * as R from './render.js';
import { rayHit, select } from './selection.js';
import { snapPoint, pxTol, wallsOnLevel, showGuide } from './snap.js';
import { beginEdit, commit } from './commands.js';

const V3 = THREE.Vector3;
const SPHERE = new THREE.SphereGeometry(1, 12, 8);
/** A corner / point handle: a white dot with a dark rim, so it shows on light and dark scan alike. */
function dot(p, spec) {
  const m = new THREE.Mesh(SPHERE, new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false }));
  m.position.set(...p); m.renderOrder = 999; m.userData.size = 1.5; m.userData.spec = spec;
  const rim = new THREE.Mesh(SPHERE, new THREE.MeshBasicMaterial({ color: '#111318', depthTest: false }));
  rim.renderOrder = 998.5; rim.scale.setScalar(1.35); rim.raycast = () => {};
  m.add(rim);
  return m;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Other elements whose outline is the same shape (a room and its floor) and should move with it. */
function linkedShapes(el, sh) {
  const pts = M.getPath(el.rec, sh.path);
  const out = [];
  if (el.kind === 'room') for (const f of ctx.DOC.floors || []) { if (f.room === el.id && eq(f.polygon, pts)) out.push({ id: f.id, path: 'polygon' }); }
  if (el.kind === 'floor') { const r = (ctx.DOC.rooms || []).find((x) => x.id === el.rec.room); if (r && eq(r.polygon, pts)) out.push({ id: r.id, path: 'polygon' }); }
  return out;
}

/** Corners of other shapes on the same level (rooms share corners). */
function cornerSnap(p, el, levels) {
  const tol = pxTol(p);
  let best = null;
  for (const o of EL.values()) {
    if (o === el || !TYPES[o.kind].shapes || !o.levels.some((l) => levels.includes(l)) || !o.group.visible) continue;
    for (const sh of TYPES[o.kind].shapes(o)) {
      const pts = sh.points ? sh.points.map((x) => M.getPath(o.rec, x)).filter(Boolean) : M.getPath(o.rec, sh.path) || [];
      for (const q of pts) {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d < tol && (!best || d < best.d)) best = { p: [...q], type: 'corner', target: o.id, d };
      }
    }
  }
  return best;
}
function snapCorner(p, el, levels, prev, shift) {
  if (shift && prev) return snapPoint(p, levels, null, prev, true);
  const c = cornerSnap(p, el, levels);
  const w = snapPoint(p, levels, null, null, false);
  if (c && (!w.type || c.d <= (w.d ?? Infinity))) return c;
  return w;
}

// ------------------------------------------------------------------ points mode handles
export function shapeHandles(el) {
  const t = TYPES[el.kind];
  if (!t.shapes || readOnlyReason(el)) return [];
  const out = [];
  for (const sh of t.shapes(el)) {
    if (sh.points) {                                           // separate defining points (wall / beam ends, a centre)
      for (const p of sh.points) {
        const q = M.getPath(el.rec, p);
        if (!q) continue;
        const z = q.length > 2 ? q[2] : sh.z;
        out.push({ object: dot([q[0], q[1], z], { name: `point ${p}`, tip: q.length > 2 ? 'drag the end · Alt+drag: up / down' : 'drag the end',
          begin: (e) => beginPoint(el, sh, p, e) }) });
      }
      continue;
    }
    const pts = M.getPath(el.rec, sh.path);
    if (!pts || pts.length < 2) continue;
    const n = pts.length, edges = sh.closed ? n : n - 1;
    // outline of the shape being edited
    const ring = pts.map((p) => new V3(p[0], p[1], sh.z));
    if (sh.closed) ring.push(ring[0]);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), new THREE.LineBasicMaterial({ color: '#ffffff', depthTest: false }));
    line.renderOrder = 998; line.userData.fixedScale = true; line.raycast = () => {};
    out.push({ object: line });
    pts.forEach((p, i) => {
      out.push({ object: dot([p[0], p[1], sh.z], { name: `vertex ${i}`, tip: 'drag the corner · Alt+click deletes it', begin: (e) => beginVertex(el, sh, i, false, e) }) });
    });
    for (let i = 0; i < edges; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const m = new THREE.Mesh(SPHERE, new THREE.MeshBasicMaterial({ color: '#00b8ff', depthTest: false, transparent: true, opacity: 0.85 }));
      m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, sh.z); m.renderOrder = 999; m.userData.size = 0.6;
      m.userData.spec = { name: `edge ${i}`, tip: 'drag to add a corner here', begin: (e) => beginVertex(el, sh, i + 1, true, e) };
      out.push({ object: m });
    }
  }
  return out;
}

function beginVertex(el, sh, i, insert, e) {
  const links = linkedShapes(el, sh);
  const pts0 = M.clone(M.getPath(el.rec, sh.path));
  const min = sh.closed ? 3 : 2;
  const meta = (op, extra = {}) => ({ opName: `${el.kind}.${op}`, label: `${el.id}: ${op.replace('_', ' ')}`, via: 'shape_handle', input: 'shape_handle',
    constraint: { shape: sh.path, vertex: i }, ...extra });
  const write = (tx, pts) => {
    M.setPath(el.rec, sh.path, pts);
    for (const l of links) { const o = EL.get(l.id); if (o) { M.setPath(o.rec, l.path, M.clone(pts)); R.refreshElement(o); } }
    R.refreshElement(el);
  };
  if (!insert && e.altKey) {                                   // Alt+click: delete the corner
    if (pts0.length <= min) { toast(`A ${sh.closed ? 'polygon' : 'line'} needs at least ${min} points.`); return null; }
    const tx = beginEdit([el.id, ...links.map((l) => l.id)]);
    write(tx, pts0.filter((_, j) => j !== i));
    tx.commit(meta('delete_vertex'));
    return null;
  }
  const plane = new THREE.Plane(new V3(0, 0, 1), -sh.z);
  const grab = rayHit(e, plane);
  if (!grab) return null;
  const tx = beginEdit([el.id, ...links.map((l) => l.id)]);
  const start = insert ? [(pts0[i - 1][0] + pts0[i % pts0.length][0]) / 2, (pts0[i - 1][1] + pts0[i % pts0.length][1]) / 2] : pts0[i];
  const base = insert ? [...pts0.slice(0, i), start, ...pts0.slice(i)] : pts0;
  const off = [start[0] - grab.x, start[1] - grab.y];
  const t0 = performance.now(), path = [], snaps = [];
  let last = 0, moved = false;
  return {
    update(ev) {
      const hit = rayHit(ev, plane);
      if (!hit) return;
      moved = true;
      const prev = base[(i - 1 + base.length) % base.length];
      const s = ev.ctrlKey || ev.metaKey ? { p: [hit.x + off[0], hit.y + off[1]], type: null }
        : snapCorner([hit.x + off[0], hit.y + off[1]], el, el.levels.length ? el.levels : [S.level], prev, ev.shiftKey);
      const pts = base.map((p) => [...p]);
      pts[i] = [mm(s.p[0]), mm(s.p[1])];
      write(tx, pts);
      showGuide(s.type ? { ...s, at: [pts[i][0], pts[i][1], sh.z] } : null);
      if (s.type && !snaps.some((x) => x.type === s.type && x.target === s.target)) snaps.push({ type: s.type, target: s.target || null });
      const now = performance.now();
      if (now - last >= 100) { last = now; path.push({ t: Math.round(now - t0), p: pts[i] }); }
    },
    end() {
      showGuide(null);
      if (!moved) { tx.cancel(); return; }
      tx.commit(meta(insert ? 'insert_vertex' : 'move_vertex', { snaps, path, duration_ms: Math.round(performance.now() - t0) }));
    },
    cancel() { showGuide(null); tx.cancel(); },
  };
}

/** Drag one defining point (a wall / screen / beam end, a skylight centre). Alt+drag moves a 3D point up / down. */
function beginPoint(el, sh, path, e) {
  const p0 = M.clone(M.getPath(el.rec, path)), is3d = p0.length > 2, z = is3d ? p0[2] : sh.z;
  const vertical = is3d && e.altKey;
  let plane;
  if (vertical) {                                           // a vertical plane through the point, facing the camera
    const v = new V3(); R.camera.getWorldDirection(v); v.z = 0;
    if (v.lengthSq() < 1e-6) v.set(1, 0, 0);
    plane = new THREE.Plane().setFromNormalAndCoplanarPoint(v.normalize(), new V3(p0[0], p0[1], z));
  } else plane = new THREE.Plane(new V3(0, 0, 1), -z);
  const grab = rayHit(e, plane);
  if (!grab) return null;
  const tx = beginEdit([el.id]);
  const off = [p0[0] - grab.x, p0[1] - grab.y, z - grab.z];
  const t0 = performance.now(), track = [], snaps = [];
  let last = 0, moved = false;
  return {
    update(ev) {
      const hit = rayHit(ev, plane);
      if (!hit) return;
      moved = true;
      let q;
      if (vertical) q = [p0[0], p0[1], mm(hit.z + off[2])];
      else {
        const other = sh.points.find((x) => x !== path), o = other && M.getPath(el.rec, other);
        const s = ev.ctrlKey || ev.metaKey ? { p: [hit.x + off[0], hit.y + off[1]], type: null }
          : snapPoint([hit.x + off[0], hit.y + off[1]], el.levels.length ? el.levels : [S.level], el.id, o, ev.shiftKey);
        q = [mm(s.p[0]), mm(s.p[1])];
        if (is3d) q.push(p0[2]);
        showGuide(s.type ? { ...s, at: [q[0], q[1], z] } : null);
        if (s.type && !snaps.some((x) => x.type === s.type && x.target === s.target)) snaps.push({ type: s.type, target: s.target || null });
      }
      M.setPath(el.rec, path, q);
      R.refreshElement(el);
      const now = performance.now();
      if (now - last >= 100) { last = now; track.push({ t: Math.round(now - t0), p: q }); }
    },
    end() {
      showGuide(null);
      if (!moved) { tx.cancel(); return; }
      tx.commit({ opName: `${el.kind}.move_point`, label: `${el.id}: ${path}`, via: 'shape_handle', input: 'shape_handle',
        constraint: { point: path, vertical }, snaps, path: track, duration_ms: Math.round(performance.now() - t0) });
    },
    cancel() { showGuide(null); tx.cancel(); },
  };
}

// ------------------------------------------------------------------ draw tool
export const DRAW_KINDS = {
  room: 'room (with its floor)', column: 'column', builtin: 'built-in', bulkhead: 'bulkhead / soffit', unscanned: 'unscanned area',
};
let DRAW = null;
const stamp = () => Date.now().toString(36).slice(-6);
const area = (p) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
const perimeter = (p) => p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + Math.hypot(b[0] - a[0], b[1] - a[1]); }, 0);
export const polygonArea = area;
export const polygonPerimeter = perimeter;

export function startDraw() { DRAW = { pts: [] }; drawHint(); }
export function stopDraw() { DRAW = null; R.disposeGroup(R.ghostGroup); }
export const drawing = () => !!DRAW;

function drawHint() {
  const h = $('#mode-hint');
  h.innerHTML = `Draw a <select id="draw-kind">${Object.entries(DRAW_KINDS).map(([k, v]) => `<option value="${k}" ${k === S.drawKind ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>:
    click its corners on the current level (snaps to walls and corners; Shift: 45°). <b>Enter</b> or a click on the first corner finishes,
    <b>Backspace</b> removes the last corner, <b>Esc</b> cancels.${DRAW && DRAW.pts.length ? ` · ${DRAW.pts.length} corners` : ''}`;
  h.style.display = 'block';
  $('#draw-kind').addEventListener('change', (e) => { S.drawKind = e.target.value; log('view', { what: 'draw_kind', value: S.drawKind }); });
}

function levelPoint(e) {
  const lv = levelById(S.level);
  const hit = rayHit(e, new THREE.Plane(new V3(0, 0, 1), -lv.elevation));
  return hit ? [hit.x, hit.y] : null;
}
function snapDraw(e) {
  const p = levelPoint(e); if (!p) return null;
  const pts = DRAW.pts;
  if (pts.length >= 3 && Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) < pxTol(p)) return { p: pts[0], type: 'close' };
  return snapCorner(p, null, [S.level], pts[pts.length - 1], e.shiftKey);
}

export function ghostDraw(e) {
  R.disposeGroup(R.ghostGroup);
  if (!DRAW || !S.level) return;
  const s = snapDraw(e); if (!s) return;
  const z = levelById(S.level).elevation + 0.03;
  const pts = [...DRAW.pts, s.p].map((p) => new V3(p[0], p[1], z));
  if (pts.length > 1) {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#00ff9c', depthTest: false }));
    line.renderOrder = 1000; line.userData.fixedScale = true; R.ghostGroup.add(line);
  }
  for (const p of pts) {
    const m = new THREE.Mesh(SPHERE, new THREE.MeshBasicMaterial({ color: s.type ? '#00ff9c' : '#ffffff', depthTest: false }));
    m.position.copy(p); m.renderOrder = 1000; m.userData.small = true; R.ghostGroup.add(m);
  }
  showGuide(s.type ? { ...s, at: [s.p[0], s.p[1], z] } : null);
}

export function clickDraw(e) {
  if (!S.level) { toast('Pick a level first: shapes are drawn on the current level.'); return; }
  const s = snapDraw(e); if (!s) return;
  if (s.type === 'close') { finishDraw('click_first'); return; }
  DRAW.pts.push([mm(s.p[0]), mm(s.p[1])]);
  log('draw_point', { n: DRAW.pts.length, snap: s.type, target: s.target || null });
  drawHint(); ghostDraw(e);
}
export function undoDrawPoint() { if (DRAW && DRAW.pts.length) { DRAW.pts.pop(); drawHint(); R.disposeGroup(R.ghostGroup); } }

/** Make the drawn element(s) and add them as one undoable command. */
export function finishDraw(via = 'enter') {
  if (!DRAW) return false;
  const pts = DRAW.pts;
  if (pts.length < 3 || area(pts) < 0.01) { toast('Draw at least 3 corners enclosing some area.'); return false; }
  const lv = levelById(S.level), z0 = lv.elevation, kind = S.drawKind;
  const tops = wallsOnLevel([S.level], null).map((w) => w.top_z).sort((a, b) => a - b);
  const ceil = tops.length ? tops[Math.floor(tops.length / 2)] : z0 + 2.5;
  const note = 'drawn in the annotation tool';
  const id = `${lv.id}-${{ room: 'R', column: 'C', builtin: 'K', bulkhead: 'B', unscanned: 'V' }[kind]}n${stamp()}`;
  const recs = [];
  if (kind === 'room') {
    recs.push({ kind: 'room', rec: { id, name: 'new room', type: null, level: lv.id, polygon: pts, holes: null, area: mm(area(pts)), perimeter: mm(perimeter(pts)),
      floor_z: z0, ceiling_main_z: null, bounding_walls: [], openings: [], outdoor: false, notes: note } });
    recs.push({ kind: 'floor', rec: { id: `FL-${id}`, room: id, level: lv.id, polygon: M.clone(pts), holes: null, finish: null, z: z0,
      modeled_as: 'horizontal', source: 'annotator' } });
  } else if (kind === 'column') recs.push({ kind, rec: { id, name: null, shape: 'polygon', level: lv.id, footprint: pts, base_z: z0, top_z: mm(ceil), confidence: 'high', notes: note } });
  else if (kind === 'builtin') recs.push({ kind, rec: { id, name: null, type: 'built-in', level: lv.id, room: null, polygon: pts, base_z: z0, top_z: mm(z0 + 0.9), notes: note } });
  else if (kind === 'bulkhead') recs.push({ kind, rec: { id, name: null, kind: 'bulkhead', level: lv.id, room: null, footprint: pts, bottom_z: mm(ceil - 0.3), top_z: mm(ceil), depth: 0.3, notes: note } });
  else recs.push({ kind: 'unscanned', rec: { id, name: 'unscanned area', level: lv.id, polygon: pts, area: mm(area(pts)) } });
  for (const r of recs) { const key = TYPES[r.kind].key; ctx.DOC[key] = ctx.DOC[key] || []; }
  const cmds = recs.map((r) => ({ op: 'add', kind: r.kind, rec: r.rec, index: ctx.DOC[TYPES[r.kind].key].length }));
  commit(cmds.length === 1 ? { ...cmds[0], opName: `${kind}.draw`, label: `draw ${kind} ${id}`, via: `draw:${via}` }
    : { op: 'batch', cmds, opName: `${kind}.draw`, label: `draw ${kind} ${id}`, via: `draw:${via}` });
  log('draw_done', { kind, id, corners: pts.length, area: mm(area(pts)) });
  DRAW = { pts: [] };
  R.disposeGroup(R.ghostGroup); showGuide(null);
  import('./tools.js').then((t) => t.setMode('select', 'auto'));
  select(id, 'created');
  return true;
}
