// Transform sessions: one move / rotate / scale of one or more elements, shared by the gumball, the keyboard
// transforms and the layout tools. A session snapshots the records (edit transaction), recomputes every element's
// fields from its snapshot on each update through the type's adapter (xform.js), applies snapping and constraints,
// re-hosts openings, and ends as exactly one undoable command (confirm) or restores everything (cancel).
import * as M from './model.js';
import { TYPES, readOnlyReason } from './registry.js';
import { S, EL, mm, clamp, toast, recOf } from './state.js';
import { refreshElement, buildElement } from './render.js';
import { beginEdit } from './commands.js';
import { planSnap, angleSnap, snap1D, snapOffset, parallelLines, pxTol, showGuide, wallsOnLevel, nearestOnSegment } from './snap.js';
import { pickAll } from './selection.js';
import { logCancelled } from './logging.js';

const DEG = 180 / Math.PI;

/** Which of the given elements a transform of this mode applies to (with the reason when none does). */
export function transformable(ids, mode) {
  const els = ids.map((id) => EL.get(id)).filter(Boolean);
  const out = [];
  let reason = null;
  for (const el of els) {
    const xf = TYPES[el.kind].xf, ro = readOnlyReason(el);
    if (ro) { reason = ro; continue; }
    if (!xf) { reason = `${el.kind}s cannot be transformed yet.`; continue; }
    if (!el.meshes.length) { reason = `${el.id} has no shape to transform (a note-only entry).`; continue; }
    if (!(xf.axes[mode === 'translate' ? 'translate' : mode] || []).length) { reason = `${el.kind}s cannot be ${mode === 'rotate' ? 'rotated' : 'scaled'}.`; continue; }
    // an opening whose host wall is transformed too follows its wall
    if (el.kind === 'opening' && ids.includes(el.rec.host_wall)) continue;
    out.push(el);
  }
  if (mode === 'scale' && out.length > 1) return { els: [], reason: 'Scale works on one element at a time.' };
  return { els: out, reason: out.length ? null : reason };
}

export class TransformSession {
  /**
   * mode: 'translate' | 'rotate' | 'scale'; input: 'gumball' | 'keyboard' | 'layout' | 'repeat' | ...;
   * space: 'local' | 'world'; pivot: pivot name (single element) — several elements turn about their common centre.
   */
  constructor({ els, mode, input, space = 'local', pivot = null, opPrefix = null }) {
    this.els = els; this.mode = mode; this.input = input; this.space = space;
    this.primary = els[0];
    this.xf = TYPES[this.primary.kind].xf;
    this.tx = beginEdit(els.map((e) => e.id));
    this.rec0 = (id) => this.tx.rec0(id);
    const f0 = this.xf.frame(this.rec0(this.primary.id));
    this.angle = f0.angle;                                    // local frame of the primary element
    // a face handle's pivot (the opposite face, e.g. 'u-' or 'top') need not be one of the gizmo's named pivots
    const facePivot = els.length === 1 && pivot && (this.xf.faces || []).some((f) => f.pivot === pivot);
    this.pivotName = els.length === 1 ? (pivot && (f0.pivots[pivot] || facePivot) ? pivot : Object.keys(f0.pivots)[0]) : 'center';
    if (els.length === 1) this.pivot = f0.pivots[this.pivotName] || f0.center;
    else {
      const cs = els.map((e) => TYPES[e.kind].xf.frame(this.rec0(e.id)).center);
      this.pivot = cs.reduce((s, c) => [s[0] + c[0] / cs.length, s[1] + c[1] / cs.length, s[2] + c[2] / cs.length], [0, 0, 0]);
    }
    this.levels = [...new Set(els.flatMap((e) => e.levels))];
    this.except = new Set(this.tx.snap.keys());
    this.t0 = performance.now(); this.path = []; this.snaps = []; this.lastSample = 0;
    this.opPrefix = opPrefix; this.rehost = null; this.result = null; this.done = false;
  }

  /** Local axes of the primary element in world coordinates. */
  axis(name) {
    const a = this.angle;
    if (name === 'u') return [Math.cos(a), Math.sin(a), 0];
    if (name === 'n') return [-Math.sin(a), Math.cos(a), 0];
    if (name === 'x') return [1, 0, 0];
    if (name === 'y') return [0, 1, 0];
    return [0, 0, 1];
  }

