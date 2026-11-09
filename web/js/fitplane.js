// Fit a plane to the scan and apply it to the selected element.
//   Click the scan: starting from the clicked triangle's plane, the scan triangles within the radius that face the same
//   way and lie within a few cm of the current plane are fitted (area-weighted least squares), a few times over.
//   Shift+click adds more of the surface. The panel then offers what the plane can set on the selected element (a wall face, a floor or
//   ceiling height or slope, a sill ...); applying it is one undoable command that writes those fields.
import * as THREE from 'three';
import * as M from './model.js';
import { S, EL, SCAN, $, esc, mm, num, log, toast, hostOf } from './state.js';
import * as R from './render.js';
import { setRay, raycaster } from './selection.js';
import { setFields } from './commands.js';

const V3 = THREE.Vector3;
const DEG = 180 / Math.PI;
const group = new THREE.Group();
let samples = [];                     // [{c: [x, y, z], w}] kept triangles (centroid, area)

export function initFitPlane() { R.scene.add(group); }
export function clearFit() { samples = []; S.fit = null; R.disposeGroup(group); }

/** Smallest-eigenvalue eigenvector of a symmetric 3×3 matrix (Jacobi rotations). */
function smallestEigen(A) {
  const a = A.map((r) => [...r]), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 30; it++) {
    let p = 0, q = 1;
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) if (Math.abs(a[i][j]) > Math.abs(a[p][q])) { p = i; q = j; }
    if (Math.abs(a[p][q]) < 1e-14) break;
    const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(th), s = Math.sin(th);
    for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
    for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
    for (let k = 0; k < 3; k++) { const x = V[k][p], y = V[k][q]; V[k][p] = c * x - s * y; V[k][q] = s * x + c * y; }
  }
  const i = [0, 1, 2].reduce((m, k) => (a[k][k] < a[m][m] ? k : m), 0);
  return [V[0][i], V[1][i], V[2][i]];
}
function fit(pts) {
  const W = pts.reduce((s, p) => s + p.w, 0);
  const c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p.w * p.c[k], 0) / W);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += p.w * (p.c[i] - c[i]) * (p.c[j] - c[j]);
  let n = smallestEigen(C);
  const len = Math.hypot(...n); n = n.map((x) => x / len);
  const d = n[0] * c[0] + n[1] * c[1] + n[2] * c[2];
  const rms = Math.sqrt(pts.reduce((s, p) => s + p.w * (n[0] * p.c[0] + n[1] * p.c[1] + n[2] * p.c[2] - d) ** 2, 0) / W);
  return { n, d, c, rms, area: W };
}

/** Scan triangles near P (within r) facing like n0 (within maxDeg), optionally within tol of a plane. */
function gather(P, n0, r, maxDeg, plane = null, tol = 0.025) {
  const out = [], cosMax = Math.cos(maxDeg / DEG), box = new THREE.Box3(P.clone().subScalar(r), P.clone().addScalar(r));
  const a = new V3(), b = new V3(), c = new V3(), e1 = new V3(), e2 = new V3(), nn = new V3();
  for (const s of SCAN) {
    if (!s.mesh.visible || !s.box.intersectsBox(box)) continue;
    const pos = s.mesh.geometry.attributes.position, idx = s.mesh.geometry.index, mw = s.mesh.matrixWorld;
    const nTri = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < nTri; t++) {
      const i0 = idx ? idx.getX(3 * t) : 3 * t, i1 = idx ? idx.getX(3 * t + 1) : 3 * t + 1, i2 = idx ? idx.getX(3 * t + 2) : 3 * t + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mw);
      if (Math.abs(a.x - P.x) > r + 0.3 || Math.abs(a.y - P.y) > r + 0.3 || Math.abs(a.z - P.z) > r + 0.3) continue;
      b.fromBufferAttribute(pos, i1).applyMatrix4(mw); c.fromBufferAttribute(pos, i2).applyMatrix4(mw);
      const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3, cz = (a.z + b.z + c.z) / 3;
      if ((cx - P.x) ** 2 + (cy - P.y) ** 2 + (cz - P.z) ** 2 > r * r) continue;
      nn.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
      const area = nn.length() / 2;
      if (area < 1e-8) continue;
      nn.divideScalar(2 * area);
      if (Math.abs(nn.dot(n0)) < cosMax) continue;
      if (plane && Math.abs(plane.n[0] * cx + plane.n[1] * cy + plane.n[2] * cz - plane.d) > tol) continue;
      out.push({ c: [cx, cy, cz], w: area });
    }
  }
  return out;
}

