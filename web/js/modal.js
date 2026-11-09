// Keyboard transforms (Blender style): G = move, R = rotate, S = scale on the selection. X / Y / Z (world) or
// U / N (along / across the wall) constrain; the mouse adjusts; typing a number sets an exact value (relative;
// "=0.9" absolute: a height, a distance from the wall start, an angle, a length...), arithmetic allowed; Enter or
// left click confirms, Esc or right click cancels. A small overlay near the cursor shows the live value.
import * as THREE from 'three';
import * as M from './model.js';
import { TYPES } from './registry.js';
import { S, ctx, EL, $, esc, mm, toast, evalExpr } from './state.js';
import * as R from './render.js';
import { rayHit } from './selection.js';
import { TransformSession, transformable } from './transform.js';
import { orderedSelection, updateGumball } from './gumball.js';
import { commit, removeRecord } from './commands.js';
import { logCancelled } from './logging.js';
import { showGuide } from './snap.js';

let MOD = null;
const V3 = THREE.Vector3;
const DEG = 180 / Math.PI;
const NAMES = { translate: 'Move', rotate: 'Rotate', scale: 'Scale' };
const AXIS_NAMES = { u: 'U along', n: 'N across', x: 'X', y: 'Y', z: 'Z', plan: 'free in plan', uz: 'free on the wall', free: 'free' };

export const modalActive = () => !!MOD;

function screenOf(p) {
  const v = new V3(...p).project(R.camera), r = R.renderer.domElement.getBoundingClientRect();
  return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
}

/** Valid constraints of the primary element's type for this mode. */
function validConstraints(kind, mode) {
  const ax = (TYPES[kind].xf.axes[mode] || []).slice();
  const out = new Set(ax);
  if (mode === 'translate' && ax.includes('u') && ax.includes('n')) { out.add('x'); out.add('y'); }
  if (mode === 'rotate' && (ax.includes('u') || ax.includes('n'))) { out.add('x'); out.add('y'); }   // tilt about a horizontal axis
  if (mode === 'scale') { if (ax.includes('u')) out.add('x'); if (ax.includes('n')) out.add('y'); }
  return out;
}

/**
 * Start a keyboard transform of the selection. opts: {input, opPrefix, dup: [new ids] (duplicate + move: the copies
 * are removed again on cancel and recorded as additions on confirm), onDone}.
 */
export function startModal(mode, opts = {}) {
  if (MOD) return false;
  const ids = opts.ids || orderedSelection();
  const { els, reason } = transformable(ids, mode);
  if (!els.length) { toast(reason || 'Select something to transform first.'); return false; }
  const prim = els[0];
  const session = new TransformSession({ els, mode, input: opts.input || 'keyboard', space: S.gizmo.space, pivot: S.gizmo.pivot[prim.kind], opPrefix: opts.opPrefix });
  const start = S.pointer ? [S.pointer.x, S.pointer.y] : screenOf(session.pivot);
  MOD = { session, mode, kind: prim.kind, constraint: null, typed: '', start, startEv: S.pointer ? { clientX: S.pointer.x, clientY: S.pointer.y } : null,
    valid: validConstraints(prim.kind, mode), opts, params: null };
  R.controls.enabled = false;
  updateGumball();                                         // hidden while a keyboard transform runs
  $('#xf-overlay').style.display = 'block';
  update();
  return true;
}

function defaultAxis() {
  if (MOD.mode === 'scale') return { wall: 'u', screen: 'u', opening: 'u', beam: 'n' }[MOD.kind] || null;
  return null;
}

/** Plane for free moves: the floor plane through the pivot, or the host wall's plane for an opening. */
function freePlane() {
  const p = new V3(...MOD.session.pivot);
  if (MOD.kind === 'opening') { const n = MOD.session.axis('n'); return new THREE.Plane().setFromNormalAndCoplanarPoint(new V3(n[0], n[1], 0), p); }
  return new THREE.Plane(new V3(0, 0, 1), -p.z);
}