  restore() {
    for (const [id, s] of this.tx.snap) {
      const el = EL.get(id); if (!el) continue;
      for (const k of Object.keys(el.rec)) if (!(k in s.rec)) delete el.rec[k];
      Object.assign(el.rec, M.clone(s.rec));
    }
  }

  /**
   * Update the live result. params: {d: [dx, dy, dz]} (translate, world) | {angle} (rotate, radians) | {k: {u, n, z}}
   * (scale); constraint: allowed directions for snapping corrections: 'u', 'n', 'x', 'y', 'z', 'plan', 'uz' ...;
   * opts.event: the pointer event (Alt re-hosts an opening onto the wall under the pointer); opts.noSnap.
   * Returns the params after snapping.
   */
  apply(params, constraint = null, opts = {}) {
    if (this.done) return params;
    this.restore();
    this.rehost = null;
    let snap = null;
    params = { ...params, d: params.d ? [...params.d] : undefined, k: params.k ? { ...params.k } : undefined };
    const noSnap = opts.noSnap || (opts.event && (opts.event.ctrlKey || opts.event.metaKey));
    if (!noSnap) snap = this.snap(params, constraint);
    const ids = new Set(this.els.map((e) => e.id));
    for (const el of this.els) {
      const xf = TYPES[el.kind].xf, r0 = this.rec0(el.id);
      let fields = {}, deps = {};
      // records that move with the element: a wall's openings, a ceiling's bulkheads (each adapter picks its own)
      const deps0 = () => [...this.tx.snap.values()].filter((s) => s.kind === 'opening' || s.kind === 'bulkhead').map((s) => s.rec);
      if (this.mode === 'translate') { fields = xf.translate(r0, params.d); if (xf.translateDeps) deps = xf.translateDeps(r0, params.d, deps0()); }
      else if (this.mode === 'rotate') {
        const cons = constraint || 'z', ax = xf.axes.rotate || [];
        // an element that cannot store a turn about this axis (a wall tilted sideways) is left as it is
        const can = cons === 'z' || ax.includes(cons) || ((cons === 'x' || cons === 'y') && (ax.includes('u') || ax.includes('n')));
        fields = xf.rotate && can ? xf.rotate(r0, params.angle, this.pivot, this.axis(cons), cons) : {};
        if (xf.rotateDeps && can) deps = xf.rotateDeps(r0, params.angle, this.pivot, this.axis(cons), deps0());
      }
      else ({ fields, deps } = xf.scale(r0, params.k, this.pivotName, deps0()));
      for (const [p, v] of Object.entries(fields)) M.setPath(el.rec, p, M.clone(v));
      for (const [id, f] of Object.entries(deps || {})) { const d = EL.get(id); if (d) for (const [p, v] of Object.entries(f)) M.setPath(d.rec, p, v); }
      if (el.kind === 'opening') this.placeOpening(el, opts.event);
    }
    for (const el of this.els) refreshElement(el);
    // dependents: openings recompute their derived fields on the (moved) wall; walls that only host a moved opening
    // are redrawn, never recomputed (their own fields must not change)
    for (const id of this.tx.snap.keys()) {
      const d = EL.get(id);
      if (!d || ids.has(id)) continue;
      if (d.kind === 'opening') refreshElement(d); else buildElement(d);
    }
    if (snap && snap.type && !this.snaps.some((s) => s.type === snap.type && s.target === snap.target)) this.snaps.push({ type: snap.type, target: snap.target || null });
    if (this.rehost && !this.snaps.some((s) => s.type === 'rehost')) this.snaps.push({ type: 'rehost', target: this.rehost });
    showGuide(snap || (this.rehost ? { type: 'rehost', target: this.rehost } : null));
    this.result = params; this.constraint = constraint;
    const now = performance.now();
    if (now - this.lastSample >= 100) {                     // 10 Hz path samples (hesitation, overshoot)
      this.lastSample = now;
      this.path.push({ t: Math.round(now - this.t0), ...this.summary(params), snap: snap ? snap.type : null, rehost: this.rehost || undefined });
    }
    return params;
  }

  summary(p) {
    if (this.mode === 'translate') return { d: p.d.map(mm) };
    if (this.mode === 'rotate') return { angle_deg: +(p.angle * DEG).toFixed(2) };
    return { k: Object.fromEntries(Object.entries(p.k).map(([a, v]) => [a, +v.toFixed(4)])) };
  }

