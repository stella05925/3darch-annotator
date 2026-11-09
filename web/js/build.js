// Annotation records -> three.js geometry, rebuilt live after every edit (never edited directly).
import * as THREE from 'three';
import { at, topAt, wallFrame } from './model.js';

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const DEG = Math.PI / 180;

function quad(pos, a, b, c, d) { pos.push(...a, ...b, ...c, ...a, ...c, ...d); }

/** Box between u=a..b along the wall, from z0 up to a top that runs from za1 (at a) to zb1 (at b), v in [v0, v1]. */
function wallPiece(pos, f, a, b, z0, za1, zb1, v0, v1) {
  const P = (u, v, z) => { const p = at(f, u, v); return [p[0], p[1], z]; };
  const A0 = P(a, v0, z0), B0 = P(b, v0, z0), B1 = P(b, v0, zb1), A1 = P(a, v0, za1);
  const a0 = P(a, v1, z0), b0 = P(b, v1, z0), b1 = P(b, v1, zb1), a1 = P(a, v1, za1);
  quad(pos, A0, B0, B1, A1); quad(pos, a0, a1, b1, b0);
  quad(pos, A1, B1, b1, a1); quad(pos, A0, a0, b0, B0);
  quad(pos, A0, A1, a1, a0); quad(pos, B0, b0, b1, B1);
}

/** Hexahedron from 8 corners: bottom face a,b,c,d (counter-clockwise from above) and the top face above them. */
function hexa(pos, [a, b, c, d, A, B, C, D]) {
  quad(pos, a, d, c, b); quad(pos, A, B, C, D);
  quad(pos, a, b, B, A); quad(pos, b, c, C, B); quad(pos, c, d, D, C); quad(pos, d, a, A, D);
}

function geometryFrom(pos) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

/** Wall solid with its openings left out: split along u at every opening edge and profile station. */
export function wallGeometry(w, openings, ext) {
  const f = wallFrame(w), h = w.thickness / 2, base = w.base_z;
  const lo = -ext[0], hi = f.L + ext[1];
  const cuts = openings
    .map((o) => [clamp(o.position.u_start, lo, hi), clamp(o.position.u_end, lo, hi), o.sill_z, o.head_z])
    .filter((c) => c[1] - c[0] > 1e-4);
  const br = new Set([lo, hi]);
  for (const c of cuts) { br.add(c[0]); br.add(c[1]); }
  if (w.top_profile && w.top_profile.u) for (const u of w.top_profile.u) if (u > lo && u < hi) br.add(u);
  const us = [...br].sort((x, y) => x - y);
  const pos = [];
  for (let i = 0; i + 1 < us.length; i++) {
    const a = us[i], b = us[i + 1];
    if (b - a < 1e-5) continue;
    const m = (a + b) / 2, ta = topAt(w, a), tb = topAt(w, b), tm = (ta + tb) / 2;
    const holes = cuts.filter((c) => c[0] <= m && c[1] >= m)
      .map((c) => [Math.max(base, c[2]), Math.min(tm, c[3])]).filter((r) => r[1] > r[0])
      .sort((x, y) => x[0] - y[0]);
    let z = base;
    for (const [z0, z1] of holes) {
      if (z0 > z + 1e-4) wallPiece(pos, f, a, b, z, z0, z0, -h, h);
      z = Math.max(z, z1);
    }
    if (tm > z + 1e-4) wallPiece(pos, f, a, b, z, ta, tb, -h, h);
  }
  return geometryFrom(pos);
}

/** Opening: a box filling the hole, slightly proud of both wall faces so it can be clicked. */
export function openingGeometry(o, w) {
  const f = wallFrame(w), h = w.thickness / 2 + 0.012;
  const pos = [];
  wallPiece(pos, f, o.position.u_start, o.position.u_end, o.sill_z, o.head_z, o.head_z, -h, h);
  return geometryFrom(pos);
}

// ------------------------------------------------------------------ round walls (shape: "arc")
/** Angle in degrees measured from the arc's start, in [0, 360). */
const rel = (theta, start) => (((theta - start) % 360) + 360) % 360;

/** An opening's angular range(s) relative to the arc start (split in two when it wraps past the start angle). */
export function arcOpeningRanges(o, arc) {
  const s = rel(o.position.theta_start, arc.start_angle_deg), e = rel(o.position.theta_end, arc.start_angle_deg);
  return e >= s ? [[s, e]] : [[s, 360], [0, e]];
}

/** Curved block between radii r0..r1 and angles a..b (degrees, absolute), from z0 to z1. End caps only where asked
 *  (consecutive slices of one run share no inner caps, so the edge overlay shows real breaks only). */
