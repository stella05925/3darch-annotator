// Annotation data model helpers: wall frames, derived fields, new elements.
// Conventions (claude_sandbox/docs/representation.md): metres, +Z up; a wall's axis is its centre line, `n` is the
// left normal of start→end; openings sit at u (distance along the axis from its start); footprint = axis ± thickness/2,
// extended past the axis ends by per-wall amounts (junctions), in the sandbox's vertex order
// [s+n·h, e+n·h, e−n·h, s−n·h] (left face first). Element types and their fields live in registry.js.

export const OPENING_TYPES = ['door', 'window', 'opening', 'interior_window'];
export const WALL_CATEGORIES = ['exterior', 'boundary', 'partition', 'glass_partition', 'header'];
export const CONFIDENCE = ['high', 'medium', 'low'];

export const r4 = (x) => Math.round(x * 1e4) / 1e4;
export const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

export function wallFrame(w) {
  const [sx, sy] = w.axis.start;
  const [ex, ey] = w.axis.end;
  const dx = ex - sx, dy = ey - sy;
  const L = Math.hypot(dx, dy) || 1e-9;
  const t = [dx / L, dy / L];
  return { s: [sx, sy], e: [ex, ey], L, t, n: [-t[1], t[0]] };
}
export const at = (f, u, v = 0) => [f.s[0] + f.t[0] * u + f.n[0] * v, f.s[1] + f.t[1] * u + f.n[1] * v];
export function uvOf(f, p) {
  const dx = p[0] - f.s[0], dy = p[1] - f.s[1];
  return [dx * f.t[0] + dy * f.t[1], dx * f.n[0] + dy * f.n[1]];
}

/** How far the footprint reaches past the axis start / end (junction extensions), read from the stored footprint. */
export function footprintExtents(w) {
  const f = wallFrame(w);
  let lo = 0, hi = f.L;
  for (const p of w.footprint || []) { const [u] = uvOf(f, p); lo = Math.min(lo, u); hi = Math.max(hi, u); }
  return [Math.max(0, -lo), Math.max(0, hi - f.L)];
}

export function topAt(w, u) {
  const tp = w.top_profile;
  if (!tp || !tp.u || tp.u.length < 2) return w.top_z;
  const U = tp.u, Z = tp.z;
  if (u <= U[0]) return Z[0];
  if (u >= U[U.length - 1]) return Z[Z.length - 1];
  for (let i = 1; i < U.length; i++) {
    if (u <= U[i]) { const k = (u - U[i - 1]) / Math.max(U[i] - U[i - 1], 1e-9); return Z[i - 1] + k * (Z[i] - Z[i - 1]); }
  }
  return Z[Z.length - 1];
}

/** Recompute a wall's derived fields after its axis, thickness or heights changed. */
export function updateWallDerived(w, ext) {
  const f = wallFrame(w), h = w.thickness / 2;
  if (!(Math.abs((w.axis.length ?? -1) - f.L) < 1.5e-4)) w.axis.length = r4(f.L);   // keep a stored length that still matches (rounding)
  if (w.top_profile && w.top_profile.z && w.top_profile.z.length) w.top_z = r4(Math.max(...w.top_profile.z));
  w.height = r4(w.top_z - w.base_z);
  const [es, ee] = ext || [0, 0];
  const p = (u, v) => at(f, u, v).map(r4);
  w.footprint = [p(-es, h), p(f.L + ee, h), p(f.L + ee, -h), p(-es, -h)];   // sandbox order: left face, then right
  const ns = f.n[0] * f.s[0] + f.n[1] * f.s[1];
  if (w.faces && w.faces.left) w.faces.left.plane = [r4(f.n[0]), r4(f.n[1]), 0, r4(ns + h)];
  if (w.faces && w.faces.right) w.faces.right.plane = [r4(-f.n[0]), r4(-f.n[1]), 0, r4(-ns + h)];
}

