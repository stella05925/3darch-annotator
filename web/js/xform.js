// Per-type transform adapters: a move / rotate / scale of an element about a pivot, turned into new parametric
// fields. Always computed from the record as it was when the transform started (rec0), so a live drag never
// accumulates error. Used by the gumball, the keyboard transforms and the layout tools (transform.js applies
// snapping and constraints; commands.js records the result).
//
// Adapter API (all optional except frame):
//   frame(rec) -> {angle, pivots: {name: [x, y, z]}, center: [x, y, z]}   local frame: u = along angle, n = left of it
//   axes: {translate: [...], rotate: [...], scale: [...]}  among 'u', 'n', 'z' (which gumball handles exist)
//   translate(rec0, d) -> fields        d = [dx, dy, dz] world
//   translateDeps(rec0, d, deps0) -> {id: fields}   dependents that move along (a wall's openings when it moves up / down)
//   rotate(rec0, a, c, axis, name) -> fields   a radians about `axis` (world unit vector; name 'z' = vertical, or
//                                       'u' / 'n' / 'x' / 'y' = a horizontal axis) through the pivot c = [x, y, z];
//                                       axes.rotate lists which axes the type can store (walls, columns ... only 'z')
//   scale(rec0, k, pivot, deps0) -> {fields, deps}   k = {u, n, z} factors in the local frame
//   snapPoints(rec) -> [[x, y], ...]    plan points that snap when the element moves
//   faces: [{face: 'u+'|'u-'|'n+'|'n-'|'z+'|'z-', pivot}]   PowerPoint-style resize handles: dragging a face scales
//                                       about `pivot` (the opposite face), so only that face moves
//   extent(rec, axis) -> m              the size a face handle's drag distance is divided by (k = (ext + d) / ext)
import * as M from './model.js';
import { mm, recOf, openingsOf, clamp } from './state.js';

export const rot = (p, c, a) => {
  const x = p[0] - c[0], y = p[1] - c[1], co = Math.cos(a), si = Math.sin(a);
  return [c[0] + co * x - si * y, c[1] + si * x + co * y];
};
// a move only rewrites the coordinates it changes (a vertical move must not re-round plan positions, and back)
/** Rotate the 3D point p about the unit axis k through c by angle a (Rodrigues). */
export function rot3(p, c, k, a) {
  const v = [p[0] - c[0], p[1] - c[1], p[2] - c[2]], co = Math.cos(a), si = Math.sin(a);
  const kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2], x = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  return [0, 1, 2].map((i) => c[i] + v[i] * co + x[i] * si + k[i] * kv * (1 - co));
}
const isVertical = (axis) => !axis || Math.abs(axis[2]) > 0.999;
const add = (p, d) => (Math.abs(d[0]) < 1e-12 && Math.abs(d[1]) < 1e-12 ? [p[0], p[1]] : [mm(p[0] + d[0]), mm(p[1] + d[1])]);
const addZ = (z, dz) => (Math.abs(dz) < 1e-12 ? z : mm(z + dz));
const r2 = (p) => [M.r4(p[0]), M.r4(p[1])];   // rotate / scale results keep 0.1 mm (the data's precision), so a pivot stays put
const zHandle = (base, top) => base + Math.min(1.0, Math.max((top - base) / 2, 0.1));

export function centroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f; cx += (poly[j][0] + poly[i][0]) * f; cy += (poly[j][1] + poly[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return poly.reduce((s, p) => [s[0] + p[0] / poly.length, s[1] + p[1] / poly.length], [0, 0]);
  return [cx / (3 * a), cy / (3 * a)];
}
function longestEdgeAngle(poly) {
  let best = 0, ang = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L > best) { best = L; ang = Math.atan2(q[1] - p[1], q[0] - p[0]); }
  }
  return ang;
}

// ------------------------------------------------------------------ axis elements (walls, screens, flat beams)
function axisFrame(rec, zb, zt, half) {
  const f = M.wallFrame(rec), z = zHandle(zb, zt), mid = M.at(f, f.L / 2);
  const pivots = { mid: [...mid, z], start: [...f.s, z], end: [...f.e, z] };
  if (half !== undefined) { pivots.faceL = [...M.at(f, f.L / 2, half), z]; pivots.faceR = [...M.at(f, f.L / 2, -half), z]; }
  return { angle: Math.atan2(f.t[1], f.t[0]), pivots, center: pivots.mid };
}
/** New start / end for a length factor about the pivot (start: end moves; end: start moves; else both). */
function scaledAxis(rec0, k, pivot) {
  const f = M.wallFrame(rec0), L = f.L * k;
  if (pivot === 'start') return [f.s, M.at(f, L)];
  if (pivot === 'end') return [M.at(f, f.L - L), f.e];
  return [M.at(f, (f.L - L) / 2), M.at(f, (f.L + L) / 2)];
}
/** New centre offset and thickness for a thickness factor (faceL / faceR keep that face in place). */
function scaledThickness(th0, k, pivot) {
  const th = Math.max(th0 * k, 0.01), h0 = th0 / 2;
  const c = pivot === 'faceL' ? h0 - th / 2 : pivot === 'faceR' ? -h0 + th / 2 : 0;
  return { th, c };
}