  /** Keep a moved opening on its wall, or re-host it: Alt = the wall under the pointer; past a wall end = the wall there. */
  placeOpening(el, ev) {
    const o = el.rec, r0 = this.rec0(el.id), host0 = recOf(r0.host_wall);
    if (!host0) return;
    if (host0.shape === 'arc') {                            // round wall: angles wrap around; keep the opening above the base
      if (o.sill_z < host0.base_z) { const h = o.head_z - o.sill_z; o.sill_z = host0.base_z; o.head_z = M.r4(host0.base_z + h); }
      return;
    }
    const f = M.wallFrame(host0), P = o.position, w = r0.position.u_end - r0.position.u_start;
    let target = null, point = null;
    if (this.mode === 'translate' && this.els.length === 1) {
      if (ev && ev.altKey) {
        const hit = pickAll(ev, ['wall']).find((h) => h.object.userData.el.id !== host0.id && !readOnlyReason(h.object.userData.el));
        if (hit) { target = hit.object.userData.el.rec; point = [hit.point.x, hit.point.y]; }
      } else if (P.u_start > f.L - 1e-6 || P.u_end < 1e-6) {
        const c = M.at(f, (P.u_start + P.u_end) / 2), tol = Math.max(0.35, pxTol([...c, o.sill_z]));
        let best = null;
        for (const cand of wallsOnLevel([host0.level], host0.id)) {
          const q = nearestOnSegment(c, cand.axis.start, cand.axis.end), d = Math.hypot(q[0] - c[0], q[1] - c[1]);
          if (d < tol && (!best || d < best.d)) best = { d, cand, q };
        }
        if (best) { target = best.cand; point = best.q; }
      }
    }
    if (target) {
      this.tx.ensure(target.id);
      const g = M.wallFrame(target), uc = M.uvOf(g, point)[0];
      const u0 = clamp(uc - w / 2, 0, Math.max(g.L - w, 0));
      o.host_wall = target.id;
      if (target.level) o.level = target.level;
      o.position.u_start = mm(u0); o.position.u_end = mm(u0 + w);
      const h = r0.head_z - r0.sill_z, top = M.topAt(target, u0 + w / 2);
      const z0 = clamp(o.sill_z, target.base_z, Math.max(top - h, target.base_z));
      o.sill_z = mm(z0); o.head_z = mm(z0 + h);
      o.side_rooms = { left: (target.faces?.left?.rooms || [])[0] || null, right: (target.faces?.right?.rooms || [])[0] || null };
      this.rehost = target.id;
      return;
    }
    // stay on the host: clamp to the wall (a move keeps the width; a resize stops the moving jamb at the wall end)
    const L = f.L, wNow = P.u_end - P.u_start;
    if (this.mode === 'scale') { P.u_start = Math.max(P.u_start, 0); P.u_end = Math.min(P.u_end, M.r4(L)); }
    if (P.u_start < 0) { P.u_start = 0; P.u_end = M.r4(Math.min(wNow, L)); }
    if (P.u_end > L) { P.u_start = mm(Math.max(L - wNow, 0)); P.u_end = M.r4(P.u_start + wNow); }
    const h = o.head_z - o.sill_z;
    if (o.sill_z < host0.base_z) { o.sill_z = host0.base_z; o.head_z = M.r4(host0.base_z + h); }
    // only push the head down when this transform raised it (some openings already reach above their wall's top)
    const top = M.topAt(host0, (P.u_start + P.u_end) / 2);
    if (o.head_z > Math.max(top, r0.head_z) + 1e-9) { o.head_z = M.r4(Math.max(top, r0.head_z)); if (this.mode === 'translate') o.sill_z = M.r4(o.head_z - h); }
  }

