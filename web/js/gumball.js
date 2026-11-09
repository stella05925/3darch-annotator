// Gumball: three.js TransformControls as the visual gizmo, attached to an invisible proxy placed at the element's
// pivot and turned to its local frame (u along, n across, z up). Every gizmo change is converted into a transform
// session update (transform.js), so only parametric fields change and the meshes are rebuilt from them.
// Valid handles per type and mode come from the type's adapter (xf.axes); Esc / right-click cancels a drag.
// The gumball does Move and Rotate; Resize uses the face handles (boxhandles.js) and Points the corners (shapes.js).
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { TYPES } from './registry.js';
import { S, EL, $, $$, esc, log, toast } from './state.js';
import * as R from './render.js';
import { TransformSession, transformable } from './transform.js';
import { modalActive } from './modal.js';
import { setMode, buildHandles } from './tools.js';

let tc = null, proxy = null, session = null, p0 = null, rz0 = 0, q0 = null, lastEv = null, state = null;
const PIVOT_NAMES = { mid: 'middle', start: 'start', end: 'end', faceL: 'left face', faceR: 'right face', center: 'centre',
  j0: 'start jamb', j1: 'end jamb', sill: 'sill', head: 'head' };
const MODE_KEYS = { translate: 'W', rotate: 'E', scale: 'T', points: 'Tab' };

/** Selection with the primary element first. */
export function orderedSelection() {
  const ids = [...S.selected].filter((id) => EL.has(id));
  if (S.sel && EL.has(S.sel)) return [S.sel, ...ids.filter((id) => id !== S.sel)];
  return ids;
}

export function initGumball() {
  proxy = new THREE.Object3D();
  R.scene.add(proxy);
  tc = new TransformControls(R.camera, R.renderer.domElement);
  tc.setSize(0.9);
  tc.visible = false;
  R.scene.add(tc);
  tc.addEventListener('dragging-changed', (e) => { R.controls.enabled = !e.value; if (e.value) startDrag(); else endDrag(); });
  tc.addEventListener('objectChange', onChange);
  // pointer position and modifier keys as plain values (Alt over another wall re-hosts a moved opening)
  const keep = (e) => { lastEv = { clientX: e.clientX ?? (lastEv || {}).clientX, clientY: e.clientY ?? (lastEv || {}).clientY,
    altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey }; };
  addEventListener('pointermove', keep, { passive: true, capture: true });
  addEventListener('keyup', keep, true);
  addEventListener('keydown', (e) => {
    keep(e);
    if (e.key === 'Escape' && session) { e.stopImmediatePropagation(); e.preventDefault(); cancelDrag('esc'); }
  }, true);
  R.renderer.domElement.addEventListener('contextmenu', (e) => { if (session) { e.preventDefault(); cancelDrag('right_click'); } });
  // toolbar: Move / Rotate / Resize / Points, local or world axes, pivot
  $$('#tools [data-gmode]').forEach((b) => b.addEventListener('click', () => setGizmoMode(b.dataset.gmode, 'toolbar')));
  $('#gizmo-space').addEventListener('click', () => toggleSpace('toolbar'));
  $('#gizmo-pivot').addEventListener('change', (e) => setPivot(e.target.value, 'toolbar'));
}

/** Is the pointer over (or dragging) the gizmo? Clicks there must not select or orbit. */
export const gizmoHot = () => !!(tc && tc.visible && (tc.axis || tc.dragging));
export const gizmoBusy = () => !!session;
export const gizmoAxis = () => (tc && tc.visible ? tc.axis : null);

export function setGizmoMode(mode, via = 'key') {
  S.gizmo.mode = mode;
  log('view', { what: 'gizmo_mode', value: mode, via });
  if (S.mode !== 'select') setMode('select', via); else { buildHandles(); updateGumball(); }
  $$('#tools [data-gmode]').forEach((b) => b.classList.toggle('on', S.mode === 'select' && b.dataset.gmode === mode));
}
export function toggleSpace(via = 'key') {
  S.gizmo.space = S.gizmo.space === 'local' ? 'world' : 'local';
  log('view', { what: 'gizmo_space', value: S.gizmo.space, via });
  updateGumball();
}
export function setPivot(name, via = 'ui') {
  const prim = EL.get(S.sel);
  if (!prim) return;
  S.gizmo.pivot[prim.kind] = name;
  log('view', { what: 'gizmo_pivot', value: name, kind: prim.kind, via });
  updateGumball();
}