export const wallXf = {
  frame: (rec) => axisFrame(rec, rec.base_z, rec.top_z, rec.thickness / 2),
  axes: { translate: ['u', 'n', 'z'], rotate: ['z'], scale: ['u', 'n', 'z'] },
  pivots: ['mid', 'start', 'end', 'faceL', 'faceR'],
  translate(r0, d) {
    const fields = { 'axis.start': add(r0.axis.start, d), 'axis.end': add(r0.axis.end, d) };
    if (Math.abs(d[2]) > 1e-9) {                            // up / down: base, top and a sloped top move together
      fields.base_z = mm(r0.base_z + d[2]); fields.top_z = M.r4(fields.base_z + (r0.top_z - r0.base_z));
      if (r0.top_profile) fields.top_profile = { ...r0.top_profile, z: r0.top_profile.z.map((z) => M.r4(fields.base_z + (z - r0.base_z))) };
    }
    return fields;
  },
  /** Hosted openings keep their height above the wall's base when it moves up / down (sill moves, size exact). */
  translateDeps(r0, d, deps0) {
    if (Math.abs(d[2]) <= 1e-9) return {};
    const dz = mm(r0.base_z + d[2]) - r0.base_z, out = {};
    for (const o of deps0 || []) {
      if (o.host_wall !== r0.id) continue;
      const z0 = M.r4(o.sill_z + dz);
      out[o.id] = { sill_z: z0, head_z: M.r4(z0 + (o.head_z - o.sill_z)) };
    }
    return out;
  },
  rotate: (r0, a, c) => ({ 'axis.start': r2(rot(r0.axis.start, c, a)), 'axis.end': r2(rot(r0.axis.end, c, a)) }),
  scale(r0, k, pivot, deps0) {
    const fields = {}, deps = {};
    let s = r0.axis.start, e = r0.axis.end;
    if (k.u !== undefined && Math.abs(k.u - 1) > 1e-9) {
      [s, e] = scaledAxis(r0, Math.max(k.u, 0.02), pivot);
      // hosted openings keep their place in the world: shift their u by how far the start moved along the wall
      const f0 = M.wallFrame(r0), du = (s[0] - f0.s[0]) * f0.t[0] + (s[1] - f0.s[1]) * f0.t[1];
      const L = M.wallFrame({ axis: { start: s, end: e } }).L;
      for (const o of deps0 || []) {
        if (o.host_wall !== r0.id) continue;
        const w = o.position.u_end - o.position.u_start;
        const u0 = clamp(o.position.u_start - du, 0, Math.max(L - w, 0));
        deps[o.id] = { 'position.u_start': mm(u0), 'position.u_end': mm(u0 + w) };
      }
    }
    if (k.n !== undefined && Math.abs(k.n - 1) > 1e-9) {
      const { th, c } = scaledThickness(r0.thickness, k.n, pivot);
      const f = M.wallFrame({ axis: { start: s, end: e } });
      s = M.at(f, 0, c); e = M.at(f, f.L, c);
      fields.thickness = mm(th);
    }
    fields['axis.start'] = r2(s); fields['axis.end'] = r2(e);
    if (k.z !== undefined && Math.abs(k.z - 1) > 1e-9) {
      const kz = Math.max(k.z, 0.05), b = r0.base_z;
      if (pivot === 'top') fields.base_z = mm(r0.top_z - (r0.top_z - b) * kz);          // bottom face: the top stays
      else {
        fields.top_z = mm(b + (r0.top_z - b) * kz);
        if (r0.top_profile) fields.top_profile = { ...r0.top_profile, z: r0.top_profile.z.map((z) => mm(b + (z - b) * kz)) };
      }
    }
    return { fields, deps };
  },
  snapPoints: (rec) => [rec.axis.start, rec.axis.end],
  faces: [{ face: 'u+', pivot: 'start' }, { face: 'u-', pivot: 'end' }, { face: 'n+', pivot: 'faceR' }, { face: 'n-', pivot: 'faceL' },
    { face: 'z+', pivot: 'mid' }, { face: 'z-', pivot: 'top' }],
  extent: (r, a) => (a === 'u' ? M.wallFrame(r).L : a === 'n' ? r.thickness : r.top_z - r.base_z),
};

export const screenXf = {
  frame: (rec) => axisFrame(rec, rec.base_z, rec.top_z, rec.thickness / 2),
  axes: { translate: ['u', 'n', 'z'], rotate: ['z'], scale: ['u', 'n', 'z'] },
  pivots: ['mid', 'start', 'end', 'faceL', 'faceR'],
  translate: (r0, d) => ({ 'axis.start': add(r0.axis.start, d), 'axis.end': add(r0.axis.end, d), base_z: addZ(r0.base_z, d[2]), top_z: addZ(r0.top_z, d[2]) }),
  rotate: (r0, a, c) => ({ 'axis.start': r2(rot(r0.axis.start, c, a)), 'axis.end': r2(rot(r0.axis.end, c, a)) }),
  scale(r0, k, pivot) {
    let [s, e] = k.u !== undefined && Math.abs(k.u - 1) > 1e-9 ? scaledAxis(r0, Math.max(k.u, 0.02), pivot) : [r0.axis.start, r0.axis.end];
    const fields = {};
    if (k.n !== undefined && Math.abs(k.n - 1) > 1e-9) {
      const { th, c } = scaledThickness(r0.thickness, k.n, pivot), f = M.wallFrame({ axis: { start: s, end: e } });
      s = M.at(f, 0, c); e = M.at(f, f.L, c); fields.thickness = mm(th);
    }
    fields['axis.start'] = r2(s); fields['axis.end'] = r2(e);
    if (k.z !== undefined && Math.abs(k.z - 1) > 1e-9) {
      const kz = Math.max(k.z, 0.05);
      if (pivot === 'top') fields.base_z = mm(r0.top_z - (r0.top_z - r0.base_z) * kz);
      else fields.top_z = mm(r0.base_z + (r0.top_z - r0.base_z) * kz);
    }
    return { fields, deps: {} };
  },
  snapPoints: (rec) => [rec.axis.start, rec.axis.end],
  faces: [{ face: 'u+', pivot: 'start' }, { face: 'u-', pivot: 'end' }, { face: 'n+', pivot: 'faceR' }, { face: 'n-', pivot: 'faceL' },
    { face: 'z+', pivot: 'mid' }, { face: 'z-', pivot: 'top' }],
  extent: (r, a) => (a === 'u' ? M.wallFrame(r).L : a === 'n' ? r.thickness : r.top_z - r.base_z),
};