function arcPiece(pos, c, r0, r1, a, b, z0, z1, capA = true, capB = true) {
  const P = (r, t, z) => [c[0] + r * Math.cos(t * DEG), c[1] + r * Math.sin(t * DEG), z];
  const ia = P(r0, a, z0), oa = P(r1, a, z0), ob = P(r1, b, z0), ib = P(r0, b, z0);
  const IA = P(r0, a, z1), OA = P(r1, a, z1), OB = P(r1, b, z1), IB = P(r0, b, z1);
  quad(pos, ia, ib, IB, IA); quad(pos, oa, OA, OB, ob);        // inner and outer faces
  quad(pos, IA, IB, OB, OA); quad(pos, ia, oa, ob, ib);        // top and bottom
  if (capA) quad(pos, ia, IA, OA, oa);
  if (capB) quad(pos, ib, ob, OB, IB);
}

/** Ring-sector wall from its `arc` parameters, with its openings cut out by their theta ranges. */
export function arcWallGeometry(w, openings, step = 2) {
  const A = w.arc, start = A.start_angle_deg, sweep = A.sweep_deg ?? 360;
  const cuts = [];
  for (const o of openings) {
    if (o.position.theta_start == null) continue;
    for (const [s, e] of arcOpeningRanges(o, A)) cuts.push([s, e, o.sill_z, o.head_z]);
  }
  const br = new Set([0, sweep]);
  for (const c of cuts) { br.add(clamp(c[0], 0, sweep)); br.add(clamp(c[1], 0, sweep)); }
  const marks = [...br].sort((x, y) => x - y);
  const pos = [];
  for (let i = 0; i + 1 < marks.length; i++) {
    const a = marks[i], b = marks[i + 1];
    if (b - a < 1e-6) continue;
    const m = (a + b) / 2;
    const holes = cuts.filter((c) => c[0] <= m && c[1] >= m).map((c) => [Math.max(w.base_z, c[2]), Math.min(w.top_z, c[3])])
      .filter((r) => r[1] > r[0]).sort((x, y) => x[0] - y[0]);
    const segs = [];
    let z = w.base_z;
    for (const [z0, z1] of holes) { if (z0 > z + 1e-4) segs.push([z, z0]); z = Math.max(z, z1); }
    if (w.top_z > z + 1e-4) segs.push([z, w.top_z]);
    const n = Math.max(1, Math.ceil((b - a) / step));
    for (let k = 0; k < n; k++) {
      const t0 = start + a + ((b - a) * k) / n, t1 = start + a + ((b - a) * (k + 1)) / n;
      for (const [z0, z1] of segs) arcPiece(pos, A.center, A.r_inner, A.r_outer, t0, t1, z0, z1, k === 0, k === n - 1);
    }
  }
  return geometryFrom(pos);
}

/** Opening in a round wall: a curved block filling its theta range, slightly proud of both faces. */
export function arcOpeningGeometry(o, w, step = 2) {
  const A = w.arc, pos = [];
  for (const [s, e] of arcOpeningRanges(o, A)) {
    const n = Math.max(1, Math.ceil((e - s) / step));
    for (let k = 0; k < n; k++) {
      const t0 = A.start_angle_deg + s + ((e - s) * k) / n, t1 = A.start_angle_deg + s + ((e - s) * (k + 1)) / n;
      arcPiece(pos, A.center, A.r_inner - 0.012, A.r_outer + 0.012, t0, t1, o.sill_z, o.head_z, k === 0, k === n - 1);
    }
  }
  return geometryFrom(pos);
}

// ------------------------------------------------------------------ other solids
/** Vertical prism over a plan polygon (columns, bulkheads, built-ins), from z0 to z1. */
export function prismGeometry(poly, z0, z1, holes = null) {
  if (!poly || poly.length < 3 || !(z1 > z0)) return null;
  const shape = new THREE.Shape(poly.map((p) => new THREE.Vector2(p[0], p[1])));
  for (const hole of holes || []) if (hole && hole.length >= 3) shape.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(p[0], p[1]))));
  const g = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false });
  g.translate(0, 0, z0);
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

/** Box along a plan axis a→b, `width` across it, from z0 to z1 (screens, flat beams). */
export function axisBoxGeometry(a, b, width, z0, z1) {
  const f = wallFrame({ axis: { start: a, end: b } });
  const pos = [];
  wallPiece(pos, f, 0, f.L, z0, z1, z1, -width / 2, width / 2);
  return geometryFrom(pos);
}