  /** Adjust params so the moving geometry lands on a snap target; returns the snap ({type, target, at}) or null. */
  snap(params, constraint) {
    const el = this.primary, r0 = this.rec0(el.id), xf = this.xf;
    const allowed = (corr) => {                               // keep only the part of a correction the constraint allows
      if (!constraint || constraint === 'plan' || constraint === 'free') return corr;
      const dirs = constraint.split('').filter((c) => c !== 'z').map((c) => this.axis(c));
      if (!dirs.length) return null;
      if (dirs.length >= 2) return corr;
      const a = dirs[0], k = corr[0] * a[0] + corr[1] * a[1];
      return [a[0] * k, a[1] * k];
    };
    if (this.mode === 'translate') {
      if (el.kind === 'opening' && this.els.length === 1) return this.snapOpeningMove(params, r0);
      const pts = this.els.flatMap((e) => (TYPES[e.kind].xf.snapPoints ? TYPES[e.kind].xf.snapPoints(this.rec0(e.id)) || [] : []))
        .map((p) => [p[0] + params.d[0], p[1] + params.d[1]]);
      let best = pts.length ? planSnap(pts, this.levels, this.except, this.pivot[2]) : null;
      if (best) {
        const c = allowed(best.corr);
        const tol = pxTol([...pts[0], this.pivot[2]]);
        if (!c || Math.hypot(best.corr[0] - c[0], best.corr[1] - c[1]) > tol * 0.5) best = null;
        else best.corr = c;
      }
      if (el.kind === 'wall' && r0.shape !== 'arc' && this.els.length === 1 && (!constraint || ['n', 'plan', 'free'].includes(constraint))) {
        const n = this.axis('n'), k = params.d[0] * n[0] + params.d[1] * n[1], h0 = r0.thickness / 2;
        const s = snapOffset(k, parallelLines(r0), pxTol(this.pivot), [-h0, 0, h0]);
        if (s && (!best || Math.abs(s.diff) < Math.hypot(...best.corr))) best = { corr: [n[0] * s.diff, n[1] * s.diff], type: 'align_parallel', target: s.target, at: [this.pivot[0] + params.d[0] + n[0] * s.diff, this.pivot[1] + params.d[1] + n[1] * s.diff, this.pivot[2]] };
      }
      if (best) { params.d[0] += best.corr[0]; params.d[1] += best.corr[1]; }
      // a wall moved up / down: its base or top onto another wall's base or top on the same level
      let zs = null;
      if (el.kind === 'wall' && this.els.length === 1 && Math.abs(params.d[2]) > 1e-9) {
        const cands = wallsOnLevel(this.levels, el.id).flatMap((w) => [{ v: w.base_z, type: 'base', target: w.id }, { v: w.top_z, type: 'top', target: w.id }]);
        const tol = pxTol(this.pivot);
        const a = snap1D(r0.base_z + params.d[2], cands, tol), b = snap1D(r0.top_z + params.d[2], cands, tol);
        zs = a && (!b || a.d <= b.d) ? { ...a, corr: a.v - r0.base_z - params.d[2] } : b ? { ...b, corr: b.v - r0.top_z - params.d[2] } : null;
        if (zs) { params.d[2] += zs.corr; zs.at = [this.pivot[0] + params.d[0], this.pivot[1] + params.d[1], zs.v]; }
      }
      return best || zs;
    }
    if (this.mode === 'rotate') {
      if (constraint && constraint !== 'z') return null;    // angle snapping only for turns about the vertical
      const half = Math.max(0.5, (TYPES[el.kind].xf.snapPoints ? (() => { const p = xf.snapPoints(r0); return Math.hypot(p[p.length - 1][0] - p[0][0], p[p.length - 1][1] - p[0][1]) / 2; })() : 1));
      const s = angleSnap(this.angle + params.angle, this.levels, this.except, pxTol(this.pivot) / half);
      if (s) { params.angle += s.corr; return { type: s.type, target: s.target, at: this.pivot }; }
      return null;
    }
    // scale
    if ((el.kind === 'wall' && r0.shape !== 'arc') || el.kind === 'screen') {
      const f = M.wallFrame(r0);
      if (params.k.u !== undefined && Math.abs(params.k.u - 1) > 1e-9 && ['start', 'end'].includes(this.pivotName)) {
        const L = f.L * params.k.u, moving = this.pivotName === 'start' ? M.at(f, L) : M.at(f, f.L - L);
        const s = planSnap([moving], this.levels, this.except, this.pivot[2]);
        if (s) { const along = s.corr[0] * f.t[0] + s.corr[1] * f.t[1]; params.k.u = (L + (this.pivotName === 'start' ? along : -along)) / f.L; return s; }
      }
      if (params.k.n !== undefined && Math.abs(params.k.n - 1) > 1e-9) {
        // moving face offsets (from the original axis, along n) and how the thickness follows a shift `diff` of each:
        // faceL pivot: the right face moves (v = h0 - th, th' = th - diff); faceR pivot: the left face moves
        // (v = th - h0, th' = th + diff); symmetric: both faces move (±th/2, th' = th ± 2·diff)
        const th = r0.thickness * params.k.n, h0 = r0.thickness / 2;
        const faces = this.pivotName === 'faceL' ? [[h0 - th, -1]] : this.pivotName === 'faceR' ? [[th - h0, 1]] : [[th / 2, 2], [-th / 2, -2]];
        let best = null;
        for (const [v, gain] of faces) {
          const s = snapOffset(v, parallelLines(r0), pxTol(this.pivot));
          if (s && (!best || Math.abs(s.diff) < Math.abs(best.diff))) best = { ...s, gain };
        }
        if (best) {
          params.k.n = Math.max((th + best.gain * best.diff) / r0.thickness, 0.05);
          return { type: 'align_face', target: best.target, at: this.pivot };
        }
      }
      if (params.k.z !== undefined && Math.abs(params.k.z - 1) > 1e-9) {
        const h0 = r0.top_z - r0.base_z;
        if (this.pivotName === 'top') {                       // bottom face: the base onto other walls' bases
          const base = r0.top_z - h0 * params.k.z;
          const cands = wallsOnLevel(this.levels, el.id).map((w) => ({ v: w.base_z, type: 'base', target: w.id }));
          const s = snap1D(base, cands, pxTol([this.pivot[0], this.pivot[1], base]));
          if (s) { params.k.z = (r0.top_z - s.v) / h0; return { ...s, at: [this.pivot[0], this.pivot[1], s.v] }; }
        } else {
          const top = r0.base_z + h0 * params.k.z;
          const cands = wallsOnLevel(this.levels, el.id).map((w) => ({ v: w.top_z, type: 'top', target: w.id }));
          const s = snap1D(top, cands, pxTol([this.pivot[0], this.pivot[1], top]));
          if (s) { params.k.z = (s.v - r0.base_z) / h0; return { ...s, at: [this.pivot[0], this.pivot[1], s.v] }; }
        }
      }
      return null;
    }
    if (el.kind === 'opening') return this.snapOpeningScale(params, r0);
    return null;
  }