// ------------------------------------------------------------------ openings (in a straight host wall)
const arcHost = (r) => { const w = recOf(r.host_wall); return w && w.shape === 'arc' ? w : null; };
/** An opening in a round wall: angles, the tangent at its middle, a point at the wall's mean radius. */
function arcOpening(r, w) {
  const A = w.arc, P = r.position, span = M.relDeg(P.theta_end, P.theta_start), mid = P.theta_start + span / 2;
  const tan = (mid + 90) * M.DEG;
  return { A, span, mid, t: [Math.cos(tan), Math.sin(tan)], at: (th, z) => [...M.arcPoint(A, th, A.radius_axis), z] };
}
export const openingXf = {
  frame(rec) {
    const aw = arcHost(rec);
    if (aw) {
      const o = arcOpening(rec, aw), zm = (rec.sill_z + rec.head_z) / 2, P = rec.position;
      const pivots = { center: o.at(o.mid, zm), j0: o.at(P.theta_start, rec.sill_z), j1: o.at(P.theta_end, rec.sill_z), sill: o.at(o.mid, rec.sill_z), head: o.at(o.mid, rec.head_z) };
      return { angle: Math.atan2(o.t[1], o.t[0]), pivots, center: pivots.center };
    }
    const w = recOf(rec.host_wall), f = M.wallFrame(w), P = rec.position;
    const um = (P.u_start + P.u_end) / 2, zm = (rec.sill_z + rec.head_z) / 2;
    const pt = (u, z) => [...M.at(f, u), z];
    const pivots = { center: pt(um, zm), j0: pt(P.u_start, rec.sill_z), j1: pt(P.u_end, rec.sill_z), sill: pt(um, rec.sill_z), head: pt(um, rec.head_z) };
    return { angle: Math.atan2(f.t[1], f.t[0]), pivots, center: pivots.center };
  },
  axes: { translate: ['u', 'z'], rotate: [], scale: ['u', 'z'] },
  pivots: ['center', 'j0', 'j1', 'sill', 'head'],
  /** Raw (unclamped) move along the current host wall; transform.js clamps it or re-hosts the opening. */
  translate(r0, d) {
    const aw = arcHost(r0);
    if (aw) {                                               // round wall: along the arc by angle (the size in degrees kept)
      const o = arcOpening(r0, aw), dth = ((d[0] * o.t[0] + d[1] * o.t[1]) / o.A.radius_axis) / M.DEG;
      const z0 = Math.abs(d[2]) > 1e-9 ? mm(r0.sill_z + d[2]) : r0.sill_z;
      const out = { sill_z: z0, head_z: z0 === r0.sill_z ? r0.head_z : M.r4(z0 + (r0.head_z - r0.sill_z)) };
      if (Math.abs(dth) > 1e-9) { out['position.theta_start'] = M.normDeg(r0.position.theta_start + dth); out['position.theta_end'] = M.normDeg(r0.position.theta_start + dth + o.span); }
      return out;
    }
    // round the position once and keep the size exactly (a move must not change width or height)
    const f = M.wallFrame(recOf(r0.host_wall)), du = d[0] * f.t[0] + d[1] * f.t[1];
    const u0 = Math.abs(du) > 1e-12 ? mm(r0.position.u_start + du) : r0.position.u_start, z0 = Math.abs(d[2]) > 1e-9 ? mm(r0.sill_z + d[2]) : r0.sill_z;
    return { 'position.u_start': u0, 'position.u_end': u0 === r0.position.u_start ? r0.position.u_end : M.r4(u0 + (r0.position.u_end - r0.position.u_start)),
      sill_z: z0, head_z: z0 === r0.sill_z ? r0.head_z : M.r4(z0 + (r0.head_z - r0.sill_z)) };
  },
  scale(r0, k, pivot) {
    const fields = {};
    const aw = arcHost(r0);
    if (aw && k.u !== undefined && Math.abs(k.u - 1) > 1e-9) {                 // round wall: the angular span
      const o = arcOpening(r0, aw), P = r0.position, sp = Math.max(o.span * k.u, (0.05 / o.A.radius_axis) / M.DEG);
      const [a, b] = pivot === 'j0' ? [P.theta_start, P.theta_start + sp] : pivot === 'j1' ? [P.theta_start + o.span - sp, P.theta_start + o.span] : [o.mid - sp / 2, o.mid + sp / 2];
      fields['position.theta_start'] = M.normDeg(a); fields['position.theta_end'] = M.normDeg(b);
    } else if (k.u !== undefined && Math.abs(k.u - 1) > 1e-9) {
      const P = r0.position, w = Math.max((P.u_end - P.u_start) * k.u, 0.05), c = (P.u_start + P.u_end) / 2;
      const [a, b] = pivot === 'j0' ? [P.u_start, P.u_start + w] : pivot === 'j1' ? [P.u_end - w, P.u_end] : [c - w / 2, c + w / 2];
      fields['position.u_start'] = mm(a); fields['position.u_end'] = mm(b);
    }
    if (k.z !== undefined && Math.abs(k.z - 1) > 1e-9) {
      const h = Math.max((r0.head_z - r0.sill_z) * k.z, 0.05), zc = (r0.sill_z + r0.head_z) / 2;
      const [a, b] = pivot === 'head' ? [r0.head_z - h, r0.head_z] : pivot === 'center' ? [zc - h / 2, zc + h / 2] : [r0.sill_z, r0.sill_z + h];
      fields.sill_z = mm(a); fields.head_z = mm(b);
    }
    return { fields, deps: {} };
  },
  faces: [{ face: 'u+', pivot: 'j0' }, { face: 'u-', pivot: 'j1' }, { face: 'z+', pivot: 'sill' }, { face: 'z-', pivot: 'head' }],
  extent(r, a) {
    if (a !== 'u') return r.head_z - r.sill_z;
    const aw = arcHost(r);
    return aw ? aw.arc.radius_axis * M.relDeg(r.position.theta_end, r.position.theta_start) * M.DEG : r.position.u_end - r.position.u_start;
  },
};

