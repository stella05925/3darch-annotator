// PowerPoint-style resize handles: the selected element's box in its own frame (u along, n across, z up), with one
// handle on each face that can be resized. Dragging a face moves only that face: it is a scale about the opposite
// face (the adapter's `faces` table, xform.js) run through a transform session, so snapping, logging, cancel and
// undo are the gumball's, and only parametric fields change.
import * as THREE from 'three';
import { TYPES } from './registry.js';
import { S, $, num } from './state.js';
import * as R from './render.js';
import { rayHit } from './selection.js';
import { TransformSession } from './transform.js';

const V3 = THREE.Vector3;
export const AXIS_COLOR = { u: '#ff5a5a', n: '#58d858', z: '#5a9cff' };
const AXIS_NAME = { u: 'length', n: 'thickness', z: 'height' };
const CUBE = new THREE.BoxGeometry(1, 1, 1);

/** The element's box in its frame, from its drawn meshes: {t, n, u: [lo, hi], v: [lo, hi], z: [lo, hi]}. */
function frameBox(el) {
  const a = TYPES[el.kind].xf.frame(el.rec).angle, t = [Math.cos(a), Math.sin(a)], n = [-t[1], t[0]];
  const u = [Infinity, -Infinity], v = [Infinity, -Infinity], z = [Infinity, -Infinity];
  for (const m of el.meshes) {
    const p = m.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), zz = p.getZ(i), pu = x * t[0] + y * t[1], pv = x * n[0] + y * n[1];
      u[0] = Math.min(u[0], pu); u[1] = Math.max(u[1], pu); v[0] = Math.min(v[0], pv); v[1] = Math.max(v[1], pv);
      z[0] = Math.min(z[0], zz); z[1] = Math.max(z[1], zz);
    }
  }
  return u[0] <= u[1] ? { t, n, u, v, z } : null;
}
const world = (b, u, v, z) => new V3(b.t[0] * u + b.n[0] * v, b.t[1] * u + b.n[1] * v, z);

/** Handles (and the box outline) for one element; [] when it has no resizable faces. */
export function boxHandles(el) {
  const xf = TYPES[el.kind].xf;
  if (!xf || !xf.faces || !xf.extent || !el.meshes.length) return [];
  if (el.rec.shape === 'arc') return arcHandles(el, xf.faces.filter((f) => f.arc));
  const flat = !(el.rec.axis && el.rec.axis.start && el.rec.axis.start.length === 3);
  const faces = xf.faces.filter((f) => !f.arc && (!f.flat || flat) && (xf.axes.scale || []).includes(f.face[0]));
  const b = frameBox(el);
  if (!b || !faces.length) return [];
  const mid = (r) => (r[0] + r[1]) / 2;
  const out = [];
  // outline: the 12 edges of the box
  const c = [];
  for (const uu of b.u) for (const vv of b.v) for (const zz of b.z) c.push(world(b, uu, vv, zz));
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(E.flatMap(([i, j]) => [c[i], c[j]])),
    new THREE.LineDashedMaterial({ color: '#ffffff', dashSize: 0.06, gapSize: 0.04, depthTest: false, transparent: true, opacity: 0.8 }));
  line.computeLineDistances(); line.renderOrder = 998; line.userData.fixedScale = true; line.raycast = () => {};
  out.push({ object: line });
  for (const f of faces) {
    const a = f.face[0], sign = f.face[1] === '+' ? 1 : -1;
    const pu = a === 'u' ? b.u[sign > 0 ? 1 : 0] : mid(b.u), pv = a === 'n' ? b.v[sign > 0 ? 1 : 0] : mid(b.v);
    const pz = a === 'z' ? b.z[sign > 0 ? 1 : 0] : mid(b.z);
    const dir = a === 'u' ? new V3(b.t[0], b.t[1], 0) : a === 'n' ? new V3(b.n[0], b.n[1], 0) : new V3(0, 0, 1);
    dir.multiplyScalar(sign);
    const m = new THREE.Mesh(CUBE, new THREE.MeshBasicMaterial({ color: AXIS_COLOR[a], depthTest: false, transparent: true, opacity: 0.95 }));
    m.position.copy(world(b, pu, pv, pz)); m.renderOrder = 999;
    // thin elements (a 5 cm beam): tools.scaleHandles pushes the handle out along `dir` so handles never overlap
    const half = a === 'u' ? (b.u[1] - b.u[0]) / 2 : a === 'n' ? (b.v[1] - b.v[0]) / 2 : (b.z[1] - b.z[0]) / 2;
    Object.assign(m.userData, { base: m.position.clone(), dir: dir.clone(), half });
    m.quaternion.setFromUnitVectors(new V3(1, 0, 0), new V3(b.t[0], b.t[1], 0));
    m.userData.spec = { name: `face ${f.face}`, tip: `${AXIS_NAME[a]}: drag this ${a === 'z' ? (sign > 0 ? 'top' : 'bottom') : 'side'}; the opposite side stays`,
      begin: (e) => beginFaceDrag(el, f, a, dir, m.position.clone(), e) };
    out.push({ object: m });
  }
  return out;
}

