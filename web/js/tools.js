// Interactive tools: handles (face handles in Resize mode, corners in Points mode; each handle brings its own
// begin / update / end / cancel), add / draw / delete / copy / paste, the plane fit, arrow-key nudges, snap-to-scan,
// and the pointer input that drives them. Edits only ever change record fields; meshes are rebuilt from the records.
import * as THREE from 'three';
import * as M from './model.js';
import * as B from './build.js';
import { TYPES, readOnlyReason } from './registry.js';
import { S, ctx, EL, EXT, SCAN, $, $$, num, mm, log, toast, levelById, openingsOf, hostOf } from './state.js';
import { renderer, camera, controls, handleGroup, guideGroup, ghostGroup, HANDLE_GEOM, disposeGroup, vp, worldPerPixel } from './render.js';
import { gizmoHot, gizmoBusy, updateGumball, orderedSelection } from './gumball.js';
import { setRay, raycaster, pickAll, rayHit, clickSelect, select, hover, selectMany } from './selection.js';
import { snapPoint, wallsOnLevel } from './snap.js';
import { commit, setFields } from './commands.js';
import { boxHandles } from './boxhandles.js';
import { shapeHandles, startDraw, stopDraw, ghostDraw, clickDraw, finishDraw } from './shapes.js';
import { fitClick } from './fitplane.js';

const V3 = THREE.Vector3;

// ------------------------------------------------------------------ handles
/** Handles for the selection: face handles (Resize) or corners (Points), one element at a time. */
export function buildHandles() {
  disposeGroup(handleGroup);
  if (!S.sel || S.mode !== 'select' || S.selected.size > 1 || !S.annOn) return;
  const el = EL.get(S.sel);
  if (!el || !el.group.visible || readOnlyReason(el)) return;
  const list = S.gizmo.mode === 'scale' ? boxHandles(el) : S.gizmo.mode === 'points' ? shapeHandles(el) : [];
  for (const h of list) handleGroup.add(h.object);
  scaleHandles();
}
export function scaleHandles() {
  for (const m of [...handleGroup.children, ...guideGroup.children, ...ghostGroup.children]) {
    if (m.userData.fixedScale) { m.scale.setScalar(1); continue; }
    if (m.userData.dir) {                           // face handle: at least ~22 px from the element's centre
      const extra = Math.max(0, 22 * worldPerPixel(m.userData.base) - m.userData.half);
      m.position.copy(m.userData.base).addScaledVector(m.userData.dir, extra);
    }
    const k = camera.isOrthographicCamera ? ((camera.top - camera.bottom) / camera.zoom) * 0.007 : camera.position.distanceTo(m.position) * 0.011;
    m.scale.setScalar(k * (m.userData.size ?? (m.userData.small ? 0.7 : 1)));
  }
}
/** The handle under the pointer (its spec), if any. */
export function handleAt(e) {
  scaleHandles();                                   // size and place them now: hit tests must not wait for a frame
  handleGroup.updateMatrixWorld(true);
  setRay(e);
  const h = raycaster.intersectObjects(handleGroup.children.filter((o) => o.userData.spec), false)[0];
  return h ? h.object.userData.spec : null;
}

// ------------------------------------------------------------------ dragging a handle
let DRAG = null, downAt = null, gizmoDown = false, BOX = null;
export const handleBusy = () => !!DRAG;
function cancelHandleDrag(how) {
  const D = DRAG; DRAG = null;
  if (!D) return;
  controls.enabled = true;
  D.cancel(how);
  toast('Cancelled.', 1200);
  buildHandles();
}