/**
 * A wall's two face lines in plan, from its axis and thickness: left = +n side, right = −n side, both running from
 * the axis start to its end (extended by the junction extensions `ext` when given). Same lines as footprint edges
 * 0→1 (left) and 3→2 (right).
 */
export function faceLines(w, ext = [0, 0]) {
  const f = wallFrame(w), h = w.thickness / 2;
  const line = (v) => [at(f, -ext[0], v), at(f, f.L + ext[1], v)];
  return { left: line(h), right: line(-h), normal: f.n };
}

/** Recompute an opening's derived fields from u_start/u_end, sill and head on its host wall. */
export function updateOpeningDerived(o, w) {
  const f = wallFrame(w);
  const p = o.position;
  p.width = r4(p.u_end - p.u_start);
  p.center = at(f, (p.u_start + p.u_end) / 2).map(r4);
  o.jamb_points = [at(f, p.u_start).map(r4), at(f, p.u_end).map(r4)];
  o.height = r4(o.head_z - o.sill_z);
}

// ------------------------------------------------------------------ round walls (shape 'arc': a ring sector)
// arc: {center, r_inner, r_outer, radius_axis, start_angle_deg, sweep_deg, closed}; angles in degrees counter-
// clockwise from +x. Openings in a round wall are placed by angle (position.theta_start / theta_end).
export const DEG = Math.PI / 180;
export const relDeg = (t, s) => (((t - s) % 360) + 360) % 360;
export const normDeg = (t) => r4(((t % 360) + 360) % 360);
export const arcPoint = (A, theta, r) => [A.center[0] + r * Math.cos(theta * DEG), A.center[1] + r * Math.sin(theta * DEG)];
/** Derived fields of a round wall from its arc: mean radius, thickness, axis ends and length, footprint ring. */
export function updateArcDerived(w) {
  const A = w.arc, sweep = A.sweep_deg ?? 360, closed = A.closed || sweep >= 360 - 1e-6;
  A.radius_axis = r4((A.r_inner + A.r_outer) / 2);
  w.thickness = r4(A.r_outer - A.r_inner);
  w.axis = { ...w.axis, start: arcPoint(A, A.start_angle_deg, A.radius_axis).map(r4), end: arcPoint(A, A.start_angle_deg + sweep, A.radius_axis).map(r4),
    length: r4(A.radius_axis * sweep * DEG) };
  w.height = r4(w.top_z - w.base_z);
  const n = Math.max(24, (w.footprint || []).length || 360), ring = (r, a0, a1, k) => Array.from({ length: k }, (_, i) => arcPoint(A, a0 + ((a1 - a0) * i) / (closed ? k : k - 1), r).map(r4));
  if (closed) {
    w.footprint = ring(A.r_outer, A.start_angle_deg, A.start_angle_deg + 360, n);                                // counter-clockwise
    w.footprint_holes = [ring(A.r_inner, A.start_angle_deg + 360, A.start_angle_deg, (w.footprint_holes?.[0]?.length) || n)];   // clockwise
  } else {
    const k = Math.max(8, Math.round(n / 2));
    w.footprint = [...ring(A.r_outer, A.start_angle_deg, A.start_angle_deg + sweep, k), ...ring(A.r_inner, A.start_angle_deg + sweep, A.start_angle_deg, k)];
  }
}
/** Derived fields of an opening in a round wall (u along the mean radius, chord width and centre on the inner face). */
export function updateArcOpeningDerived(o, w) {
  const A = w.arc, P = o.position, span = relDeg(P.theta_end, P.theta_start);
  P.u_start = r4(A.radius_axis * relDeg(P.theta_start, A.start_angle_deg) * DEG);
  P.u_end = r4(P.u_start + A.radius_axis * span * DEG);
  P.width = r4(2 * A.r_inner * Math.sin((span * DEG) / 2));
  P.center = arcPoint(A, P.theta_start + span / 2, A.r_inner * Math.cos((span * DEG) / 2)).map(r4);
  o.jamb_points = [arcPoint(A, P.theta_start, A.r_inner).map(r4), arcPoint(A, P.theta_end, A.r_inner).map(r4)];
  o.height = r4(o.head_z - o.sill_z);
}
/** A new opening in a round wall, centred on angle theta (degrees). */
export function newArcOpening(w, type, theta, tpl) {
  const A = w.arc, half = (tpl.width / 2 / A.r_inner) / DEG;
  const o = { id: `${w.level}-On${stamp()}`, type, name: null, host_wall: w.id, level: w.level, connects: [],
    position: { theta_start: normDeg(theta - half), theta_end: normDeg(theta + half) },
    sill_z: r4(w.base_z + tpl.sill), head_z: r4(w.base_z + tpl.head), confidence: 'high', notes: 'added in the annotation tool' };
  if (type === 'door') o.door = tpl.door ? clone(tpl.door) : { state: 'unknown', kind: null };
  if (type === 'window') o.window = tpl.window ? clone(tpl.window) : {};
  updateArcOpeningDerived(o, w);
  return o;
}