// ------------------------------------------------------------------ round walls (shape 'arc')
const ARC_FACES = [{ face: 'u+', pivot: 'radius', arc: true }, { face: 'n+', pivot: 'inner', arc: true }, { face: 'n-', pivot: 'outer', arc: true },
  { face: 'z+', pivot: 'mid', arc: true }, { face: 'z-', pivot: 'top', arc: true }];
export const arcWallXf = {
  frame(rec) {
    const c = [...rec.arc.center, zHandle(rec.base_z, rec.top_z)];
    return { angle: 0, pivots: { center: c }, center: c };
  },
  translate(r0, d) {
    const out = { 'arc.center': add(r0.arc.center, d) };
    if (Math.abs(d[2]) > 1e-9) { out.base_z = mm(r0.base_z + d[2]); out.top_z = M.r4(out.base_z + (r0.top_z - r0.base_z)); }
    return out;
  },
  /** Turning about the vertical turns the ring and its openings (their angles) with it. */
  rotate: (r0, a, c) => ({ 'arc.center': r2(rot(r0.arc.center, c, a)), 'arc.start_angle_deg': M.normDeg(r0.arc.start_angle_deg + a / M.DEG) }),
  rotateDeps(r0, a, c, axis, deps0) {
    const out = {};
    for (const o of deps0 || []) {
      if (o.host_wall !== r0.id) continue;
      out[o.id] = { 'position.theta_start': M.normDeg(o.position.theta_start + a / M.DEG), 'position.theta_end': M.normDeg(o.position.theta_end + a / M.DEG) };
    }
    return out;
  },
  /** u: the radius (thickness kept); n: the thickness, about the inner face, the outer face or both; z: height. */
  scale(r0, k, pivot) {
    const A = r0.arc, th = A.r_outer - A.r_inner, fields = {};
    if (k.u !== undefined && Math.abs(k.u - 1) > 1e-9) {
      const r = Math.max(A.radius_axis * k.u, th / 2 + 0.05);
      fields['arc.r_inner'] = M.r4(r - th / 2); fields['arc.r_outer'] = M.r4(r + th / 2);
    }
    if (k.n !== undefined && Math.abs(k.n - 1) > 1e-9) {
      const t = Math.max(th * k.n, 0.01);
      if (pivot === 'inner') fields['arc.r_outer'] = M.r4(A.r_inner + t);
      else if (pivot === 'outer') fields['arc.r_inner'] = M.r4(A.r_outer - t);
      else { fields['arc.r_inner'] = M.r4(A.radius_axis - t / 2); fields['arc.r_outer'] = M.r4(A.radius_axis + t / 2); }
    }
    if (k.z !== undefined && Math.abs(k.z - 1) > 1e-9) {
      const kz = Math.max(k.z, 0.05);
      if (pivot === 'top') fields.base_z = mm(r0.top_z - (r0.top_z - r0.base_z) * kz);
      else fields.top_z = mm(r0.base_z + (r0.top_z - r0.base_z) * kz);
    }
    return { fields, deps: {} };
  },
  extent: (r, a) => (a === 'u' ? r.arc.radius_axis : a === 'n' ? r.arc.r_outer - r.arc.r_inner : r.top_z - r.base_z),
  snapPoints: (rec) => [rec.arc.center],
};
/** Walls: straight (wallXf) or round (arcWallXf), chosen per record. */
const isArcRec = (r) => r && r.shape === 'arc';
export const anyWallXf = {
  axes: wallXf.axes,
  pivots: [...wallXf.pivots, 'center'],
  faces: [...wallXf.faces, ...ARC_FACES],
  frame: (r) => (isArcRec(r) ? arcWallXf : wallXf).frame(r),
  translate: (r, d) => (isArcRec(r) ? arcWallXf : wallXf).translate(r, d),
  translateDeps: (r, d, deps) => wallXf.translateDeps(r, d, deps),            // openings keep their height above the base
  rotate: (r, a, c, ax, n) => (isArcRec(r) ? arcWallXf : wallXf).rotate(r, a, c, ax, n),
  rotateDeps: (r, a, c, ax, deps) => (isArcRec(r) ? arcWallXf.rotateDeps(r, a, c, ax, deps) : {}),
  scale: (r, k, p, deps) => (isArcRec(r) ? arcWallXf : wallXf).scale(r, k, p, deps),
  extent: (r, a) => (isArcRec(r) ? arcWallXf : wallXf).extent(r, a),
  snapPoints: (r) => (isArcRec(r) ? arcWallXf : wallXf).snapPoints(r),
};