// ------------------------------------------------------------------ add tools
let pasteTemplate = null;
let wallStart = null;
export const hasPasteTemplate = () => !!pasteTemplate;
export function setMode(mode, via = 'ui') {
  if (S.mode === 'add-shape' && mode !== 'add-shape') stopDraw();
  S.mode = mode;
  $$('#tools [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $$('#tools [data-gmode]').forEach((b) => b.classList.toggle('on', mode === 'select' && b.dataset.gmode === S.gizmo.mode));
  const hints = {
    'add-door': 'Click on a wall to place a door (Shift: keep the tool). Esc cancels.',
    'add-window': 'Click on a wall to place a window (Shift: keep the tool). Esc cancels.',
    'add-opening': 'Click on a wall to place an open passage (Shift: keep the tool). Esc cancels.',
    paste: 'Click on a wall to paste the copied opening (Shift: keep pasting). Esc cancels.',
    'add-wall': 'Click the wall start, then its end (snaps to wall ends; Shift for 45° steps). Esc cancels.',
    'fit-plane': `Click a flat part of the scan to fit a plane (Shift+click adds more surface), then apply it in the panel.
      Radius <input id="fit-radius" type="number" min="0.05" max="2" step="0.05" value="${S.fitRadius}"> m. Esc ends the tool.`,
  };
  const h = $('#mode-hint');
  h.innerHTML = hints[mode] || '';
  h.style.display = hints[mode] ? 'block' : 'none';
  if (mode === 'fit-plane') $('#fit-radius').addEventListener('change', (e) => { S.fitRadius = Math.max(0.05, Number(e.target.value) || 0.3); });
  if (mode === 'add-shape') startDraw();
  wallStart = null;
  disposeGroup(ghostGroup);
  buildHandles(); updateGumball();
  log('mode', { mode, via });
}

function templateFor(mode) {
  if (mode === 'paste' && pasteTemplate) return pasteTemplate;
  const type = { 'add-door': 'door', 'add-window': 'window', 'add-opening': 'opening' }[mode];
  return { type, ...M.OPENING_TEMPLATES[type] };
}
function openingAt(e) {
  const hit = pickAll(e, ['wall'])[0];
  if (!hit) return null;
  const w = hit.object.userData.el.rec;
  if (readOnlyReason(hit.object.userData.el)) return { blocked: readOnlyReason(hit.object.userData.el) };
  const tpl = templateFor(S.mode);
  if (w.shape === 'arc') {                                 // round wall: centred on the angle clicked
    const th = Math.atan2(hit.point.y - w.arc.center[1], hit.point.x - w.arc.center[0]) / M.DEG;
    return { w, o: M.newArcOpening(w, tpl.type, th, tpl) };
  }
  const [u] = M.uvOf(M.wallFrame(w), [hit.point.x, hit.point.y]);
  return { w, o: M.newOpening(w, tpl.type, u, tpl) };
}
function ghostOpening(e) {
  disposeGroup(ghostGroup);
  const r = openingAt(e);
  if (!r || r.blocked) return;
  const g = r.w.shape === 'arc' ? B.arcOpeningGeometry(r.o, r.w) : B.openingGeometry(r.o, r.w);
  ghostGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: '#00ff9c', depthTest: false })));
  ghostGroup.children[0].renderOrder = 1000;
}
function placeOpening(e) {
  const r = openingAt(e);
  if (!r) { toast('Click on a wall.'); return; }
  if (r.blocked) { toast(r.blocked); return; }
  commit({ op: 'add', opName: S.mode === 'paste' ? 'opening.paste' : 'opening.add', kind: 'opening', rec: r.o, index: ctx.DOC.openings.length,
    label: `add ${r.o.type} on ${r.w.id}`, via: `tool:${S.mode}` });
  const keep = e.shiftKey;
  if (!keep) setMode('select', 'auto');
  select(r.o.id, 'created');
}

export function levelPoint(e) {
  const lv = levelById(S.level);
  const hit = rayHit(e, new THREE.Plane(new V3(0, 0, 1), -lv.elevation));
  return hit ? [hit.x, hit.y] : null;
}
function ghostWall(e) {
  disposeGroup(ghostGroup);
  if (!S.level) return;
  const p = levelPoint(e); if (!p) return;
  const s = snapPoint(p, [S.level], null, wallStart, e.shiftKey);
  const z = levelById(S.level).elevation + 0.05;
  const marker = new THREE.Mesh(HANDLE_GEOM, new THREE.MeshBasicMaterial({ color: s.type ? '#00ff9c' : '#ffffff', depthTest: false }));
  marker.position.set(s.p[0], s.p[1], z); marker.renderOrder = 1000; ghostGroup.add(marker);
  if (wallStart) {
    const g = new THREE.BufferGeometry().setFromPoints([new V3(wallStart[0], wallStart[1], z), new V3(s.p[0], s.p[1], z)]);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: '#00ff9c', depthTest: false })); line.renderOrder = 1000; line.userData.fixedScale = true;
    ghostGroup.add(line);
  }
}
function clickAddWall(e) {
  if (!S.level) { toast('Pick a level first (walls are added on the current level).'); return; }
  const p = levelPoint(e); if (!p) return;
  const s = snapPoint(p, [S.level], null, wallStart, e.shiftKey);
  if (!wallStart) { wallStart = s.p; log('add_wall_start', { at: s.p, snap: s.type }); return; }
  if (Math.hypot(s.p[0] - wallStart[0], s.p[1] - wallStart[1]) < 0.1) { toast('Wall too short.'); return; }
  const lv = levelById(S.level);
  const heights = wallsOnLevel([S.level], null).map((w) => w.top_z - w.base_z).sort((a, b) => a - b);
  const hgt = heights.length ? heights[Math.floor(heights.length / 2)] : 2.6;
  const w = M.newWall(lv, wallStart, s.p, lv.elevation, lv.elevation + hgt);
  EXT.set(w.id, [0, 0]);
  commit({ op: 'add', opName: 'wall.add', kind: 'wall', rec: w, index: ctx.DOC.walls.length, label: `add wall ${w.id}`, via: 'tool:add-wall',
    snap: s.type ? { type: s.type, target: s.target } : null });
  if (e.shiftKey) wallStart = s.p; else { setMode('select', 'auto'); select(w.id, 'created'); }
}