/** Click on the scan (Shift: add to the current fit). */
export function fitClick(e) {
  setRay(e);
  const hit = raycaster.intersectObjects(SCAN.filter((s) => s.mesh.visible).map((s) => s.mesh), false).find((h) => R.clipOk(h.point));
  if (!hit) { toast('Click on the scan (the scan layer must be visible).'); return; }
  const P = hit.point.clone(), n0 = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
  const r = S.fitRadius;
  // start from the clicked surface itself (its plane), so a second surface a few cm in front or behind (trim,
  // curtains, furniture) is not averaged in; then refit on the triangles close to the current plane a few times
  let f = { n: n0.toArray(), d: n0.dot(P) }, pts = [];
  for (let it = 0; it < 4; it++) {
    const cand = gather(P, new V3(...f.n), r, it ? 15 : 20, f, it ? 0.025 : 0.04);
    if (cand.length < 6) break;
    pts = cand; f = fit(pts);
  }
  if (pts.length < 6) { toast('Too little flat scan surface there for a plane; click a flatter or larger area (or raise the radius).'); return; }
  samples = e.shiftKey ? [...samples, ...pts] : pts;
  const F = fit(samples);
  if (F.n[2] < 0 || (Math.abs(F.n[2]) < 1e-6 && n0.dot(new V3(...F.n)) < 0)) { F.n = F.n.map((x) => -x); F.d = -F.d; }
  const tilt = Math.acos(Math.min(1, Math.abs(F.n[2]))) * DEG;
  S.fit = { ...F, tilt_deg: tilt, count: samples.length, kind: tilt < 10 ? 'horizontal' : tilt > 80 ? 'vertical' : 'sloped' };
  drawFit();
  log('fit_plane', { n: F.n.map((x) => +x.toFixed(4)), d: +F.d.toFixed(4), rms: +F.rms.toFixed(4), tilt_deg: +tilt.toFixed(2), triangles: samples.length, add: e.shiftKey, radius: r });
  import('./panel.js').then((p) => p.renderProps());
}

function drawFit() {
  R.disposeGroup(group);
  if (!S.fit) return;
  const F = S.fit, n = new V3(...F.n), c = new V3(...F.c);
  let ext = 0.2;
  for (const p of samples) ext = Math.max(ext, c.distanceTo(new V3(...p.c)));
  const g = new THREE.PlaneGeometry(2 * ext, 2 * ext);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#00e5ff', transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthTest: false }));
  m.quaternion.setFromUnitVectors(new V3(0, 0, 1), n); m.position.copy(c); m.renderOrder = 997;
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: '#00e5ff', depthTest: false }));
  edge.quaternion.copy(m.quaternion); edge.position.copy(c); edge.renderOrder = 997;
  const arrow = new THREE.ArrowHelper(n, c, Math.min(0.5, ext), '#00e5ff');
  arrow.traverse((o) => { if (o.material) o.material.depthTest = false; o.renderOrder = 997; });
  group.add(m, edge, arrow);
}

// ------------------------------------------------------------------ what a plane can set on each element type
/** Height of the fitted plane at plan point (x, y). */
const zAt = (F, x, y) => (F.d - F.n[0] * x - F.n[1] * y) / F.n[2];
const planeZ = (F) => ({ z_of_xy: [-F.n[0] / F.n[2], -F.n[1] / F.n[2], F.d / F.n[2]].map(M.r4) });