/** Sloped beam: `axis` points are 3D (the underside centre line); the section width × depth sits above it. */
export function beam3DGeometry(a, b, width, depth) {
  const A = new THREE.Vector3(...a), Bv = new THREE.Vector3(...b);
  const t = Bv.clone().sub(A).normalize();
  let side = new THREE.Vector3().crossVectors(t, new THREE.Vector3(0, 0, 1));
  if (side.lengthSq() < 1e-8) side = new THREE.Vector3(1, 0, 0);
  side.normalize();
  const up = new THREE.Vector3().crossVectors(side, t).normalize();
  const P = (p, s, u) => p.clone().addScaledVector(side, s).addScaledVector(up, u).toArray();
  const h = width / 2, pos = [];
  hexa(pos, [P(A, -h, 0), P(A, h, 0), P(Bv, h, 0), P(Bv, -h, 0), P(A, -h, depth), P(A, h, depth), P(Bv, h, depth), P(Bv, -h, depth)]);
  return geometryFrom(pos);
}

/** Thin panels along a polyline (railings, virtual separators). zAt(i) gives [z0, z1] at vertex i. */
export function ribbonGeometry(path, thickness, zAt) {
  if (!path || path.length < 2) return null;
  const pos = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const f = wallFrame({ axis: { start: path[i], end: path[i + 1] } });
    if (f.L < 1e-4) continue;
    const [za0, za1] = zAt(i), [zb0, zb1] = zAt(i + 1);
    const P = (u, v, z) => { const p = at(f, u, v); return [p[0], p[1], z]; };
    const h = thickness / 2;
    hexa(pos, [P(0, h, za0), P(0, -h, za0), P(f.L, -h, zb0), P(f.L, h, zb0), P(0, h, za1), P(0, -h, za1), P(f.L, -h, zb1), P(f.L, h, zb1)]);
  }
  return pos.length ? geometryFrom(pos) : null;
}

/** Full ring (annulus) between r0 and r1 from z0 to z1 (skylight compression ring). */
export function ringGeometry(c, r0, r1, z0, z1, step = 6) {
  const pos = [];
  for (let t = 0; t < 360 - 1e-6; t += step) arcPiece(pos, c, r0, r1, t, Math.min(t + step, 360), z0, z1, false, false);
  return geometryFrom(pos);
}

/** Flat or planar polygon (floors, ceiling patches, treads); zOf(x, y) gives the height. */
export function polygonGeometry(poly, holes, zOf) {
  if (!poly || poly.length < 3) return null;
  const shape = new THREE.Shape(poly.map((p) => new THREE.Vector2(p[0], p[1])));
  for (const hole of holes || []) if (hole && hole.length >= 3) shape.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(p[0], p[1]))));
  const g = new THREE.ShapeGeometry(shape);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, zOf(p.getX(i), p.getY(i)));
  g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Conical ceiling patch (yurt roof liner): a polar grid around the apex, keeping the cells inside the patch outline. */
export function coneGeometry(patch, dz = 0, dTheta = 3, nR = 14) {
  const { apex, rise_per_m: k, r_min: r0 = 0, r_max: r1 } = patch.cone;
  const z = (r) => apex[2] - k * r + dz;
  const P = (r, t) => [apex[0] + r * Math.cos(t * DEG), apex[1] + r * Math.sin(t * DEG), z(r)];
  const inPatch = (x, y) => pointInPoly(x, y, patch.polygon) && !(patch.holes || []).some((h) => pointInPoly(x, y, h));
  const pos = [];
  for (let i = 0; i < nR; i++) {
    const ra = r0 + ((r1 - r0) * i) / nR, rb = r0 + ((r1 - r0) * (i + 1)) / nR;
    for (let t = 0; t < 360 - 1e-6; t += dTheta) {
      const rm = (ra + rb) / 2, tm = t + dTheta / 2;
      if (!inPatch(apex[0] + rm * Math.cos(tm * DEG), apex[1] + rm * Math.sin(tm * DEG))) continue;
      quad(pos, P(ra, t), P(rb, t), P(rb, t + dTheta), P(ra, t + dTheta));
    }
  }
  return pos.length ? geometryFrom(pos) : null;
}

/** Height function of a ceiling patch: flat, planar (z = a·x + b·y + c) or conical (yurt roof liner). */
export function patchZ(patch) {
  if (patch.modeled_as === 'cone' && patch.cone) {
    const { apex, rise_per_m: k } = patch.cone;
    return (x, y) => apex[2] - k * Math.hypot(x - apex[0], y - apex[1]);
  }
  if (patch.plane && patch.plane.z_of_xy) { const [a, b, c] = patch.plane.z_of_xy; return (x, y) => a * x + b * y + c; }
  return () => patch.z;
}
export function floorZ(fl) {
  if (fl.modeled_as === 'plane' && fl.measured_plane) {
    const [nx, ny, nz, d] = fl.measured_plane;
    return (x, y) => (d - nx * x - ny * y) / nz;
  }
  return () => fl.z;
}

export function lineLoop(poly, z) {
  const pts = poly.map((p) => new THREE.Vector3(p[0], p[1], z));
  return new THREE.BufferGeometry().setFromPoints(pts);
}