// ------------------------------------------------------------------ element actions
export function deleteSelected(via = 'key') {
  const els = orderedSelection().map((id) => EL.get(id)).filter(Boolean);
  if (!els.length) return;
  const blocked = els.filter((el) => readOnlyReason(el) || !TYPES[el.kind].deletable);
  if (blocked.length) {
    const r = readOnlyReason(blocked[0]);
    toast(r || `${blocked.map((e) => e.id).join(', ')} cannot be deleted here; mark ${blocked.length > 1 ? 'them' : 'it'} as wrong instead.`);
    return;
  }
  const cmds = deleteCommands(els);
  const prim = els[0], kinds = new Set(els.map((e) => e.kind));
  const opName = kinds.size === 1 ? `${prim.kind}.delete` : 'multi.delete';
  const label = els.length === 1 ? `delete ${prim.id}` : `delete ${els.length} elements`;
  const extra = cmds.length > els.length ? ` (+${cmds.length - els.length} openings)` : '';
  commit(cmds.length === 1 ? { ...cmds[0], opName, label, via } : { op: 'batch', opName, cmds, label: label + extra, via });
}

/** Delete commands for elements and their dependents, in an order that undoes exactly. */
export function deleteCommands(els) {
  // dependents (a wall's openings) go first, so on undo (a batch undoes in reverse) they come back after their host;
  // each index is taken in the order the deletes run, so undo puts every record back exactly where it was
  const order = [], seen = new Set();
  const add = (kind, rec) => { if (!seen.has(rec.id)) { seen.add(rec.id); order.push({ kind, id: rec.id, rec }); } };
  for (const el of els) {
    const t = TYPES[el.kind];
    for (const d of (t.dependents ? t.dependents(el) : [])) add(d.kind, d.rec);
    add(el.kind, el.rec);
  }
  const lists = new Map();
  const cmds = order.map((el) => {
    const key = TYPES[el.kind].key;
    if (!lists.has(key)) lists.set(key, ctx.DOC[key].map((r) => r.id));
    const ids = lists.get(key), index = ids.indexOf(el.id);
    ids.splice(index, 1);
    return { op: 'delete', kind: el.kind, rec: M.clone(el.rec), index };
  });
  return cmds;
}

export function copySelected() {
  const el = S.sel && EL.get(S.sel);
  if (!el || el.kind !== 'opening') { toast('Select an opening to copy.'); return; }
  const o = el.rec, w = hostOf(el);
  pasteTemplate = { type: o.type, width: o.position.width, sill: o.sill_z - w.base_z, head: o.head_z - w.base_z,
    door: o.door ? M.clone(o.door) : undefined, window: o.window ? M.clone(o.window) : undefined, from: o.id };
  toast(`Copied ${o.type} ${o.id} (${num(o.position.width, 2)} × ${num(o.head_z - o.sill_z, 2)} m). Ctrl+V, then click on a wall.`);
  log('copy', { id: o.id });
}

export function nudge(dx, dy, step, via = 'nudge') {
  const el = S.sel && EL.get(S.sel);
  if (!el || !TYPES[el.kind].nudge) return;
  if (readOnlyReason(el)) { toast(readOnlyReason(el)); return; }
  const { after, op } = TYPES[el.kind].nudge(el, dx, dy, step);
  setFields(el, after, `${el.id}: nudge`, via, { step, opName: op });
}