/**
 * A round wall's handles, on the side of the ring facing the camera: red = the radius (both faces move, the thickness
 * stays), green = the outer or the inner face alone (the thickness changes), blue = top and base. They sit a few
 * degrees apart so they never overlap.
 */
function arcHandles(el, faces) {
  const A = el.rec.arc, c = A.center, cam = R.camera.position, tgt = R.controls.target;
  let th = Math.atan2(cam.y - c[1], cam.x - c[0]);
  if (Math.hypot(cam.x - c[0], cam.y - c[1]) < 0.5) th = Math.atan2(tgt.y - c[1], tgt.x - c[0]) || 0;   // (a plan view over the centre)
  const zm = (el.rec.base_z + el.rec.top_z) / 2, DEGR = Math.PI / 180;
  const place = { 'u+': [0, A.radius_axis, zm], 'n+': [7, A.r_outer, zm], 'n-': [-7, A.r_inner, zm], 'z+': [0, A.radius_axis, el.rec.top_z], 'z-': [0, A.radius_axis, el.rec.base_z] };
  const tips = { 'u+': 'radius: both faces move, the thickness stays', 'n+': 'outer face: the inner face stays', 'n-': 'inner face: the outer face stays',
    'z+': 'top: the base stays', 'z-': 'base: the top stays' };
  return faces.map((f) => {
    const [dDeg, r, z] = place[f.face], a = th + dDeg * DEGR, rad = new V3(Math.cos(a), Math.sin(a), 0), axis = f.face[0];
    const dir = axis === 'z' ? new V3(0, 0, f.face[1] === '+' ? 1 : -1) : f.face === 'n-' ? rad.clone().negate() : rad.clone();
    const m = new THREE.Mesh(CUBE, new THREE.MeshBasicMaterial({ color: AXIS_COLOR[axis], depthTest: false, transparent: true, opacity: 0.95 }));
    m.position.set(c[0] + rad.x * r, c[1] + rad.y * r, z); m.renderOrder = 999;
    m.quaternion.setFromUnitVectors(new V3(1, 0, 0), rad);
    m.userData.spec = { name: `face ${f.face}`, tip: tips[f.face], begin: (e) => beginFaceDrag(el, f, axis, dir, m.position.clone(), e) };
    return { object: m };
  });
}

/** A plane through p0 that contains the drag direction and faces the camera as much as possible. */
function dragPlane(p0, dir) {
  const view = new V3(); R.camera.getWorldDirection(view);
  let nrm = view.clone().sub(dir.clone().multiplyScalar(view.dot(dir)));
  if (nrm.lengthSq() < 1e-6) nrm = new V3(0, 0, 1).cross(dir);
  return new THREE.Plane().setFromNormalAndCoplanarPoint(nrm.normalize(), p0);
}

function beginFaceDrag(el, face, axis, dir, p0, e) {
  const plane = dragPlane(p0, dir);
  const grab = rayHit(e, plane);
  if (!grab) return null;
  const xf = TYPES[el.kind].xf;
  const session = new TransformSession({ els: [el], mode: 'scale', input: 'box_handle', space: 'local', pivot: face.pivot });
  const ext = xf.extent(session.rec0(el.id), axis);
  const ov = $('#xf-overlay');
  let lastK = 1;
  return {
    update(ev) {
      const hit = rayHit(ev, plane);
      if (!hit) return;
      const d = hit.sub(grab).dot(dir);
      const k = Math.max((ext + d) / ext, 0.02);
      const res = session.apply({ k: { [axis]: k } }, axis, { event: ev });
      lastK = res.k[axis];
      ov.innerHTML = `${el.rec.shape === 'arc' && axis === 'u' ? 'radius' : AXIS_NAME[axis]} <b>${num(ext * lastK, 3)}</b> m <span class="muted">(${(ext * lastK - ext >= 0 ? '+' : '')}${num(ext * lastK - ext, 3)})</span>`;
      const vr = R.vp.getBoundingClientRect();
      Object.assign(ov.style, { display: 'block', left: `${ev.clientX - vr.left + 18}px`, top: `${ev.clientY - vr.top - 10}px` });
    },
    end() { ov.style.display = 'none'; session.confirm(); },
    cancel(how) { ov.style.display = 'none'; session.cancel(how); },
  };
}

/** Is the box-handle style active for this selection? (scale mode, one element) */
export const boxMode = () => S.gizmo.mode === 'scale';