/** Place / hide the gizmo for the current selection, mode and space. */
export function updateGumball() {
  if (!tc) return;
  tc.camera = R.camera;
  if (session) return;
  const ids = orderedSelection();
  const on = S.mode === 'select' && ['translate', 'rotate'].includes(S.gizmo.mode) && S.annOn && ids.length > 0 && !modalActive();
  const { els, reason } = on ? transformable(ids, S.gizmo.mode) : { els: [], reason: null };
  if (!els.length || els.some((e) => !e.group.visible)) {
    tc.detach(); tc.visible = false; state = null;
    renderBar(ids, reason);
    return;
  }
  const prim = els[0], xf = TYPES[prim.kind].xf, f = xf.frame(prim.rec);
  const want = S.gizmo.pivot[prim.kind];
  const pivotName = els.length === 1 ? (want && f.pivots[want] ? want : Object.keys(f.pivots)[0]) : 'center';
  let pivot = f.pivots[pivotName];
  if (els.length > 1) {
    const cs = els.map((e) => TYPES[e.kind].xf.frame(e.rec).center);
    pivot = cs.reduce((s, c) => [s[0] + c[0] / cs.length, s[1] + c[1] / cs.length, s[2] + c[2] / cs.length], [0, 0, 0]);
  }
  const local = S.gizmo.mode === 'scale' || S.gizmo.space === 'local' || prim.kind === 'opening';
  proxy.position.set(...pivot);
  proxy.rotation.set(0, 0, local ? f.angle : 0);
  proxy.scale.set(1, 1, 1);
  proxy.updateMatrixWorld(true);
  tc.attach(proxy);
  tc.visible = true;
  tc.setMode(S.gizmo.mode);
  tc.setSpace(local ? 'local' : 'world');
  const key = S.gizmo.mode;
  let axes = (xf.axes[key] || []).slice();
  for (const e of els.slice(1)) axes = axes.filter((a) => (TYPES[e.kind].xf.axes[key] || []).includes(a));
  if (local) { tc.showX = axes.includes('u'); tc.showY = axes.includes('n'); tc.showZ = axes.includes('z'); }
  else { tc.showX = tc.showY = axes.includes('u') || axes.includes('n'); tc.showZ = axes.includes('z'); }
  state = { els, pivotName, local };
  renderBar(ids, null, prim, f, pivotName);
}

function renderBar(ids, reason, prim = null, f = null, pivotName = null) {
  const gm = S.gizmo.mode, sel = $('#gizmo-pivot');
  // options row: only for the gumball modes, with a selection
  $('#tool-opts').style.display = S.mode === 'select' && ids.length && (gm === 'translate' || gm === 'rotate') ? 'flex' : 'none';
  $('#gizmo-space').textContent = S.gizmo.space === 'local' ? 'Local axes' : 'World axes';
  $('#pivot-wrap').style.display = gm === 'rotate' ? '' : 'none';
  if (prim && f) {
    const names = ids.length > 1 ? ['center'] : Object.keys(f.pivots);
    sel.innerHTML = names.map((n) => `<option value="${n}" ${n === pivotName ? 'selected' : ''}>${esc(PIVOT_NAMES[n] || n)}</option>`).join('');
    sel.disabled = names.length < 2;
  } else { sel.innerHTML = ''; sel.disabled = true; }
  $('#gizmo-note').textContent = reason || '';
  modeNote(ids);
}

/** One line under the toolbar saying what the current edit mode does with this selection. */
function modeNote(ids) {
  const h = $('#mode-hint');
  if (S.mode !== 'select') return;
  const el = ids.length === 1 ? EL.get(ids[0]) : null, t = el && TYPES[el.kind];
  let txt = '';
  if (S.gizmo.mode === 'scale' && ids.length) {
    txt = !el ? 'Resize works on one element at a time.'
      : t.xf && t.xf.faces && (t.xf.axes.scale || []).length ? 'Drag a coloured handle to move that side; the opposite side stays. Snaps to nearby walls and edges (Ctrl: no snapping).'
        : `${el.kind}s have no sides to resize${t.shapes ? ': use Points (Tab) to edit its corners' : ''}.`;
  } else if (S.gizmo.mode === 'points' && ids.length) {
    const sh = el && t.shapes ? t.shapes(el) : [];
    txt = !el ? 'Points works on one element at a time.'
      : sh.some((x) => x.points) ? `Drag a white point to move that end${sh.some((x) => x.points) && el.rec.axis && el.rec.axis.start.length > 2 ? ' (Alt+drag: up / down)' : ''}; it snaps to wall ends and axes (Shift: 45°, Ctrl: no snapping).`
        : sh.length ? 'White dots are the corners: drag one to move it, Alt+click to delete it. Blue dots add a corner where you drag them. Shift: 45° steps.'
          : (t.noPoints ? t.noPoints(el) : `A ${el.kind} has no points to edit.`);
  }
  h.textContent = txt;
  h.style.display = txt ? 'block' : 'none';
}

