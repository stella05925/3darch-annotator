// Snapping shared by handles, the gumball, keyboard transforms and the add tools. Tolerances are in screen pixels
// (S.snapPx, default 10 px) converted to metres at the snap point, so snapping feels the same at any zoom.
import * as THREE from 'three';
import * as M from './model.js';
import { EL, ctx, S, $, esc, clamp, levelById } from './state.js';
import { guideGroup, disposeGroup, camera, worldPerPixel, vp } from './render.js';
import { TYPES } from './registry.js';

/** Snap tolerance in metres at a point (plan point [x, y] uses the current level's floor height). */
export function pxTol(p) {
  const z = p.length > 2 ? p[2] : (S.level && levelById(S.level) ? levelById(S.level).elevation + 1 : 1);
  return S.snapPx * worldPerPixel(new THREE.Vector3(p[0], p[1], z));
}

export function wallsOnLevel(levels, exceptId) {
  const out = [];
  for (const el of EL.values()) {
    if (el.kind === 'wall' && el.rec.shape !== 'arc' && el.id !== exceptId && el.levels.some((l) => levels.includes(l))) out.push(el.rec);
  }
  return out;
}
export function nearestOnSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-12;
  const k = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2, 0, 1);
  return [a[0] + k * dx, a[1] + k * dy];
}
/** Snap a wall end point: angle (Shift) > other wall end points > other wall axes (both within the pixel tolerance). */
export function snapPoint(p, levels, exceptId, fixed, shift) {
  if (shift && fixed) {
    const dx = p[0] - fixed[0], dy = p[1] - fixed[1], r = Math.hypot(dx, dy);
    const step = Math.PI / 4;
    const a = ctx.dominant + Math.round((Math.atan2(dy, dx) - ctx.dominant) / step) * step;
    return { p: [fixed[0] + r * Math.cos(a), fixed[1] + r * Math.sin(a)], type: 'angle', angle_deg: Math.round((a * 180) / Math.PI) };
  }
  const tol = pxTol(p);
  let best = null;
  for (const w of wallsOnLevel(levels, exceptId)) {
    for (const q of [w.axis.start, w.axis.end]) {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < tol && (!best || d < best.d)) best = { p: [...q], type: 'endpoint', target: w.id, d };
    }
  }
  if (best) return best;
  for (const w of wallsOnLevel(levels, exceptId)) {
    const q = nearestOnSegment(p, w.axis.start, w.axis.end), d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < tol && (!best || d < best.d)) best = { p: q, type: 'axis', target: w.id, d };
  }
  return best || { p, type: null };
}
/** Offsets (along this wall's normal) of the faces and axes of parallel walls on the same level. */
export function parallelLines(w0) {
  const f = M.wallFrame(w0), out = [];
  for (const w of wallsOnLevel([w0.level], w0.id)) {
    const g = M.wallFrame(w);
    if (Math.abs(f.t[0] * g.t[1] - f.t[1] * g.t[0]) > Math.sin((2 * Math.PI) / 180)) continue;   // > 2° apart
    const [ua] = M.uvOf(f, g.s), [ub] = M.uvOf(f, g.e);
    if (Math.max(ua, ub) < -4 || Math.min(ua, ub) > f.L + 4) continue;                                // far along the wall
    const d = M.uvOf(f, g.s)[1], h = w.thickness / 2;
    out.push({ id: w.id, offs: [d - h, d, d + h] });
  }
  return out;
}
export function snapOffset(value, lines, tol, mine = [0]) {
  let best = null;
  for (const ln of lines) for (const o of ln.offs) for (const m of mine) {
    const diff = o - (value + m);
    if (Math.abs(diff) < tol && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, target: ln.id };
  }
  return best;
}
export function snap1D(value, cands, tol) {
  let best = null;
  for (const c of cands) { const d = Math.abs(c.v - value); if (d < tol && (!best || d < best.d)) best = { v: c.v, d, type: c.type, target: c.target }; }
  return best;
}