// ------------------------------------------------------------------ plan polygons (columns, bulkheads, built-ins)
/** Adapter for a polygon element; `zKeys` = [bottom, top] field names; `zExtra(r0, dz)` moves other heights too. */
function polygonXf(polyKey, zKeys, zExtra = () => ({})) {
  return {
    frame(rec) {
      const c = centroid(rec[polyKey]);
      const z = zHandle(rec[zKeys[0]], rec[zKeys[1]]);
      return { angle: longestEdgeAngle(rec[polyKey]), pivots: { center: [...c, z] }, center: [...c, z] };
    },
    axes: { translate: ['u', 'n', 'z'], rotate: ['z'], scale: ['u', 'n', 'z'] },
    pivots: ['center'],
    translate: (r0, d) => ({ [polyKey]: r0[polyKey].map((p) => add(p, d)), [zKeys[0]]: addZ(r0[zKeys[0]], d[2]), [zKeys[1]]: addZ(r0[zKeys[1]], d[2]), ...zExtra(r0, d[2]) }),
    rotate: (r0, a, c) => ({ [polyKey]: r0[polyKey].map((p) => r2(rot(p, c, a))) }),
    scale(r0, k, pivot = 'center') {
      const poly = r0[polyKey], c = centroid(poly), a = longestEdgeAngle(poly), ku = k.u ?? 1, kn = k.n ?? 1;
      const fields = {};
      if (Math.abs(ku - 1) > 1e-9 || Math.abs(kn - 1) > 1e-9) {
        // the fixed line: the centre, or the opposite face of the local bounding box (PowerPoint-style handles)
        const box = localBox(poly, c, a);
        const au = pivot === 'u-' ? box.u[0] : pivot === 'u+' ? box.u[1] : 0, an = pivot === 'n-' ? box.n[0] : pivot === 'n+' ? box.n[1] : 0;
        fields[polyKey] = poly.map((p) => {
          const q = rot(p, c, -a);                           // into the local frame
          const u = q[0] - c[0], n = q[1] - c[1];
          return r2(rot([c[0] + au + (u - au) * Math.max(ku, 0.02), c[1] + an + (n - an) * Math.max(kn, 0.02)], c, a));
        });
      }
      if (k.z !== undefined && Math.abs(k.z - 1) > 1e-9) {
        const z0 = r0[zKeys[0]], z1 = r0[zKeys[1]], kz = Math.max(k.z, 0.05);
        if (pivot === 'z+') fields[zKeys[0]] = mm(z1 - (z1 - z0) * kz); else fields[zKeys[1]] = mm(z0 + (z1 - z0) * kz);
      }
      return { fields, deps: {} };
    },
    snapPoints: (rec) => rec[polyKey],
    faces: [{ face: 'u+', pivot: 'u-' }, { face: 'u-', pivot: 'u+' }, { face: 'n+', pivot: 'n-' }, { face: 'n-', pivot: 'n+' },
      { face: 'z+', pivot: 'z-' }, { face: 'z-', pivot: 'z+' }],
    extent(r, ax) {
      if (ax === 'z') return r[zKeys[1]] - r[zKeys[0]];
      const poly = r[polyKey], b = localBox(poly, centroid(poly), longestEdgeAngle(poly));
      return ax === 'u' ? b.u[1] - b.u[0] : b.n[1] - b.n[0];
    },
  };
}
/** Bounding box of a polygon in the frame turned by `a` about `c` (offsets from c). */
function localBox(poly, c, a) {
  const u = [Infinity, -Infinity], n = [Infinity, -Infinity];
  for (const p of poly) {
    const q = rot(p, c, -a);
    u[0] = Math.min(u[0], q[0] - c[0]); u[1] = Math.max(u[1], q[0] - c[0]);
    n[0] = Math.min(n[0], q[1] - c[1]); n[1] = Math.max(n[1], q[1] - c[1]);
  }
  return { u, n };
}
export const columnXf = polygonXf('footprint', ['base_z', 'top_z']);
export const bulkheadXf = polygonXf('footprint', ['bottom_z', 'top_z']);
export const builtinXf = polygonXf('polygon', ['base_z', 'top_z'],
  (r0, dz) => (r0.basin && r0.basin.water_z != null && Math.abs(dz) > 1e-12 ? { basin: { ...r0.basin, water_z: mm(r0.basin.water_z + dz) } } : {}));