function paramsFromMouse(ev) {
  const s = MOD.session, c = MOD.constraint;
  const cur = ev ? [ev.clientX, ev.clientY] : MOD.start;
  if (MOD.mode === 'translate') {
    if (c) {
      const A = s.axis(c), P0 = screenOf(s.pivot), P1 = screenOf([s.pivot[0] + A[0], s.pivot[1] + A[1], s.pivot[2] + A[2]]);
      const sa = [P1[0] - P0[0], P1[1] - P0[1]], m = [cur[0] - MOD.start[0], cur[1] - MOD.start[1]];
      const t = (m[0] * sa[0] + m[1] * sa[1]) / Math.max(sa[0] * sa[0] + sa[1] * sa[1], 1e-6);
      return { d: [A[0] * t, A[1] * t, A[2] * t] };
    }
    const pl = freePlane();
    const h0 = MOD.startEv ? rayHit(MOD.startEv, pl) : null, h1 = ev ? rayHit(ev, pl) : null;
    if (!h0 || !h1) return { d: [0, 0, 0] };
    return { d: [h1.x - h0.x, h1.y - h0.y, MOD.kind === 'opening' ? h1.z - h0.z : 0] };
  }
  if (MOD.mode === 'rotate') {
    // the angle swept about the rotation axis (vertical, or the chosen horizontal one) between the start and the pointer
    const K = new V3(...s.axis(MOD.constraint || 'z')), P = new V3(...s.pivot);
    const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(K, P);
    const h0 = MOD.startEv ? rayHit(MOD.startEv, pl) : null, h1 = ev ? rayHit(ev, pl) : null;
    if (!h0 || !h1) return { angle: 0 };
    const v0 = h0.sub(P), v1 = h1.sub(P);
    return { angle: Math.atan2(K.dot(new V3().crossVectors(v0, v1)), v0.dot(v1)) };
  }
  const P = screenOf(s.pivot);
  const f = Math.hypot(cur[0] - P[0], cur[1] - P[1]) / Math.max(Math.hypot(MOD.start[0] - P[0], MOD.start[1] - P[1]), 1);
  return { k: scaleK(f) };
}

function scaleAxis() {
  const c = MOD.constraint || defaultAxis();
  return c === 'x' ? 'u' : c === 'y' ? 'n' : c;
}
function scaleK(f) {
  const a = scaleAxis();
  if (a) return { [a]: f };
  const ax = TYPES[MOD.kind].xf.axes.scale;
  return Object.fromEntries(ax.filter((x) => x !== 'z').map((x) => [x, f]));
}

/** Current size along a scale axis (for "=value" absolute scaling). */
function sizeOf(rec, kind, a) {
  if (kind === 'opening') return a === 'z' ? rec.head_z - rec.sill_z : rec.position.u_end - rec.position.u_start;
  if (kind === 'beam') return a === 'z' ? rec.depth : rec.width;
  if (a === 'u' && rec.axis) return M.wallFrame(rec).L;
  if (a === 'n' && rec.thickness !== undefined) return rec.thickness;
  if (a === 'z') return (rec.top_z ?? 0) - (rec.base_z ?? rec.bottom_z ?? 0);
  return null;
}

function paramsFromTyped() {
  const s = MOD.session, abs = MOD.typed.startsWith('='), expr = abs ? MOD.typed.slice(1) : MOD.typed;
  const v = evalExpr(expr, 0);
  if (v === null) return null;
  const r0 = s.rec0(s.primary.id);
  if (MOD.mode === 'translate') {
    const c = MOD.constraint || (MOD.kind === 'opening' ? 'u' : 'u');
    const A = s.axis(c);
    let dist = v;
    if (abs) {
      if (c === 'z') dist = v - (MOD.kind === 'opening' ? r0.sill_z : r0.base_z ?? r0.bottom_z ?? s.pivot[2]);
      else if (MOD.kind === 'opening' && c === 'u') dist = v - r0.position.u_start;
      else dist = v - (s.pivot[0] * A[0] + s.pivot[1] * A[1] + s.pivot[2] * A[2]);
    }
    return { d: [A[0] * dist, A[1] * dist, A[2] * dist], axisUsed: c };
  }
  if (MOD.mode === 'rotate') {
    let a = v / DEG;
    if (abs && (!MOD.constraint || MOD.constraint === 'z')) { a = v / DEG - s.angle; a = Math.atan2(Math.sin(a), Math.cos(a)); }
    return { angle: a };
  }
  const ax = scaleAxis();
  if (abs) {
    const a = ax || TYPES[MOD.kind].xf.axes.scale[0], size = sizeOf(r0, MOD.kind, a);
    if (!size) return null;
    return { k: { [a]: v / size } };
  }
  return { k: scaleK(v) };
}

function overlayText(p, snapType) {
  const c = MOD.constraint || (MOD.typed && MOD.mode === 'translate' ? 'u' : null) || (MOD.mode === 'scale' ? defaultAxis() : null) || (MOD.mode === 'rotate' ? 'z' : null);
  let val = '';
  if (MOD.mode === 'translate') {
    const A = c && c !== 'plan' ? MOD.session.axis(c) : null;
    val = A ? `${mm(p.d[0] * A[0] + p.d[1] * A[1] + p.d[2] * A[2]).toFixed(3)} m` : `Δ ${p.d.map((x) => mm(x).toFixed(3)).join(', ')} m`;
  } else if (MOD.mode === 'rotate') val = `${(p.angle * DEG).toFixed(2)}°`;
  else val = Object.entries(p.k).map(([a, k]) => `${a} × ${k.toFixed(3)}`).join(' · ');
  return `<b>${NAMES[MOD.mode]}</b> · ${esc(AXIS_NAMES[c] || (MOD.kind === 'opening' && MOD.mode === 'translate' ? 'free on the wall' : 'free'))} · ${esc(val)}`
    + (MOD.typed ? ` · typed <code>${esc(MOD.typed)}</code>` : '') + (snapType ? ` · snap ${esc(snapType)}` : '')
    + `<div class="muted">${[...MOD.valid].map((x) => x.toUpperCase()).join(' / ')} constrain · type a value (=abs) · Enter ok · Esc cancel</div>`;
}