/** Experimental: move a wall's faces onto the scan surfaces seen from either side (rays cast at the wall). */
export function snapWallToScan(el) {
  if (readOnlyReason(el)) { toast(readOnlyReason(el)); return; }
  const w = el.rec, f = M.wallFrame(w), h = w.thickness / 2;
  const t0 = performance.now();
  const reach = h + 0.6;
  const box = new THREE.Box3();
  for (const p of w.footprint) box.expandByPoint(new V3(p[0], p[1], w.base_z)).expandByPoint(new V3(p[0], p[1], w.top_z));
  box.expandByScalar(0.8);
  const cands = SCAN.filter((s) => s.box.intersectsBox(box)).map((s) => s.mesh);
  const ops = openingsOf(w.id);
  const sides = { 1: [], [-1]: [] };
  const rc = new THREE.Raycaster(); rc.far = reach + 0.6;
  let rays = 0;
  for (let i = 0; i < 12; i++) {
    const u = f.L * (0.08 + (0.84 * i) / 11);
    for (const dz of [0.35, 0.8, 1.25, 1.7, 2.15]) {
      const z = w.base_z + dz;
      if (z > M.topAt(w, u) - 0.12) continue;
      if (ops.some((o) => u > o.position.u_start - 0.05 && u < o.position.u_end + 0.05 && z > o.sill_z - 0.05 && z < o.head_z + 0.05)) continue;
      for (const side of [1, -1]) {
        const o = M.at(f, u, side * reach);
        rc.set(new V3(o[0], o[1], z), new V3(-side * f.n[0], -side * f.n[1], 0));
        rays++;
        const hit = rc.intersectObjects(cands, false)[0];
        if (!hit) continue;
        const v = side * (reach - hit.distance);           // signed face position along n
        if (Math.abs(v - side * h) < 0.35) sides[side].push(v);
      }
    }
  }
  // Surface clusters (3 cm windows) of the ray hits: take the strongest, unless a nearly as strong one (>= 60 %) lies
  // deeper (furniture, curtains and trim stand in front of walls). Same rule as the sandbox's v2 face fits.
  const deepest = (vals, side) => {
    const d = vals.map((v) => side * v).sort((x, y) => x - y);          // ascending = deepest first
    const clusters = [];
    for (let i = 0; i < d.length; i++) {
      let j = i; while (j + 1 < d.length && d[j + 1] - d[i] <= 0.03) j++;
      clusters.push({ n: j - i + 1, v: d[Math.floor((i + j) / 2)] });
    }
    const best = Math.max(0, ...clusters.map((c) => c.n));
    if (best < 5) return null;
    if (S.snapRule === 'median') return side * d[Math.floor(d.length / 2)];
    const pick = S.snapRule === 'strongest' ? clusters.find((c) => c.n === best)
      : clusters.find((c) => c.n >= 0.6 * best);                         // the deepest of the strong clusters
    return side * pick.v;
  };
  const nL = sides[1].length, nR = sides[-1].length;
  const fL = deepest(sides[1], 1), fR = deepest(sides[-1], -1);
  let vL = h, vR = -h, how;
  if (fL !== null && fR !== null) { vL = fL; vR = fR; how = 'both faces'; }
  else if (fL !== null) { vL = fL; vR = vL - w.thickness; how = 'left face only, thickness kept'; }
  else if (fR !== null) { vR = fR; vL = vR + w.thickness; how = 'right face only, thickness kept'; }
  const stats = { rays, hits_left: nL, hits_right: nR, ms: Math.round(performance.now() - t0), meshes: cands.length };
  if (!how || vL - vR < 0.02 || vL - vR > 0.9) {
    toast(`Snap to scan: not enough clear scan surface near ${w.id} (${nL} / ${nR} hits on the two sides).`);
    log('snap_scan', { id: w.id, ok: false, ...stats });
    return;
  }
  const c = (vL + vR) / 2;
  const moved = setFields(el, {
    'axis.start': M.at(f, 0, c).map(mm), 'axis.end': M.at(f, f.L, c).map(mm), thickness: mm(vL - vR),
  }, `${w.id}: snap to scan`, 'snap_scan', { opName: 'wall.snap_to_scan', snap: { type: 'scan', how, ...stats } });
  log('snap_scan', { id: w.id, ok: true, how, shift: mm(c), thickness_before: w.thickness, thickness_after: mm(vL - vR), changed: moved, ...stats });
  const big = Math.abs(c) > 0.1 || Math.abs(vL - vR - 2 * h) > 0.1;
  toast(moved ? `Snapped ${w.id} to the scan (${how}): moved ${(c * 100).toFixed(1)} cm, thickness ${num(h * 2, 3)} → ${num(vL - vR, 3)} m.${big ? ' <b>Large change: please check it (Ctrl+Z to undo).</b>' : ''}`
    : `${w.id} already matches the scan.`, big ? 7000 : 3500);
}