// ------------------------------------------------------------------ beams (flat: 2D axis; rafters: 3D axis)
export const beamXf = {
  frame(rec) {
    const a = rec.axis.start, b = rec.axis.end;
    const z = rec.bottom_z, mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const za = a.length === 3 ? a[2] : z, zb = b.length === 3 ? b[2] : z;
    const pivots = { mid: [...mid, (za + zb) / 2], start: [a[0], a[1], za], end: [b[0], b[1], zb] };
    return { angle: Math.atan2(b[1] - a[1], b[0] - a[0]), pivots, center: pivots.mid };
  },
  axes: { translate: ['u', 'n', 'z'], rotate: ['z', 'n'], scale: ['u', 'n', 'z'] },   // n: pitch (one end up)
  pivots: ['mid', 'start', 'end'],
  translate(r0, d) {
    const mv = (p) => (p.length === 3 ? [...add(p, d), addZ(p[2], d[2])] : add(p, d));
    return { axis: { ...r0.axis, start: mv(r0.axis.start), end: mv(r0.axis.end) }, bottom_z: addZ(r0.bottom_z, d[2]), top_z: addZ(r0.top_z, d[2]) };
  },
  rotate(r0, a, c, axis) {
    if (isVertical(axis)) {
      const rt = (p) => { const q = r2(rot(p, c, a)); return p.length === 3 ? [...q, p[2]] : q; };
      return { axis: { ...r0.axis, start: rt(r0.axis.start), end: rt(r0.axis.end) } };
    }
    // tilt: both ends turn in 3D (a flat beam becomes one with a 3D axis: its underside centre line)
    const p3 = (p) => (p.length === 3 ? p : [p[0], p[1], r0.bottom_z]);
    const s = rot3(p3(r0.axis.start), c, axis, a).map(M.r4), e = rot3(p3(r0.axis.end), c, axis, a).map(M.r4);
    const L = Math.hypot(e[0] - s[0], e[1] - s[1], e[2] - s[2]), H = Math.hypot(e[0] - s[0], e[1] - s[1]);
    const slope = Math.atan2(Math.abs(e[2] - s[2]), H);
    return { axis: { ...r0.axis, start: s, end: e, length: M.r4(L), reference: r0.axis.reference || 'underside centre line' },
      bottom_z: mm(Math.min(s[2], e[2])), top_z: mm(Math.max(s[2], e[2]) + r0.depth / Math.max(Math.cos(slope), 0.05)),
      slope_deg: +((slope * 180) / Math.PI).toFixed(2) };
  },
  scale(r0, k, pivot = 'mid') {
    const fields = {}, flat = r0.axis.start.length !== 3;
    let s = r0.axis.start, e = r0.axis.end;
    if (flat && k.u !== undefined && Math.abs(k.u - 1) > 1e-9) {              // length: the other end stays
      [s, e] = scaledAxis(r0, Math.max(k.u, 0.02), pivot === 'u-' ? 'start' : pivot === 'u+' ? 'end' : 'mid');
    }
    if (k.n !== undefined && Math.abs(k.n - 1) > 1e-9) {
      const w = Math.max(r0.width * k.n, 0.01);
      fields.width = mm(w);
      if (flat && (pivot === 'n-' || pivot === 'n+')) {                     // one side stays: the axis moves by half
        const f = M.wallFrame({ axis: { start: s, end: e } }), sh = (pivot === 'n-' ? 1 : -1) * (w - r0.width) / 2;
        s = M.at(f, 0, sh); e = M.at(f, f.L, sh);
      }
    }
    if (flat && (s !== r0.axis.start || e !== r0.axis.end)) fields.axis = { ...r0.axis, start: r2(s), end: r2(e) };
    if (k.z !== undefined && Math.abs(k.z - 1) > 1e-9) {
      fields.depth = mm(Math.max(r0.depth * k.z, 0.01));
      if (!flat) fields.top_z = mm(r0.top_z + fields.depth - r0.depth);
      else if (pivot === 'z+') fields.bottom_z = mm(r0.top_z - fields.depth);     // bottom face: the top stays
      else fields.top_z = mm(r0.bottom_z + fields.depth);
    }
    return { fields, deps: {} };
  },
  faces: [{ face: 'u+', pivot: 'u-', flat: true }, { face: 'u-', pivot: 'u+', flat: true }, { face: 'n+', pivot: 'n-' }, { face: 'n-', pivot: 'n+' },
    { face: 'z+', pivot: 'z-' }, { face: 'z-', pivot: 'z+' }],
  extent: (r, a) => (a === 'u' ? Math.hypot(r.axis.end[0] - r.axis.start[0], r.axis.end[1] - r.axis.start[1]) : a === 'n' ? r.width : r.depth),
  snapPoints: (rec) => [rec.axis.start.slice(0, 2), rec.axis.end.slice(0, 2)],
};

// ------------------------------------------------------------------ stairs (every plan point and height moves rigidly)
/** A stair record with every plan point mapped by fp, every height by fz, every direction by fd (and angles by fa). */
function mapStair(r0, fp, fz, fd = (d) => d, fa = (x) => x) {
  const P = (p) => r2(fp(p));
  const flights = (r0.flights || []).map((f) => {
    const g = M.clone(f);
    if (g.start) g.start = P(g.start);
    if (g.center) g.center = P(g.center);
    if (g.dir) g.dir = fd(g.dir).map(M.r4);
    if (g.start_angle != null) g.start_angle = M.r4(fa(g.start_angle));
    if (g.bottom_z != null) g.bottom_z = fz(g.bottom_z);
    if (g.derived) { if (g.derived.bottom_z != null) g.derived.bottom_z = fz(g.derived.bottom_z); if (g.derived.top_z != null) g.derived.top_z = fz(g.derived.top_z); }
    for (const t of g.tread_geometry || []) { t.polygon = t.polygon.map(P); t.z = fz(t.z); }
    for (const rr of g.riser_geometry || []) { rr.line = rr.line.map(P); rr.z = rr.z.map(fz); }
    return g;
  });
  const landings = (r0.landings || []).map((l) => ({ ...M.clone(l), polygon: l.polygon.map(P), z: fz(l.z) }));
  return { flights, landings, bottom_z: fz(r0.bottom_z), top_z: fz(r0.top_z) };
}
const stairPoints = (r) => [...(r.flights || []).flatMap((f) => (f.tread_geometry || []).flatMap((t) => t.polygon)), ...(r.landings || []).flatMap((l) => l.polygon)];
export const stairXf = {
  frame(rec) {
    const pts = stairPoints(rec);
    const m = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length], [0, 0]);
    const d = (rec.flights || [])[0]?.dir || [1, 0];
    const z = ((rec.bottom_z ?? 0) + (rec.top_z ?? 0)) / 2;
    return { angle: Math.atan2(d[1], d[0]), pivots: { center: [...m, z] }, center: [...m, z] };
  },
  axes: { translate: ['u', 'n', 'z'], rotate: ['z'], scale: [] },
  pivots: ['center'],
  translate: (r0, d) => mapStair(r0, (p) => [p[0] + d[0], p[1] + d[1]], (z) => (z == null ? z : addZ(z, d[2]))),
  rotate: (r0, a, c) => {
    const { flights, landings } = mapStair(r0, (p) => rot(p, c, a), (z) => z, (v) => rot(v, [0, 0], a), (x) => x + (a * 180) / Math.PI);
    return { flights, landings };
  },
  snapPoints: (rec) => stairPoints(rec),
};