  openingTargets(r0) {
    const w = recOf(r0.host_wall), f = M.wallFrame(w);
    const others = [...EL.values()].filter((e) => e.kind === 'opening' && e.rec.host_wall === w.id && e.id !== r0.id).map((e) => e.rec);
    const u = [{ v: 0, type: 'wall_end' }, { v: f.L, type: 'wall_end' }];
    for (const x of others) u.push({ v: x.position.u_start, type: 'opening_edge', target: x.id }, { v: x.position.u_end, type: 'opening_edge', target: x.id });
    const sill = [{ v: w.base_z, type: 'floor' }, ...others.map((x) => ({ v: x.sill_z, type: 'sill', target: x.id }))];
    const head = others.map((x) => ({ v: x.head_z, type: 'head', target: x.id }));
    return { w, f, u, sill, head };
  }

  snapOpeningMove(params, r0) {
    if (recOf(r0.host_wall)?.shape === 'arc') return null;    // (no snapping along round walls yet)
    const { w, f, u, sill, head } = this.openingTargets(r0);
    const du = params.d[0] * f.t[0] + params.d[1] * f.t[1], tol = pxTol(this.pivot);
    let best = null;
    for (const edge of [r0.position.u_start, r0.position.u_end]) {
      const s = snap1D(edge + du, u, tol);
      if (s && (!best || s.d < best.d)) best = { ...s, corr: s.v - (edge + du), at: [...M.at(f, s.v), this.pivot[2]] };
    }
    if (best) { params.d[0] += f.t[0] * best.corr; params.d[1] += f.t[1] * best.corr; }
    let zs = null;
    if (Math.abs(params.d[2]) > 1e-9) {
      const a = snap1D(r0.sill_z + params.d[2], sill, tol), b = snap1D(r0.head_z + params.d[2], head, tol);
      zs = a && (!b || a.d <= b.d) ? { ...a, corr: a.v - r0.sill_z - params.d[2] } : b ? { ...b, corr: b.v - r0.head_z - params.d[2] } : null;
      if (zs) params.d[2] += zs.corr;
    }
    void w;
    return best || zs;
  }