function update(ev = null) {
  if (!MOD) return;
  const src = ev || (S.pointer ? { clientX: S.pointer.x, clientY: S.pointer.y } : null);
  const e = src && { clientX: src.clientX, clientY: src.clientY, altKey: !!src.altKey, ctrlKey: !!src.ctrlKey, metaKey: !!src.metaKey };
  let p = MOD.typed ? paramsFromTyped() : paramsFromMouse(e);
  if (!p) p = MOD.mode === 'translate' ? { d: [0, 0, 0] } : MOD.mode === 'rotate' ? { angle: 0 } : { k: {} };
  const cons = MOD.constraint || (MOD.mode === 'translate' ? (MOD.kind === 'opening' ? 'uz' : 'plan') : MOD.mode === 'rotate' ? 'z' : scaleAxis());
  const res = MOD.session.apply(p, cons, { event: e, noSnap: !!MOD.typed });
  MOD.params = res;
  const lastSample = MOD.session.path[MOD.session.path.length - 1];
  const ov = $('#xf-overlay'), r = R.vp.getBoundingClientRect();
  ov.innerHTML = overlayText(res, MOD.session.rehost ? `re-host → ${MOD.session.rehost}` : lastSample && lastSample.snap);
  const at = S.pointer ? [S.pointer.x - r.left, S.pointer.y - r.top] : [r.width / 2, r.height / 2];
  ov.style.left = `${at[0] + 18}px`; ov.style.top = `${at[1] - 10}px`;
}

function finish() {
  $('#xf-overlay').style.display = 'none';
  showGuide(null);
  MOD = null;
  R.controls.enabled = true;
  updateGumball();
}

export function confirmModal() {
  if (!MOD) return;
  const m = MOD, s = m.session;
  update();
  const extra = { input: m.typed ? 'numeric' : (m.opts.input || 'keyboard'), typed: m.typed || undefined };
  if (m.opts.dup) {
    // duplicate + move: record the copies as additions in their final place (one undoable command)
    const meta = s.meta(extra);
    s.done = true; s.tx.done = true;
    const cmds = m.opts.dup.map((id) => {
      const el = EL.get(id), list = ctx.DOC[TYPES[el.kind].key];
      return { op: 'add', kind: el.kind, rec: M.clone(el.rec), index: list.indexOf(el.rec) };
    });
    commit({ op: 'batch', cmds, ...meta, opName: `${s.primary.kind}.duplicate` }, { applied: true });
    S.lastTransform = { mode: s.mode, params: M.clone(s.result), constraint: s.constraint, space: s.space, pivot: s.pivotName };
  } else s.confirm(extra);
  finish();
  if (m.opts.onDone) m.opts.onDone(true);
}

export function cancelModal(how = 'esc') {
  if (!MOD) return;
  const m = MOD;
  if (m.opts.dup) {
    m.session.done = true; m.session.tx.done = true;
    for (const id of m.opts.dup) { const el = EL.get(id); if (el) removeRecord(el.kind, id); }
    logCancelled({ op: `${m.kind}.duplicate`, ids: m.opts.dup, input: 'keyboard', how, path: m.session.path });
  } else m.session.cancel(how, { input: m.typed ? 'numeric' : (m.opts.input || 'keyboard'), typed: m.typed || undefined });
  finish();
  toast('Transform cancelled.', 1500);
  if (m.opts.onDone) m.opts.onDone(false);
}

/** Keys while a keyboard transform runs (capture phase: they never reach the other shortcuts). */
function onKey(e) {
  if (!MOD) return;
  const k = e.key;
  let used = true;
  if (k === 'Escape') cancelModal('esc');
  else if (k === 'Enter') confirmModal();
  else if (/^[xyzunXYZUN]$/.test(k)) {
    const c = k.toLowerCase();
    if (!MOD.valid.has(c)) toast(`${c.toUpperCase()} does not apply to ${MOD.kind}s here.`, 1500);
    else { MOD.constraint = MOD.constraint === c ? null : c; update(); }
  } else if (/^[0-9.+\-*/()=]$/.test(k)) { MOD.typed += k; update(); }
  else if (k === 'Backspace') { MOD.typed = MOD.typed.slice(0, -1); update(); }
  else if (['Shift', 'Control', 'Alt', 'Meta'].includes(k)) used = false;
  else used = true;                                        // swallow other keys while transforming
  if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
}

export function initModal() {
  addEventListener('keydown', onKey, true);
  addEventListener('pointermove', (e) => { if (MOD && !MOD.typed) update(e); }, { capture: true, passive: true });
  R.renderer.domElement.addEventListener('pointerdown', (e) => {
    if (!MOD) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.button === 0) confirmModal(); else cancelModal('right_click');
  }, { capture: true });
  R.renderer.domElement.addEventListener('contextmenu', (e) => { if (MOD) e.preventDefault(); });
}