// ------------------------------------------------------------------ box select (plan view)
function endBox(e) {
  const B = BOX; BOX = null;
  $('#box-select').style.display = 'none';
  controls.enabled = true;
  if (Math.hypot(e.clientX - B.x0, e.clientY - B.y0) < 5) { clickSelect(e); return; }   // a Shift+click
  const r = renderer.domElement.getBoundingClientRect();
  const x0 = Math.min(B.x0, e.clientX), x1 = Math.max(B.x0, e.clientX), y0 = Math.min(B.y0, e.clientY), y1 = Math.max(B.y0, e.clientY);
  const ids = [];
  for (const el of EL.values()) {
    if (!el.group.visible || !el.meshes.length || !TYPES[el.kind].xf) continue;
    const box = new THREE.Box3();
    for (const m of el.meshes) box.expandByObject(m);
    const c = box.getCenter(new V3()).project(camera);
    const sx = r.left + ((c.x + 1) / 2) * r.width, sy = r.top + ((1 - c.y) / 2) * r.height;
    if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) ids.push(el.id);
  }
  selectMany(ids, 'box', true);
}

// ------------------------------------------------------------------ pointer input
export function initTools() {
  // capture phase: a handle grab must win over the orbit controls' own pointerdown on the same canvas
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    downAt = { x: e.clientX, y: e.clientY };
    // the gumball handles this press: no click selection, no orbit
    if (gizmoHot()) { gizmoDown = true; downAt = null; controls.enabled = false; return; }
    if (S.mode === 'select') {
      const spec = handleAt(e);
      if (spec) {
        e.preventDefault(); e.stopImmediatePropagation();
        downAt = null;
        DRAG = spec.begin(e);                                  // null: the press did its job already (Alt+click)
        if (DRAG) { controls.enabled = false; renderer.domElement.setPointerCapture(e.pointerId); log('handle_start', { handle: spec.name, id: S.sel }); }
        return;
      }
    }
    // Shift+drag in plan or wall view: box select (instead of panning)
    if ((S.plan || S.view === 'wall') && e.shiftKey && S.mode === 'select') {
      BOX = { x0: e.clientX, y0: e.clientY };
      controls.enabled = false;
      renderer.domElement.setPointerCapture(e.pointerId);
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, { capture: true });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (DRAG) { DRAG.update(e); return; }
    if (BOX) {
      const r = vp.getBoundingClientRect(), b = $('#box-select');
      Object.assign(b.style, { display: 'block', left: `${Math.min(BOX.x0, e.clientX) - r.left}px`, top: `${Math.min(BOX.y0, e.clientY) - r.top}px`,
        width: `${Math.abs(e.clientX - BOX.x0)}px`, height: `${Math.abs(e.clientY - BOX.y0)}px` });
      return;
    }
    if (['add-door', 'add-window', 'add-opening', 'paste'].includes(S.mode)) { ghostOpening(e); return; }
    if (S.mode === 'add-wall') { ghostWall(e); return; }
    if (S.mode === 'add-shape') { if (!e.buttons) ghostDraw(e); return; }
    hover(e);
  });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (DRAG) { const D = DRAG; DRAG = null; controls.enabled = true; D.end(); buildHandles(); return; }
    if (BOX) { endBox(e); return; }
    if (gizmoDown) { gizmoDown = false; if (!gizmoBusy()) controls.enabled = true; return; }
    if (!downAt || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 5) return;
    if (S.mode === 'select') clickSelect(e);
    else if (S.mode === 'add-wall') clickAddWall(e);
    else if (S.mode === 'add-shape') clickDraw(e);
    else if (S.mode === 'fit-plane') fitClick(e);
    else placeOpening(e);
  });
  renderer.domElement.addEventListener('dblclick', () => { if (S.mode === 'add-shape') finishDraw('double_click'); });
  renderer.domElement.addEventListener('contextmenu', (e) => { if (DRAG) { e.preventDefault(); cancelHandleDrag('right_click'); } });
  addEventListener('keydown', (e) => { if (DRAG && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancelHandleDrag('esc'); } }, true);
  renderer.domElement.addEventListener('pointerleave', () => { $('#tooltip').style.display = 'none'; });
}