function constraintOf(axis, local) {
  if (!axis) return null;
  const map = local ? { X: 'u', Y: 'n', Z: 'z' } : { X: 'x', Y: 'y', Z: 'z' };
  if (axis === 'XY') return 'plan';
  if (axis === 'XYZ' || axis === 'XYZE' || axis === 'E') return 'free';
  return axis.split('').map((c) => map[c] || '').join('');
}

function startDrag() {
  if (!state) return;
  session = new TransformSession({ els: state.els, mode: S.gizmo.mode, input: 'gumball', space: state.local ? 'local' : 'world', pivot: state.pivotName });
  p0 = proxy.position.clone();
  rz0 = proxy.rotation.z;
  q0 = proxy.quaternion.clone();
  log('transform_start', { input: 'gumball', mode: S.gizmo.mode, ids: state.els.map((e) => e.id), axis: tc.axis, pivot: state.pivotName, space: session.space });
}

function onChange() {
  if (!session || session.done) return;
  const c = constraintOf(tc.axis, state.local);
  if (S.gizmo.mode === 'translate') {
    const d = proxy.position.clone().sub(p0);
    const res = session.apply({ d: [d.x, d.y, d.z] }, c, { event: lastEv });
    proxy.position.set(p0.x + res.d[0], p0.y + res.d[1], p0.z + res.d[2]);
  } else if (S.gizmo.mode === 'rotate') {
    // the turn about the dragged ring's axis: X / Y = the element's u / n (or world x / y), Z (and the view rings) = vertical
    const ring = tc.axis, local = state.local;
    const name = ring === 'X' ? (local ? 'u' : 'x') : ring === 'Y' ? (local ? 'n' : 'y') : 'z';
    const dq = local ? q0.clone().invert().multiply(proxy.quaternion) : proxy.quaternion.clone().multiply(q0.clone().invert());
    let a = 2 * Math.atan2(ring === 'X' ? dq.x : ring === 'Y' ? dq.y : dq.z, dq.w);
    a = Math.atan2(Math.sin(a), Math.cos(a));
    const res = session.apply({ angle: a }, name, { event: lastEv });
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(ring === 'X' ? 1 : 0, ring === 'Y' ? 1 : 0, ring === 'X' || ring === 'Y' ? 0 : 1), res.angle);
    proxy.quaternion.copy(local ? q0.clone().multiply(turn) : turn.multiply(q0));
  } else {
    const axes = TYPES[state.els[0].kind].xf.axes.scale;
    const k = {};
    if (axes.includes('u')) k.u = proxy.scale.x;
    if (axes.includes('n')) k.n = proxy.scale.y;
    if (axes.includes('z')) k.z = proxy.scale.z;
    const res = session.apply({ k }, c, { event: lastEv });
    proxy.scale.set(res.k.u ?? 1, res.k.n ?? 1, res.k.z ?? 1);
  }
}

function endDrag() {
  const s = session;
  session = null;
  if (s && !s.done) s.confirm();
  updateGumball();
}

function cancelDrag(how) {
  const s = session;
  session = null;
  if (s) s.cancel(how);
  toast('Transform cancelled.', 1500);
  if (tc.dragging) tc.reset();
  updateGumball();
}

/** For tests: drive the gumball code path with an exact change (as TransformControls would). */
export function gumballDrive(change, axis = 'X', ev = null) {
  if (!state) return false;
  if (ev) lastEv = ev;
  tc.axis = axis;
  startDrag();
  if (change.d) proxy.position.set(p0.x + change.d[0], p0.y + change.d[1], p0.z + change.d[2]);
  if (change.angle !== undefined) {                       // a turn on the ring `axis` (X / Y / Z), as a user drag would make
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(axis === 'X' ? 1 : 0, axis === 'Y' ? 1 : 0, axis === 'X' || axis === 'Y' ? 0 : 1), change.angle);
    proxy.quaternion.copy(state.local ? q0.clone().multiply(turn) : turn.multiply(q0.clone()));
  }
  if (change.k) proxy.scale.set(change.k.u ?? 1, change.k.n ?? 1, change.k.z ?? 1);
  onChange();
  endDrag();
  tc.axis = null;
  return true;
}
export { MODE_KEYS };