/** [{label, fields}] the current fit can set on the element. */
export function planeTargets(el, F) {
  const r = el.rec, out = [];
  const horiz = F.kind === 'horizontal', vert = F.kind === 'vertical';
  const hz = (x, y) => mm(zAt(F, x, y));
  const cen = (poly) => poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);
  switch (el.kind) {
    case 'wall': {
      if (r.shape === 'arc') {                               // round wall: a flat plane sets its top or base only
        if (horiz) out.push({ label: 'Wall top → plane', fields: { top_z: hz(...r.arc.center) } }, { label: 'Wall base → plane', fields: { base_z: hz(...r.arc.center) } });
        break;
      }
      const f = M.wallFrame(r), mid = M.at(f, f.L / 2), h = r.thickness / 2;
      if (horiz) {
        const z = hz(...mid), d = z - r.top_z;
        out.push({ label: 'Wall top → plane', fields: { top_z: z, ...(r.top_profile ? { top_profile: { ...r.top_profile, z: r.top_profile.z.map((x) => mm(x + d)) } } : {}) } });
        out.push({ label: 'Wall base → plane', fields: { base_z: z } });
      }
      if (vert) {
        const m = [F.n[0], F.n[1]], ml = Math.hypot(...m), mu = [m[0] / ml, m[1] / ml], c = (F.d) / ml;   // plan line: mu·x = c
        // the plane's direction, turned to match the wall's current direction
        let t2 = [-mu[1], mu[0]];
        if (t2[0] * f.t[0] + t2[1] * f.t[1] < 0) t2 = [-t2[0], -t2[1]];
        const n2 = [-t2[1], t2[0]], s = n2[0] * mu[0] + n2[1] * mu[1] > 0 ? 1 : -1, face = s * c;   // face line: n2·x = face
        const onto = (axisOff) => {
          const pr = (p) => { const k = n2[0] * p[0] + n2[1] * p[1] - axisOff; return [mm(p[0] - k * n2[0]), mm(p[1] - k * n2[1])]; };
          return { 'axis.start': pr(r.axis.start), 'axis.end': pr(r.axis.end) };
        };
        const turn = Math.acos(Math.min(1, Math.abs(f.n[0] * mu[0] + f.n[1] * mu[1]))) * DEG;
        out.push({ label: `Left face → plane (keep thickness${turn > 0.05 ? `, turn ${num(turn, 1)}°` : ''})`, fields: onto(face - h) });
        out.push({ label: `Right face → plane (keep thickness${turn > 0.05 ? `, turn ${num(turn, 1)}°` : ''})`, fields: onto(face + h) });
        if (turn < 3) {
          const vL = f.n[0] * (r.axis.start[0]) + f.n[1] * r.axis.start[1];           // axis offset along the wall's own n
          const at = n2[0] * f.n[0] + n2[1] * f.n[1] > 0 ? face : -face;             // the plane along the wall's n
          const left = vL + h, right = vL - h;
          const side = (lo, hi, label) => {
            if (hi - lo < 0.01) return;
            const cOff = (lo + hi) / 2 - vL;
            out.push({ label, fields: { 'axis.start': M.at(f, 0, cOff).map(mm), 'axis.end': M.at(f, f.L, cOff).map(mm), thickness: mm(hi - lo) } });
          };
          side(right, at, 'Left face only → plane (thickness changes)');
          side(at, left, 'Right face only → plane (thickness changes)');
        }
      }
      break;
    }
    case 'opening': {
      const w = hostOf(el);
      if (!w) break;
      const f = M.wallFrame(w), P = r.position, c = M.at(f, (P.u_start + P.u_end) / 2);
      if (horiz) {
        out.push({ label: 'Sill → plane', fields: { sill_z: Math.min(hz(...c), mm(r.head_z - 0.05)) } });
        out.push({ label: 'Head → plane', fields: { head_z: Math.max(hz(...c), mm(r.sill_z + 0.05)) } });
      }
      const mt = F.n[0] * f.t[0] + F.n[1] * f.t[1];
      if (vert && Math.abs(mt) > 0.7) {                       // a jamb plane: where it crosses the wall axis
        const u = mm((F.d - (F.n[0] * f.s[0] + F.n[1] * f.s[1])) / mt);
        if (u < P.u_end - 0.05) out.push({ label: 'Start jamb → plane', fields: { 'position.u_start': Math.max(0, u) } });
        if (u > P.u_start + 0.05) out.push({ label: 'End jamb → plane', fields: { 'position.u_end': Math.min(f.L, u) } });
      }
      break;
    }
    case 'floor': {
      const c = cen(r.polygon);
      if (horiz) out.push({ label: 'Floor height → plane', fields: { z: hz(...c), modeled_as: 'horizontal' } });
      if (!vert) out.push({ label: 'Floor → plane (keep its slope)', fields: { z: hz(...c), modeled_as: 'plane', measured_plane: [...F.n.map((x) => +x.toFixed(5)), +F.d.toFixed(5)] } });
      break;
    }
    case 'room': if (horiz) out.push({ label: 'Room floor height → plane', fields: { floor_z: hz(...cen(r.polygon)) } }); break;
    case 'ceiling': {
      const i = S.selPatch != null && r.patches[S.selPatch] ? S.selPatch : r.patches.findIndex((p) => p.kind === 'main');
      const p = r.patches[i < 0 ? 0 : i];
      if (!p || !p.polygon || (p.modeled_as === 'cone' && p.cone)) break;
      const k = i < 0 ? 0 : i, c = cen(p.polygon);
      if (horiz) out.push({ label: `Ceiling patch ${k + 1} height → plane`, fields: { [`patches.${k}`]: { ...p, z: hz(...c), modeled_as: 'horizontal', plane: undefined } } });
      if (!vert) out.push({ label: `Ceiling patch ${k + 1} → plane (keep its slope)`, fields: { [`patches.${k}`]: { ...p, z: hz(...c), modeled_as: 'plane', plane: planeZ(F) } } });
      break;
    }
    case 'column': case 'builtin': case 'screen': {
      if (!horiz) break;
      const c = r.axis ? [(r.axis.start[0] + r.axis.end[0]) / 2, (r.axis.start[1] + r.axis.end[1]) / 2] : cen(r.footprint || r.polygon);
      out.push({ label: 'Top → plane', fields: { top_z: hz(...c) } }, { label: 'Base → plane', fields: { base_z: hz(...c) } });
      break;
    }
    case 'bulkhead': {
      if (!horiz || !r.footprint) break;
      const z = hz(...cen(r.footprint));
      out.push({ label: 'Underside → plane', fields: { bottom_z: z, depth: mm(r.top_z - z) } }, { label: 'Top → plane', fields: { top_z: z, depth: mm(z - r.bottom_z) } });
      break;
    }
    case 'beam': {
      if (!horiz || r.axis.start.length === 3) break;
      const z = hz((r.axis.start[0] + r.axis.end[0]) / 2, (r.axis.start[1] + r.axis.end[1]) / 2);
      out.push({ label: 'Underside → plane', fields: { bottom_z: z, top_z: mm(z + r.depth) } });
      break;
    }
    default:
  }
  return out;
}