// ------------------------------------------------------------------ polylines (railings, separators) and skylights
function polylineXf(key, zKeys = []) {
  return {
    frame(rec) {
      const p = rec[key], a = p[0], b = p[p.length - 1];
      const m = p.reduce((s, q) => [s[0] + q[0] / p.length, s[1] + q[1] / p.length], [0, 0]);
      const z = zKeys.length ? (rec[zKeys[0]] + rec[zKeys[1]]) / 2 : 0;
      return { angle: Math.atan2(b[1] - a[1], b[0] - a[0]), pivots: { center: [...m, z] }, center: [...m, z] };
    },
    axes: { translate: zKeys.length ? ['u', 'n', 'z'] : ['u', 'n'], rotate: ['z'], scale: [] },
    pivots: ['center'],
    translate: (r0, d) => {
      const out = { [key]: r0[key].map((p) => add(p, d)) };
      for (const k of zKeys) if (r0[k] != null) out[k] = addZ(r0[k], d[2]);
      if (r0.base_z_along_path) out.base_z_along_path = r0.base_z_along_path.map((z) => addZ(z, d[2]));
      return out;
    },
    rotate: (r0, a, c) => ({ [key]: r0[key].map((p) => r2(rot(p, c, a))) }),
    snapPoints: (rec) => rec[key],
  };
}
export const railingXf = polylineXf('path', ['base_z', 'top_z']);
export const separatorXf = polylineXf('line');
export const skylightXf = {
  frame(rec) { const z = rec.ring ? rec.ring.z_bottom : (rec.glazing?.z ?? 0); return { angle: 0, pivots: { center: [...rec.center, z] }, center: [...rec.center, z] }; },
  axes: { translate: ['u', 'n', 'z'], rotate: [], scale: [] },
  pivots: ['center'],
  translate(r0, d) {
    const out = { center: add(r0.center, d) };
    if (Math.abs(d[2]) > 1e-12) {
      if (r0.ring) out.ring = { ...r0.ring, z_bottom: addZ(r0.ring.z_bottom, d[2]), z_top: addZ(r0.ring.z_top, d[2]) };
      if (r0.glazing && r0.glazing.z != null) out.glazing = { ...r0.glazing, z: addZ(r0.glazing.z, d[2]) };
    }
    return out;
  },
  snapPoints: (rec) => [rec.center],
};

// ------------------------------------------------------------------ floors (a plan outline at a height, or on a plane)
const floorPlane = (r) => (r.modeled_as === 'plane' && r.measured_plane ? { n: r.measured_plane.slice(0, 3), d: r.measured_plane[3] }
  : { n: [0, 0, 1], d: r.z });
export const floorXf = {
  frame(rec) {
    const c = centroid(rec.polygon), P = floorPlane(rec), z = (P.d - P.n[0] * c[0] - P.n[1] * c[1]) / P.n[2];
    return { angle: longestEdgeAngle(rec.polygon), pivots: { center: [...c, z] }, center: [...c, z] };
  },
  // tilting needs the floor stored as a plane (modeled_as 'plane', measured_plane [nx, ny, nz, d] with n·p = d)
  axes: { translate: ['u', 'n', 'z'], rotate: ['z', 'u', 'n'], scale: [] },
  pivots: ['center'],
  translate(r0, d) {
    const out = { polygon: r0.polygon.map((p) => add(p, d)) };
    if (r0.holes) out.holes = r0.holes.map((h) => h.map((p) => add(p, d)));
    if (Math.abs(d[2]) > 1e-12 && r0.z != null) out.z = addZ(r0.z, d[2]);
    if (r0.measured_plane && (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) > 1e-12)) {
      const [nx, ny, nz, dd] = r0.measured_plane;
      out.measured_plane = [nx, ny, nz, +(dd + nx * d[0] + ny * d[1] + nz * d[2]).toFixed(5)];
    }
    return out;
  },
  rotate(r0, a, c, axis) {
    const P = floorPlane(r0), out = {};
    const d0 = P.d - (P.n[0] * c[0] + P.n[1] * c[1] + P.n[2] * c[2]);          // the pivot's offset from the plane
    const n = rot3(P.n, [0, 0, 0], axis || [0, 0, 1], a);
    if (isVertical(axis)) {
      out.polygon = r0.polygon.map((p) => r2(rot(p, c, a)));
      if (r0.holes) out.holes = r0.holes.map((h) => h.map((p) => r2(rot(p, c, a))));
      if (r0.modeled_as !== 'plane' || !r0.measured_plane) return out;                // a level floor stays level
    } else out.modeled_as = 'plane';
    out.measured_plane = [...n.map((x) => +x.toFixed(5)), +(n[0] * c[0] + n[1] * c[1] + n[2] * c[2] + d0).toFixed(5)];
    out.z = mm(c[2]);
    return out;
  },
  snapPoints: (rec) => rec.polygon,
};

// ------------------------------------------------------------------ ceilings (a set of patches: flat, sloped plane, cone)
/** A patch's surface as a plane n·p = d (flat or sloped), or null for a cone. */
function patchPlane(p) {
  if (p.modeled_as === 'cone' && p.cone) return null;
  if (p.plane && p.plane.z_of_xy) { const [a, b, c] = p.plane.z_of_xy; return { n: [-a, -b, 1], d: c }; }
  return { n: [0, 0, 1], d: p.z };
}
/** A plane n·p = d as z = a·x + b·y + c. */
const zOfXY = (n, d) => [-n[0] / n[2], -n[1] / n[2], d / n[2]].map((x) => +x.toFixed(6));
/** Rotate a plane about the axis k through point C by angle a. */
function turnPlane(P, C, k, a) {
  const n = rot3(P.n, [0, 0, 0], k, a), off = P.d - (P.n[0] * C[0] + P.n[1] * C[1] + P.n[2] * C[2]);
  return { n, d: n[0] * C[0] + n[1] * C[1] + n[2] * C[2] + off };
}
const ringArea = (p) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
const largestPatch = (rec) => (rec.patches || []).filter((p) => p.polygon && p.polygon.length > 2)
  .reduce((a, p) => (!a || ringArea(p.polygon) > ringArea(a.polygon) ? p : a), null);
