// Picking and selection: which element is under the pointer, click cycling through stacked elements, the selection
// and its related elements (from the registry), hover tooltips.
import * as THREE from 'three';
import { TYPES } from './registry.js';
import { S, EL, $, esc, log, statusOf } from './state.js';
import { renderer, camera, clipOk, restyleAll, vp, handleGroup } from './render.js';
import { buildHandles } from './tools.js';
import { renderProps, markListSelection } from './panel.js';
import { updateGumball, gizmoHot } from './gumball.js';

const V3 = THREE.Vector3;
export const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

export function setRay(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
}
/** Visible elements under the pointer, nearest first, one hit per element (optionally only some kinds). */
export function pickAll(e, kinds = null) {
  setRay(e);
  const meshes = [];
  for (const el of EL.values()) {
    if (!el.group.visible || (kinds && !kinds.includes(el.kind))) continue;
    for (const m of el.meshes) meshes.push(m);
  }
  const hits = raycaster.intersectObjects(meshes, false).filter((h) => clipOk(h.point));
  const seen = new Set(), out = [];
  for (const h of hits) { const id = h.object.userData.el.id; if (!seen.has(id)) { seen.add(id); out.push(h); } }
  return out;
}
export function rayHit(e, plane) { setRay(e); return raycaster.ray.intersectPlane(plane, new V3()); }

export function computeRelated() {
  S.related = new Set();
  const el = S.sel && EL.get(S.sel);
  if (!el) return;
  const t = TYPES[el.kind];
  if (t.related) for (const id of t.related(el)) S.related.add(id);
}

function selectionChanged() {
  computeRelated();
  restyleAll();
  buildHandles();
  renderProps();
  markListSelection();
  updateGumball();
}

/** Select one element (or none); the multi-selection becomes just that element. */
export function select(id, via = 'click', extra = {}) {
  const prev = S.sel, prevN = S.selected.size;
  S.trashSel = null;
  S.sel = id && EL.has(id) ? id : null;
  S.selected = new Set(S.sel ? [S.sel] : []);
  selectionChanged();
  if (S.sel !== prev || via === 'click' || prevN > 1) log(S.sel ? 'select' : 'deselect', { id: S.sel, kind: S.sel ? EL.get(S.sel).kind : null, via, ...extra });
}

/** Shift-click: add the element to the selection (it becomes the primary) or take it out. */
export function toggleSelect(id, via = 'shift_click') {
  if (!id || !EL.has(id)) return;
  S.trashSel = null;
  if (S.selected.has(id)) {
    S.selected.delete(id);
    if (S.sel === id) S.sel = [...S.selected].pop() || null;
  } else { S.selected.add(id); S.sel = id; }
  selectionChanged();
  log('select', { id, kind: EL.get(id).kind, via, action: S.selected.has(id) ? 'add' : 'remove', n: S.selected.size });
}

/** Select several elements at once (box select); `add` keeps the current selection. */
export function selectMany(ids, via = 'box', add = false) {
  const keep = add ? [...S.selected] : [];
  S.trashSel = null;
  S.selected = new Set([...keep, ...ids.filter((id) => EL.has(id))]);
  S.sel = ids.length ? ids[ids.length - 1] : (keep.length ? keep[keep.length - 1] : null);
  selectionChanged();
  log('select', { via, ids, n: S.selected.size, add });
}

/** A deleted element picked in the element list: nothing is selected in the view; the panel shows it with Restore. */
export function showDeleted(id) {
  select(null, 'list');
  S.trashSel = id;
  renderProps(); markListSelection();
  log('select', { id, via: 'list', deleted: true });
}

let lastClick = { x: -99, y: -99, ids: [], i: 0 };
export function clickSelect(e) {
  const hits = pickAll(e);
  if (!hits.length) { select(null, 'click_empty'); return; }
  // an opening sits inside its host wall (from above it is always under the wall's top): list it before that wall
  for (let j = 1; j < hits.length; j++) {
    const el = hits[j].object.userData.el;
    if (el.kind !== 'opening') continue;
    const w = hits.findIndex((h) => h.object.userData.el.id === el.rec.host_wall);
    if (w >= 0 && w < j) hits.splice(w, 0, hits.splice(j, 1)[0]);
  }
  const ids = hits.map((h) => h.object.userData.el.id);
  let i = 0;
  if (Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 5 && ids.join() === lastClick.ids.join()) i = (lastClick.i + 1) % ids.length;
  lastClick = { x: e.clientX, y: e.clientY, ids, i };
  const h = hits[i];
  S.selPatch = h.object.userData.patch ?? null;            // which ceiling patch was clicked (plane fit)
  if (e.shiftKey) { toggleSelect(ids[i]); return; }
  select(ids[i], 'click', { cycle: i, stack: ids.length, patch: h.object.userData.patch ?? undefined });
}

let hoverT = 0;
export function hover(e) {
  const now = performance.now();
  if (now - hoverT < 60 || e.buttons) return;
  hoverT = now;
  const tip = $('#tooltip');
  setRay(e);
  if (gizmoHot() || raycaster.intersectObjects(handleGroup.children, false).length) { renderer.domElement.style.cursor = 'grab'; tip.style.display = 'none'; return; }
  renderer.domElement.style.cursor = '';
  const h = pickAll(e)[0];
  S.hoverId = h ? h.object.userData.el.id : null;
  if (!h) { tip.style.display = 'none'; return; }
  const el = h.object.userData.el, t = TYPES[el.kind];
  const what = t.tooltip ? t.tooltip(el) : el.kind;
  const rect = vp.getBoundingClientRect();
  tip.innerHTML = `${esc(el.id)} · ${esc(what)}${statusOf(el.id) !== 'none' ? ` · ${statusOf(el.id)}` : ''}`;
  tip.style.left = `${e.clientX - rect.left + 14}px`; tip.style.top = `${e.clientY - rect.top + 10}px`; tip.style.display = 'block';
}