/** Largest change (m) of the numbers in `fields` against the record (heights, coordinates). */
function largestChange(rec, fields) {
  let m = 0;
  const walk = (a, b) => {
    if (typeof a === 'number' && typeof b === 'number') m = Math.max(m, Math.abs(a - b));
    else if (Array.isArray(a) && Array.isArray(b)) a.forEach((x, i) => walk(x, b[i]));
    else if (a && b && typeof a === 'object' && typeof b === 'object') for (const k of ['z', 'base_z', 'top_z', 'bottom_z']) if (k in a && k in b) walk(a[k], b[k]);
  };
  for (const [k, v] of Object.entries(fields)) if (k !== 'thickness' && k !== 'depth' && k !== 'measured_plane') walk(M.getPath(rec, k), v);
  return m;
}

/** Panel block: the current fit and what it can set on the selection. */
export function fitPanel() {
  const F = S.fit;
  if (!F) return '';
  const el = S.sel && EL.get(S.sel);
  const targets = el ? planeTargets(el, F) : [];
  let html = `<div class="fitcard"><b>Fitted plane</b> · ${esc(F.kind)} (tilt ${num(F.tilt_deg, 1)}°) · rms ${num(F.rms * 100, 1)} cm · ${F.count} triangles
    <span class="muted">· Shift+click the scan adds more surface</span>`;
  if (!el) html += '<p class="muted">Select an element to apply the plane to.</p>';
  else if (!targets.length) html += `<p class="muted">Nothing on this ${esc(el.kind)} can take a ${esc(F.kind)} plane.</p>`;
  else html += `<div class="actions">${targets.map((t, i) => `<button data-fit="${i}">${esc(t.label)}</button>`).join('')}</div>`;
  return `${html}<div class="actions"><button data-fit="clear" class="muted">Clear plane</button></div></div>`;
}
export function bindFitPanel(host) {
  host.querySelectorAll('[data-fit]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.fit === 'clear') { clearFit(); import('./panel.js').then((p) => p.renderProps()); return; }
    const el = EL.get(S.sel), t = planeTargets(el, S.fit)[Number(b.dataset.fit)];
    if (!t) return;
    const F = S.fit;
    const fields = Object.fromEntries(Object.entries(t.fields).map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : v]));
    // a click on furniture instead of the floor (or a far wall) would move things a lot: ask first
    const big = largestChange(el.rec, fields);
    if (big > 0.15 && !confirm(`${t.label} moves ${el.id} by ${num(big, 2)} m. Apply it anyway?`)) { log('fit_plane_declined', { id: el.id, label: t.label, change: mm(big) }); return; }
    const ok = setFields(el, fields, `${el.id}: ${t.label}`, 'fit_plane', { opName: `${el.kind}.fit_plane`, input: 'fit_plane',
      snap: { type: 'plane', label: t.label, rms: +F.rms.toFixed(4), tilt_deg: +F.tilt_deg.toFixed(2), triangles: F.count } });
    toast(ok ? `${t.label}: done.` : 'Already there: nothing changed.');
  }));
}
export { gather as _gather, fit as _fit };   // for tests