  snapOpeningScale(params, r0) {
    if (recOf(r0.host_wall)?.shape === 'arc') return null;
    const { f, u, sill, head } = this.openingTargets(r0), tol = pxTol(this.pivot), P = r0.position;
    if (params.k.u !== undefined && Math.abs(params.k.u - 1) > 1e-9) {
      const w = (P.u_end - P.u_start) * params.k.u;
      const moving = this.pivotName === 'j0' ? P.u_start + w : this.pivotName === 'j1' ? P.u_end - w : null;
      if (moving !== null) {
        const s = snap1D(moving, u, tol);
        if (s) { params.k.u = Math.abs(s.v - (this.pivotName === 'j0' ? P.u_start : P.u_end)) / (P.u_end - P.u_start); return { ...s, at: [...M.at(f, s.v), this.pivot[2]] }; }
      }
    }
    if (params.k.z !== undefined && Math.abs(params.k.z - 1) > 1e-9) {
      const h = (r0.head_z - r0.sill_z) * params.k.z;
      if (this.pivotName === 'head') {
        const s = snap1D(r0.head_z - h, sill, tol);
        if (s) { params.k.z = (r0.head_z - s.v) / (r0.head_z - r0.sill_z); return s; }
      } else if (this.pivotName !== 'center') {
        const s = snap1D(r0.sill_z + h, head, tol);
        if (s) { params.k.z = (s.v - r0.sill_z) / (r0.head_z - r0.sill_z); return s; }
      }
    }
    return null;
  }

  opName() {
    const k = this.els.length > 1 && new Set(this.els.map((e) => e.kind)).size > 1 ? 'multi' : this.primary.kind;
    if (this.opPrefix) return `${k}.${this.opPrefix}`;
    if (this.rehost) return 'opening.rehost';
    if (this.mode === 'rotate' && this.constraint && this.constraint !== 'z') return `${k}.tilt`;
    if (this.mode !== 'scale') return `${k}.${this.mode}`;
    if (k === 'opening') return 'opening.resize';
    const ax = Object.entries(this.result ? this.result.k : {}).filter(([, v]) => Math.abs(v - 1) > 1e-9).map(([a]) => a);
    const names = { u: 'length', n: 'thickness', z: 'height' };
    return ax.length === 1 && (k === 'wall' || k === 'screen') ? `${k}.scale_${names[ax[0]]}` : `${k}.scale`;
  }

  meta(extra = {}) {
    const ids = this.els.map((e) => e.id);
    return { opName: this.opName(), label: `${ids.join(', ')}: ${this.mode}`, via: this.input, input: this.input,
      constraint: { axis: this.constraint || null, space: this.space, pivot: this.pivotName }, snaps: this.snaps,
      path: this.path, duration_ms: Math.round(performance.now() - this.t0), ...extra };
  }

  /** Finish: one undoable command (false when nothing changed). */
  confirm(extra = {}) {
    if (this.done) return false;
    if (this.rehost) {                                        // keep both walls' opening lists in step
      const o = this.primary.rec, old = recOf(this.rec0(o.id).host_wall), now = recOf(o.host_wall);
      if (old) old.openings = (old.openings || []).filter((x) => x !== o.id);
      if (now && !(now.openings || []).includes(o.id)) now.openings = [...(now.openings || []), o.id];
    }
    const meta = this.meta(extra);
    this.done = true;
    showGuide(null);
    const ok = this.tx.commit(meta);
    if (ok) S.lastTransform = { mode: this.mode, params: M.clone(this.result), constraint: this.constraint, space: this.space, pivot: this.pivotName };
    if (!ok && this.mode === 'rotate' && this.constraint && this.constraint !== 'z') {
      toast(`Nothing to tilt: ${this.els.map((e) => e.kind).filter((k, n, a) => a.indexOf(k) === n).join(' / ')} cannot store that turn (walls, columns ... are vertical; a cone ceiling keeps its vertical cone).`, 5000);
    }
    return ok;
  }

  cancel(how = 'esc', extra = {}) {
    if (this.done) return;
    this.done = true;
    showGuide(null);
    this.tx.cancel();
    logCancelled({ op: this.opName(), ids: this.els.map((e) => e.id), input: this.input, how,
      constraint: { axis: this.constraint || null, space: this.space, pivot: this.pivotName }, snaps: this.snaps,
      path: this.path, duration_ms: Math.round(performance.now() - this.t0), ...extra });
  }
}

/** Convenience for tests and layout tools: run one transform with fixed params and confirm it. */
export function runTransform(ids, mode, params, { input = 'numeric', space = 'local', pivot = null, constraint = null, noSnap = true, opPrefix = null } = {}) {
  const { els, reason } = transformable(ids, mode);
  if (!els.length) { if (reason) toast(reason); return false; }
  const s = new TransformSession({ els, mode, input, space, pivot, opPrefix });
  s.apply(params, constraint, { noSnap });
  return s.confirm();
}