/**
 * Plan snapping of moving points (a wall's ends, a column's corners): the smallest correction that puts one of them
 * on another wall's end point, axis or face line, or on another element's snap point. Returns {corr, type, target, at}.
 */
export function planSnap(points, levels, exceptIds, z) {
  const tol = pxTol([...(points[0] || [0, 0]), z]);
  let best = null;
  const consider = (p, q, type, target) => {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < tol && (!best || d < best.d - 1e-9 || (type === 'endpoint' && best.type !== 'endpoint' && d < best.d + 1e-3))) {
      best = { d, corr: [q[0] - p[0], q[1] - p[1]], type, target, at: [q[0], q[1], z] };
    }
  };
  const walls = wallsOnLevel(levels, null).filter((w) => !exceptIds.has(w.id));
  for (const p of points) {
    for (const w of walls) {
      consider(p, w.axis.start, 'endpoint', w.id); consider(p, w.axis.end, 'endpoint', w.id);
      const fl = M.faceLines(w);
      consider(p, nearestOnSegment(p, w.axis.start, w.axis.end), 'axis', w.id);
      consider(p, nearestOnSegment(p, ...fl.left), 'face', w.id);
      consider(p, nearestOnSegment(p, ...fl.right), 'face', w.id);
    }
    for (const el of EL.values()) {
      if (exceptIds.has(el.id) || el.kind === 'wall' || !el.levels.some((l) => levels.includes(l))) continue;
      const xf = TYPES[el.kind] && TYPES[el.kind].xf;
      if (!xf || !xf.snapPoints || !el.meshes.length) continue;              // (a note-only bulkhead has no outline)
      for (const q of xf.snapPoints(el.rec) || []) consider(p, q, 'vertex', el.id);
    }
  }
  return best;
}

/** Snap a direction (radians) to the house grid (45° steps) or to another wall's direction, within `tolRad`. */
export function angleSnap(angle, levels, exceptIds, tolRad) {
  const norm = (a) => { let x = a % Math.PI; if (x < 0) x += Math.PI; return x; };   // directions modulo 180°
  const diff = (a, b) => { let d = norm(a) - norm(b); if (d > Math.PI / 2) d -= Math.PI; if (d < -Math.PI / 2) d += Math.PI; return d; };
  let best = null;
  for (let k = 0; k < 4; k++) {
    const g = ctx.dominant + (k * Math.PI) / 4, d = diff(g, angle);
    if (Math.abs(d) < tolRad && (!best || Math.abs(d) < Math.abs(best.corr))) best = { corr: d, type: 'grid_angle', target: `${Math.round(((norm(g)) * 180) / Math.PI)}°` };
  }
  for (const w of wallsOnLevel(levels, null)) {
    if (exceptIds.has(w.id)) continue;
    const f = M.wallFrame(w), d = diff(Math.atan2(f.t[1], f.t[0]), angle);
    if (Math.abs(d) < tolRad * 0.999 && (!best || Math.abs(d) < Math.abs(best.corr) - 1e-6)) best = { corr: d, type: 'parallel', target: w.id };
  }
  return best;
}

// ------------------------------------------------------------------ indicator
/** Ring at the snap point and a label near the cursor naming what was snapped to. */
export function showGuide(snap) {
  disposeGroup(guideGroup);
  const lab = $('#snap-label');
  if (!snap || !snap.type) { if (lab) lab.style.display = 'none'; return; }
  if (snap.at) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 24), new THREE.MeshBasicMaterial({ color: '#00ff9c', depthTest: false, side: THREE.DoubleSide }));
    m.renderOrder = 1000; m.position.set(...snap.at); guideGroup.add(m);
    if (camera.isPerspectiveCamera) m.lookAt(camera.position);
  }
  if (lab && S.pointer) {
    const r = vp.getBoundingClientRect();
    lab.innerHTML = `snap: ${esc(snap.type.replace(/_/g, ' '))}${snap.target ? ` · <b>${esc(snap.target)}</b>` : ''}`;
    lab.style.left = `${S.pointer.x - r.left + 16}px`; lab.style.top = `${S.pointer.y - r.top + 28}px`; lab.style.display = 'block';
  }
}