const ringMean = (poly) => poly.reduce((s, q) => [s[0] + q[0] / poly.length, s[1] + q[1] / poly.length], [0, 0]);
/** Every patch mapped: plan points by fp, and its surface by fs(patch) -> fields to set on the patch. */
const mapPatches = (r0, fp, fs) => (r0.patches || []).map((p) => {
  const q = M.clone(p);
  if (q.polygon) q.polygon = q.polygon.map(fp);
  if (q.holes) q.holes = q.holes.map((h) => h.map(fp));
  return Object.assign(q, fs(p, q));
});
export const ceilingXf = {
  frame(rec) {
    const big = largestPatch(rec);                          // the frame of the largest patch
    const c = big ? ringMean(big.polygon) : [0, 0];
    const z = rec.main_z ?? (big && typeof big.z === 'number' ? big.z : 0);
    return { angle: big ? longestEdgeAngle(big.polygon) : 0, pivots: { center: [...c, z] }, center: [...c, z] };
  },
  // tilting turns flat and sloped patches into sloped planes; cone patches keep their (vertical) cone
  axes: { translate: ['u', 'n', 'z'], rotate: ['z', 'u', 'n'], scale: [] },
  pivots: ['center'],
  translate(r0, d) {
    const dz = d[2], moved = Math.abs(dz) > 1e-12;
    const patches = mapPatches(r0, (p) => add(p, d), (p) => {
      const out = {};
      if (typeof p.z === 'number' && moved) out.z = mm(p.z + dz);
      if (p.z_range && moved) out.z_range = p.z_range.map((z) => mm(z + dz));
      if (p.plane && p.plane.z_of_xy) { const [a, b, c] = p.plane.z_of_xy; out.plane = { ...p.plane, z_of_xy: [a, b, +(c + dz - a * d[0] - b * d[1]).toFixed(6)] }; }
      if (p.modeled_as === 'cone' && p.cone) out.cone = { ...p.cone, apex: [mm(p.cone.apex[0] + d[0]), mm(p.cone.apex[1] + d[1]), mm(p.cone.apex[2] + dz)] };
      if (Array.isArray(p.measured_plane)) { const [nx, ny, nz, dd] = p.measured_plane; out.measured_plane = [nx, ny, nz, +(dd + nx * d[0] + ny * d[1] + nz * dz).toFixed(5)]; }
      return out;
    });
    const out = { patches };
    if (moved) {
      if (typeof r0.main_z === 'number') out.main_z = mm(r0.main_z + dz);
      if (r0.z_range) out.z_range = r0.z_range.map((z) => mm(z + dz));
      if (Array.isArray(r0.detected_heights)) out.detected_heights = r0.detected_heights.map((h) => ({ ...h, z: mm(h.z + dz) }));
    }
    return out;
  },
  rotate(r0, a, c, axis) {
    const vertical = isVertical(axis), k = axis || [0, 0, 1];
    const patches = mapPatches(r0, (p) => (vertical ? r2(rot(p, c, a)) : p), (p, q) => {
      const P = patchPlane(p), out = {};
      if (!P) {                                             // a cone: it can turn about the vertical, not tilt
        if (vertical) out.cone = { ...p.cone, apex: [...r2(rot(p.cone.apex, c, a)), p.cone.apex[2]] };
        return out;
      }
      const T = turnPlane(P, c, k, a);
      const flatStill = Math.abs(T.n[0]) < 1e-9 && Math.abs(T.n[1]) < 1e-9;
      if (!flatStill) {
        out.modeled_as = 'plane'; out.plane = { ...(p.plane || {}), z_of_xy: zOfXY(T.n, T.d), note: 'z = a*x + b*y + c' };
        const m = ringMean(q.polygon || [[c[0], c[1]]]);
        out.z = mm((T.d - T.n[0] * m[0] - T.n[1] * m[1]) / T.n[2]);
      }
      if (Array.isArray(p.measured_plane)) {
        const [nx, ny, nz, dd] = p.measured_plane, M2 = turnPlane({ n: [nx, ny, nz], d: dd }, c, k, a);
        out.measured_plane = [...M2.n.map((x) => +x.toFixed(5)), +M2.d.toFixed(5)];
      }
      return out;
    });
    return { patches };
  },
  /** The ceiling's bulkheads (in the edit as dependents) move and turn with it; they cannot tilt. */
  translateDeps: (r0, d, deps0) => Object.fromEntries((deps0 || []).filter((b) => b.footprint && b.bottom_z !== undefined).map((b) => [b.id, bulkheadXf.translate(b, d)])),
  rotateDeps: (r0, a, c, axis, deps0) => (isVertical(axis) ? Object.fromEntries((deps0 || []).filter((b) => b.footprint && b.bottom_z !== undefined).map((b) => [b.id, bulkheadXf.rotate(b, a, c)])) : {}),
  snapPoints(rec) {
    const ps = (rec.patches || []).filter((p) => p.polygon);
    const big = ps.sort((a, b) => b.polygon.length - a.polygon.length)[0];
    if (!big) return [];
    const step = Math.max(1, Math.ceil(big.polygon.length / 48));          // a cone's ring has hundreds of points
    return big.polygon.filter((_, i) => i % step === 0);
  },
};

/** Hosted openings of a wall as plain records (for the wall adapter's scale). */
export const hostedOf = (wallId) => openingsOf(wallId);