const stamp = () => Date.now().toString(36).slice(-6);

export function newWall(level, a, b, base, top) {
  const w = {
    id: `${level.id}-Wn${stamp()}`, name: null, category: 'partition', level: level.id,
    axis: { start: a.map(r4), end: b.map(r4), length: 0 }, thickness: 0.14, thickness_source: 'human (annotator)',
    base_z: r4(base), top_z: r4(top), height: 0,
    faces: {
      left: { observed: false, plane: null, rooms: [], observed_fraction: null, finish: null, cladding: null, source_faces: null },
      right: { observed: false, plane: null, rooms: [], observed_fraction: null, finish: null, cladding: null, source_faces: null },
    },
    joins: { start: null, end: null }, openings: [], footprint: [], trace: null,
    confidence: 'high', notes: 'added in the annotation tool',
  };
  updateWallDerived(w, [0, 0]);
  return w;
}

/** Default size of a new opening of each type, relative to the wall base. */
export const OPENING_TEMPLATES = {
  door: { width: 0.9, sill: 0, head: 2.05 },
  window: { width: 1.2, sill: 0.9, head: 2.1 },
  opening: { width: 1.0, sill: 0, head: 2.1 },
  interior_window: { width: 1.0, sill: 0.9, head: 2.0 },
};

export function newOpening(w, type, uCenter, tpl) {
  const f = wallFrame(w);
  const width = Math.min(tpl.width, Math.max(f.L - 0.02, 0.1));
  const u0 = Math.min(Math.max(uCenter - width / 2, 0), f.L - width);
  const top = topAt(w, uCenter);
  const sill = w.base_z + tpl.sill;
  const head = Math.min(w.base_z + tpl.head, top - 0.02);
  const o = {
    id: `${w.level}-On${stamp()}`, type, name: null, host_wall: w.id, level: w.level, connects: [],
    position: { u_start: r4(u0), u_end: r4(u0 + width), width: 0, center: [0, 0] },
    jamb_points: [], sill_z: r4(sill), head_z: r4(Math.max(head, sill + 0.2)), height: 0,
    side_rooms: { left: (w.faces?.left?.rooms || [])[0] || null, right: (w.faces?.right?.rooms || [])[0] || null },
    confidence: 'high', detection: { method: 'manual (annotation tool)', reviewed: true },
    notes: 'added in the annotation tool', window: type === 'window' ? {} : null,
    door: type === 'door' ? { state: 'unknown', kind: null } : null,
  };
  if (tpl.door) o.door = clone(tpl.door);
  if (tpl.window) o.window = clone(tpl.window);
  updateOpeningDerived(o, w);
  return o;
}

// -------------------------------------------------------------- path access (for commands)
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export function setPath(obj, path, value) {
  const ks = path.split('.');
  let o = obj;
  for (const k of ks.slice(0, -1)) { if (o[k] == null) o[k] = {}; o = o[k]; }
  o[ks[ks.length - 1]] = value;
}
