// Element-type registry: everything the tool knows about each kind of element lives in one entry, so adding a type
// means adding an entry here (drawing, colours, levels, editable fields, panel rows, review evidence, related
// elements, actions, handles, op names and the gumball axes that will apply to it).
//
// Entry fields (all optional except key and draw):
//   key            the list in the scene JSON ('walls', ...)
//   order          display / review order (lower first); build order is the registry order (walls, then openings)
//   levels(rec)    level ids the element belongs to (default: rec.level)
//   draw(el, api)  build its geometry from the record: api.mesh(geom, extra), api.outline(poly, z), api.label(text, pos)
//   color(rec)     colour in "by type" mode;  legend: [[label, colour], ...];  tint: opacity factor
//   afterEdit(el, api)  recompute derived fields after an edit and rebuild what depends on it (api.rebuild(el))
//   beforeInsert(rec, api, at) / afterInsert(rec, api, at) / onRemove(rec, api) -> at   keep cross references in sync
//                  (onRemove returns the id's place in the cross-reference list, so undo can put it back there)
//   editFields     paths compared with the original to decide whether the element was edited
//   fields(el)     panel inputs: {label, input: 'num'|'text'|'select', get(), set(value) -> {path: value}, options}
//   props(el, h)   read-only panel rows (HTML);  evidence(el) review-card rows;  listInfo(el), tooltip(el)
//   related(el)    ids highlighted with the selection;  focusWall(el) wall record used to frame the camera
//   actions        panel action buttons;  deletable;  dependents(el) records deleted with it [{kind, rec}]
//   nudge(el, dx, dy, step) -> {after, op}   arrow-key moves
//   shapes(el)     editable shapes (Points mode): outlines / lines [{path: 'polygon' | 'patches.0.polygon' | 'path', closed, z}]
//                  or defining points [{points: ['axis.start', 'axis.end'], z}];  noPoints(el): why there are none
//   readOnly(el)   reason string when the element cannot be edited yet (shown in the panel, blocks every edit)
//   xf             transform adapter (xform.js): local frame, pivots, gumball axes, move / rotate / scale -> fields
//   editDeps(el)   ids an edit of the element can also change (snapshotted with it); rebuild(el, api) exact rebuild
//   match          fields copied by "match properties";  duplicate(rec) -> copy with a new id
//   queue          {label, on}: offered as a review-queue filter;  layer {label, rank, on}: visibility toggle
import * as M from './model.js';
import * as B from './build.js';
import { EL, EXT, ctx, S, num, esc, mm, clamp, openingsOf, hostOf, recOf } from './state.js';
import * as X from './xform.js';

const TYPE_COLORS = {
  wall: '#e8e2d0', header: '#a8d08d', glass_partition: '#8fd3f0',
  door: '#ffb347', window: '#3fa0ff', opening: '#5fe08a', interior_window: '#c58cff',
  floor: '#7fbf6a', ceiling: '#6fb7ff', stair: '#ff5fd2', room: '#ffffff',
  column: '#a3a9b4', bulkhead: '#c79bd8', beam: '#c08a55', screen: '#d6a93a', builtin: '#8fa3b8', water: '#3c9bdc',
  railing: '#e08a4a', skylight: '#9fe7ff', separator: '#ffb000', unscanned: '#ff4d6d',
};
const offsetZ = (f, dz) => (x, y) => f(x, y) + dz;
const ownLevel = (rec) => (rec.level ? [rec.level] : []);
const roomLevel = (rec) => {
  if (rec.level) return [rec.level];
  const room = rec.room && (ctx.DOC.rooms || []).find((r) => r.id === rec.room);
  return room && room.level ? [room.level] : [];
};
const notesField = (r) => ({ label: 'notes', input: 'text', get: () => r.notes || '', set: (v) => ({ notes: v || null }) });
const seen = (face) => (face && face.observed ? '✓' : '✗');
const isArc = (w) => !!(w && w.shape === 'arc');
const floorOf = (rec) => {                              // floor height for elements without their own heights
  const lv = rec.level ? ctx.LEVELS.find((l) => l.id === rec.level) : ctx.LEVELS[0];
  return lv ? lv.elevation : 0;
};
/** Read-only key/value rows for the panel (numbers to mm, ids as links, long arrays summarised). */
function kvRows(el, h, keys) {
  const r = el.rec;
  const fmt = (k, v) => {
    if (v == null || v === '') return '—';
    if (typeof v === 'number') return num(v, 3);
    if (typeof v === 'string') return ['room', 'host_ceiling', 'stair'].includes(k) ? h.link(v) : esc(v);
    if (Array.isArray(v)) {
      if (k === 'attached_to') return v.map(h.link).join(', ');
      if (v.length > 4 && Array.isArray(v[0])) return `${v.length} points`;
      return esc(JSON.stringify(v));
    }
    return esc(Object.entries(v).filter(([, x]) => x != null && typeof x !== 'object').map(([a, x]) => `${a} ${typeof x === 'number' ? num(x, 3) : x}`).join(' · '));
  };
  return keys.filter((k) => r[k] !== undefined).map((k) => h.row(k.replace(/_/g, ' '), fmt(k, r[k]))).join('');
}
let dupN = 0;
const newId = (id) => `${id}-d${Date.now().toString(36).slice(-4)}${(dupN++).toString(36)}`;
const copyOf = (rec) => ({ ...M.clone(rec), id: newId(rec.id), notes: `duplicated from ${rec.id} in the annotation tool` });
/** An opening's meshes plus its host wall's (and the previous host's, after a re-host). */
function rebuildOpening(el, api) {
  const prev = el._host, cur = el.rec.host_wall;
  api.rebuild(el);
  if (cur) api.rebuild(EL.get(cur));
  if (prev && prev !== cur) api.rebuild(EL.get(prev));
}
const zField = (r, label, key, extra = () => ({})) => ({ label, input: 'num', get: () => r[key], set: (v) => ({ [key]: mm(v), ...extra(mm(v)) }) });
const shoelace = (p) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
const perimeterOf = (p) => p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + Math.hypot(b[0] - a[0], b[1] - a[1]); }, 0);
/** Same polygon up to 1 cm per corner (any starting corner, either direction). */
function sameOutline(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const n = a.length, near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.01;
  for (let k = 0; k < n; k++) {
    for (const dir of [1, -1]) if (a.every((p, i) => near(p, b[(k + dir * i + n * 2) % n]))) return true;
  }
  return false;
}
/** Bulkheads whose underside is one of this ceiling's patches (named by it, or the same outline and height). */
const ceilingBulkheads = (rec) => (ctx.DOC.bulkheads || []).filter((b) => b.footprint && (rec.patches || []).some((p) => p.kind === 'bulkhead underside'
  && (p.source_element === b.id || (Math.abs(b.bottom_z - p.z) < 0.02 && sameOutline(b.footprint, p.polygon)))));
const polyShape = (path, z) => (el) => (M.getPath(el.rec, path) ? [{ path, closed: true, z: z(el.rec) }] : []);

export const TYPES = {
  wall: {
    key: 'walls', order: 0, levels: ownLevel,
    color: (r) => TYPE_COLORS[r.category] || TYPE_COLORS.wall,
    legend: [['wall', TYPE_COLORS.wall], ['header wall', TYPE_COLORS.header]],
    draw(el, api) {
      const r = el.rec;
      api.mesh(isArc(r) ? B.arcWallGeometry(r, openingsOf(r.id)) : B.wallGeometry(r, openingsOf(r.id), EXT.get(r.id) || [0, 0]));
    },
    afterEdit(el, api) {
      if (isArc(el.rec)) M.updateArcDerived(el.rec); else M.updateWallDerived(el.rec, EXT.get(el.id) || [0, 0]);
      for (const o of openingsOf(el.id)) { (isArc(el.rec) ? M.updateArcOpeningDerived : M.updateOpeningDerived)(o, el.rec); api.rebuild(EL.get(o.id)); }
      api.rebuild(el);
    },
    rebuild(el, api) { for (const o of openingsOf(el.id)) api.rebuild(EL.get(o.id)); api.rebuild(el); },
    editDeps: (el) => openingsOf(el.id).map((o) => o.id),
    xf: X.anyWallXf,
    // straight: its two axis ends; round: its centre (radius and thickness: Resize)
    shapes: (el) => [{ points: isArc(el.rec) ? ['arc.center'] : ['axis.start', 'axis.end'], z: el.rec.base_z + 0.02 }],
    match: ['thickness', 'base_z', 'top_z', 'category'],
    duplicate: (rec) => ({ ...copyOf(rec), openings: [] }),
    beforeInsert(rec, api, at) {
      if (!EXT.has(rec.id)) EXT.set(rec.id, [0, 0]);
      const lv = ctx.LEVELS.find((l) => l.id === rec.level);
      if (lv && lv.walls && !lv.walls.includes(rec.id)) lv.walls.splice(at ?? lv.walls.length, 0, rec.id);
    },
    onRemove(rec) {
      const lv = ctx.LEVELS.find((l) => l.id === rec.level);
      if (!lv || !lv.walls) return undefined;
      const at = lv.walls.indexOf(rec.id);
      lv.walls = lv.walls.filter((x) => x !== rec.id);
      return at < 0 ? undefined : at;
    },
    editFields: ['axis.start', 'axis.end', 'thickness', 'base_z', 'top_z', 'top_profile', 'category', 'confidence', 'notes', 'name'],
    fields(el) {
      const r = el.rec;
      if (isArc(r)) {
        const A = r.arc, th = A.r_outer - A.r_inner, ring = (ri, ro) => ({ 'arc.r_inner': mm(ri), 'arc.r_outer': mm(ro) });
        const closed = A.closed || (A.sweep_deg ?? 360) >= 360;
        return [
          { label: 'category', input: 'select', get: () => r.category, set: (v) => ({ category: v }), options: M.WALL_CATEGORIES },
          { label: 'centre x', input: 'num', get: () => A.center[0], set: (v) => ({ 'arc.center': [mm(v), A.center[1]] }) },
          { label: 'centre y', input: 'num', get: () => A.center[1], set: (v) => ({ 'arc.center': [A.center[0], mm(v)] }) },
          { label: 'radius (mid)', input: 'num', get: () => A.radius_axis, set: (v) => ring(Math.max(v - th / 2, 0.05), Math.max(v + th / 2, 0.06)) },
          { label: 'inner radius', input: 'num', get: () => A.r_inner, set: (v) => ({ 'arc.r_inner': mm(Math.min(Math.max(v, 0.05), A.r_outer - 0.01)) }) },
          { label: 'outer radius', input: 'num', get: () => A.r_outer, set: (v) => ({ 'arc.r_outer': mm(Math.max(v, A.r_inner + 0.01)) }) },
          { label: 'thickness', input: 'num', get: () => th, set: (v) => ring(A.radius_axis - Math.max(v, 0.01) / 2, A.radius_axis + Math.max(v, 0.01) / 2) },
          ...(closed ? [] : [
            { label: 'start angle °', input: 'num', get: () => A.start_angle_deg, set: (v) => ({ 'arc.start_angle_deg': M.normDeg(v) }) },
            { label: 'sweep °', input: 'num', get: () => A.sweep_deg, set: (v) => ({ 'arc.sweep_deg': mm(Math.min(Math.max(v, 1), 360)) }) }]),
          { label: 'base z', input: 'num', get: () => r.base_z, set: (v) => ({ base_z: mm(v) }) },
          { label: 'top z', input: 'num', get: () => r.top_z, set: (v) => ({ top_z: mm(v) }) },
          { label: 'confidence', input: 'select', get: () => r.confidence, set: (v) => ({ confidence: v }), options: M.CONFIDENCE },
          notesField(r),
        ];
      }
      const shiftTop = (v) => {
        const d = v - r.top_z;
        const out = { top_z: mm(v) };
        if (r.top_profile) out.top_profile = { ...r.top_profile, z: r.top_profile.z.map((z) => mm(z + d)) };
        return out;
      };
      return [
        { label: 'category', input: 'select', get: () => r.category, set: (v) => ({ category: v }), options: M.WALL_CATEGORIES },
        { label: 'start x', input: 'num', get: () => r.axis.start[0], set: (v) => ({ 'axis.start': [mm(v), r.axis.start[1]] }) },
        { label: 'start y', input: 'num', get: () => r.axis.start[1], set: (v) => ({ 'axis.start': [r.axis.start[0], mm(v)] }) },
        { label: 'end x', input: 'num', get: () => r.axis.end[0], set: (v) => ({ 'axis.end': [mm(v), r.axis.end[1]] }) },
        { label: 'end y', input: 'num', get: () => r.axis.end[1], set: (v) => ({ 'axis.end': [r.axis.end[0], mm(v)] }) },
        { label: 'length', input: 'num', get: () => r.axis.length, set: (v) => ({ 'axis.end': M.at(M.wallFrame(r), Math.max(v, 0.05)).map(mm) }) },
        { label: 'thickness', input: 'num', get: () => r.thickness, set: (v) => ({ thickness: mm(Math.max(v, 0.01)) }) },
        { label: 'base z', input: 'num', get: () => r.base_z, set: (v) => ({ base_z: mm(v) }) },
        { label: 'top z', input: 'num', get: () => r.top_z, set: shiftTop },
        { label: 'confidence', input: 'select', get: () => r.confidence, set: (v) => ({ confidence: v }), options: M.CONFIDENCE },
        notesField(r),
      ];
    },
    props(el, h) {
      const r = el.rec;
      return h.row('thickness source', esc(r.thickness_source))
        + h.row('faces seen', `left ${seen(r.faces?.left)} · right ${seen(r.faces?.right)}`)
        + h.row('rooms', `L: ${(r.faces?.left?.rooms || []).map(h.link).join(', ') || '—'} · R: ${(r.faces?.right?.rooms || []).map(h.link).join(', ') || '—'}`)
        + h.row('openings', openingsOf(r.id).map((o) => h.link(o.id)).join(', ') || '—')
        + h.row('joins', `${h.link(r.joins?.start)} · ${h.link(r.joins?.end)}`);
    },
    evidence(el) {
      const r = el.rec;
      return [`${r.category} · thickness ${num(r.thickness, 2)} m (${esc(r.thickness_source)})`,
        `faces seen: left ${seen(r.faces?.left)} · right ${seen(r.faces?.right)}`,
        `length ${num(r.axis.length, 2)} m · height ${num(r.height, 2)} m · ${openingsOf(r.id).length} openings`];
    },
    listInfo: (el) => `${el.rec.category}`,
    tooltip: (el) => `wall · ${el.rec.category}`,
    related: (el) => openingsOf(el.rec.id).map((o) => o.id),
    focusWall: (el) => (isArc(el.rec) ? null : el.rec),
    actions: (el) => (isArc(el.rec) ? ['add-door', 'add-window', 'delete'] : ['snap', 'add-door', 'add-window', 'delete']),
    deletable: true,
    dependents: (el) => openingsOf(el.id).map((o) => ({ kind: 'opening', rec: o })),
    nudge(el, dx, dy, step) {
      const w = el.rec;
      if (isArc(w)) return { op: 'wall.translate', after: { 'arc.center': [mm(w.arc.center[0] + dx * step), mm(w.arc.center[1] + dy * step)] } };
      const f = M.wallFrame(w);
      const v = [f.t[0] * dx * step + f.n[0] * dy * step, f.t[1] * dx * step + f.n[1] * dy * step];
      return { op: 'wall.translate', after: { 'axis.start': [mm(w.axis.start[0] + v[0]), mm(w.axis.start[1] + v[1])], 'axis.end': [mm(w.axis.end[0] + v[0]), mm(w.axis.end[1] + v[1])] } };
    },
    queue: { label: 'walls', on: true }, layer: { label: 'walls', rank: 0, on: true },
  },

  opening: {
    // openings without their own level (the hand scenes) are on their wall's level (also when the wall is deleted)
    key: 'openings', order: 1, levels: (rec) => (rec.level ? [rec.level]
      : ownLevel(recOf(rec.host_wall) || ((ctx.DOC.annotation_tool.deleted || {})[rec.host_wall] || {}).rec || {})),
    color: (r) => TYPE_COLORS[r.type] || TYPE_COLORS.opening,
    legend: [['door', TYPE_COLORS.door], ['window', TYPE_COLORS.window], ['passage', TYPE_COLORS.opening], ['interior window', TYPE_COLORS.interior_window]],
    draw(el, api) {
      const w = recOf(el.rec.host_wall);
      el._host = el.rec.host_wall;
      if (w) api.mesh(isArc(w) ? B.arcOpeningGeometry(el.rec, w) : B.openingGeometry(el.rec, w));
    },
    afterEdit(el, api) {
      const w = recOf(el.rec.host_wall);
      if (w) (isArc(w) ? M.updateArcOpeningDerived : M.updateOpeningDerived)(el.rec, w);
      rebuildOpening(el, api);
    },
    rebuild: rebuildOpening,
    editDeps: (el) => [el.rec.host_wall],
    xf: X.openingXf,
    noPoints: () => 'An opening is a span of its wall (u start / end, sill, head): use Resize (T) to move its jambs, sill and head.',
    match: ['type', 'width', 'sill_z', 'head_z'],
    duplicate: (rec) => copyOf(rec),
    afterInsert(rec, api, at) {
      const w = recOf(rec.host_wall);
      if (w) { if (!w.openings.includes(rec.id)) w.openings.splice(at ?? w.openings.length, 0, rec.id); api.rebuild(EL.get(w.id)); }
    },
    onRemove(rec, api) {
      const w = recOf(rec.host_wall);
      if (!w) return undefined;
      const at = w.openings.indexOf(rec.id);
      w.openings = w.openings.filter((x) => x !== rec.id); api.rebuild(EL.get(w.id));
      return at < 0 ? undefined : at;
    },
    editFields: ['type', 'host_wall', 'position.u_start', 'position.u_end', 'sill_z', 'head_z', 'confidence', 'notes', 'name', 'door', 'window'],
    fields(el) {
      const r = el.rec, w = hostOf(el);
      const L = w && !isArc(w) ? M.wallFrame(w).L : 1e9;
      const along = isArc(w) ? [
        { label: 'start angle °', input: 'num', get: () => r.position.theta_start, set: (v) => ({ 'position.theta_start': M.normDeg(v) }) },
        { label: 'end angle °', input: 'num', get: () => r.position.theta_end, set: (v) => ({ 'position.theta_end': M.normDeg(v) }) },
      ] : null;
      const out = [
        { label: 'type', input: 'select', get: () => r.type, options: M.OPENING_TYPES, set: (v) => {
          const o = { type: v };
          if (v === 'door' && !r.door) o.door = { state: 'unknown', kind: null };
          if (v === 'window' && !r.window) o.window = {};
          return o;
        } },
        ...(along || [
          { label: 'u start', input: 'num', get: () => r.position.u_start, set: (v) => ({ 'position.u_start': mm(clamp(v, 0, r.position.u_end - 0.05)) }) },
          { label: 'u end', input: 'num', get: () => r.position.u_end, set: (v) => ({ 'position.u_end': mm(clamp(v, r.position.u_start + 0.05, L)) }) },
          { label: 'width', input: 'num', get: () => r.position.width, set: (v) => {
            const c = (r.position.u_start + r.position.u_end) / 2, hw = Math.max(v, 0.05) / 2;
            return { 'position.u_start': mm(clamp(c - hw, 0, L)), 'position.u_end': mm(clamp(c + hw, 0, L)) };
          } }]),
        { label: 'sill z', input: 'num', get: () => r.sill_z, set: (v) => ({ sill_z: mm(Math.min(v, r.head_z - 0.05)) }) },
        { label: 'head z', input: 'num', get: () => r.head_z, set: (v) => ({ head_z: mm(Math.max(v, r.sill_z + 0.05)) }) },
        { label: 'confidence', input: 'select', get: () => r.confidence, set: (v) => ({ confidence: v }), options: M.CONFIDENCE },
      ];
      if (r.type === 'door') out.push({ label: 'door state', input: 'select', get: () => (r.door && r.door.state) || 'unknown',
        set: (v) => ({ door: { ...(r.door || {}), state: v } }), options: ['closed', 'open', 'open or leaf not located', 'unknown'] });
      out.push(notesField(r));
      return out;
    },
    props(el, h) {
      const r = el.rec;
      return h.row('host wall', h.link(r.host_wall)) + h.row('height', num(r.head_z - r.sill_z, 3))
        + h.row('connects', (r.connects || []).map(h.link).join(', ') || '—')
        + (r.detection ? h.row('found by', esc(r.detection.method)) : '');
    },
    evidence(el) {
      const r = el.rec, rows = [`${r.type} ${num(r.position.width, 2)} × ${num(r.head_z - r.sill_z, 2)} m, sill ${num(r.sill_z - (hostOf(el)?.base_z ?? 0), 2)} m above the wall base`];
      if (r.detection) rows.push(`found by: ${esc(r.detection.method)}`);
      if (r.door) rows.push(`door: ${esc(Object.entries(r.door).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', '))}`);
      return rows;
    },
    listInfo: (el) => `${el.rec.type} ${num(el.rec.position.width, 2)}m`,
    tooltip: (el) => el.rec.type,
    related: (el) => [el.rec.host_wall],
    focusWall: (el) => (isArc(hostOf(el)) ? null : hostOf(el)),
    actions: ['copy', 'delete'],
    deletable: true,
    nudge(el, dx, dy, step) {
      const o = el.rec, w = hostOf(el);
      if (isArc(w)) {                                       // ← → along the ring (step at its mean radius), ↑ ↓ up / down
        const dth = (dx * step) / w.arc.radius_axis / M.DEG, h = o.head_z - o.sill_z, z0 = Math.max(o.sill_z + dy * step, w.base_z);
        return { op: 'opening.translate', after: { 'position.theta_start': M.normDeg(o.position.theta_start + dth), 'position.theta_end': M.normDeg(o.position.theta_end + dth), sill_z: mm(z0), head_z: mm(z0 + h) } };
      }
      const L = M.wallFrame(w).L, width = o.position.u_end - o.position.u_start;
      const u0 = clamp(o.position.u_start + dx * step, 0, L - width);
      const h = o.head_z - o.sill_z, z0 = clamp(o.sill_z + dy * step, w.base_z, M.topAt(w, u0 + width / 2) - h);
      return { op: 'opening.translate', after: { 'position.u_start': mm(u0), 'position.u_end': mm(u0 + width), sill_z: mm(z0), head_z: mm(z0 + h) } };
    },
    queue: { label: 'openings', on: true }, layer: { label: 'openings', rank: 1, on: true },
  },

  room: {
    key: 'rooms', order: 2, levels: ownLevel,
    color: () => TYPE_COLORS.room,
    draw(el, api) {
      const r = el.rec;
      if (!r.polygon || r.polygon.length < 3) return;
      const z = (r.floor_z ?? 0) + 0.03;
      api.outline(r.polygon, z);
      const c = r.polygon.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]).map((v) => v / r.polygon.length);
      api.label(r.name || r.id, [c[0], c[1], z + 0.9]);
    },
    layerVisible: () => (S.layers.room || S.layers.label) && S.view !== 'wall',   // labels are not clipped: none in the wall view
    shapes: polyShape('polygon', (r) => (r.floor_z ?? 0) + 0.03),
    afterEdit(el, api) { const p = el.rec.polygon; if (p && p.length > 2) { el.rec.area = mm(shoelace(p)); el.rec.perimeter = mm(perimeterOf(p)); } api.rebuild(el); },
    // a room takes its floor and ceiling with it (they are restored with it too)
    actions: ['delete'], deletable: true,
    dependents: (el) => ['floor', 'ceiling'].flatMap((k) => (ctx.DOC[TYPES[k].key] || []).filter((r) => r.room === el.id).map((rec) => ({ kind: k, rec }))),
    editFields: ['name', 'type', 'polygon', 'notes'],
    fields(el) {
      const r = el.rec;
      return [
        { label: 'name', input: 'text', get: () => r.name || '', set: (v) => ({ name: v || null }) },
        { label: 'type', input: 'text', get: () => r.type || '', set: (v) => ({ type: v || null }) },
        notesField(r),
      ];
    },
    props(el, h) {
      const r = el.rec;
      return h.row('area', `${num(r.area, 1)} m²`) + h.row('floor z', num(r.floor_z, 3))
        + h.row('ceiling z', `${num(r.ceiling_main_z, 2)} (${(r.ceiling_z_range || []).map((x) => num(x, 2)).join('–')})`)
        + h.row('walls', (r.bounding_walls || []).map(h.link).join(', ') || '—')
        + h.row('openings', (r.openings || []).map(h.link).join(', ') || '—');
    },
    evidence: (el) => [`${esc(el.rec.type)} · ${num(el.rec.area, 1)} m² · ceiling ${num(el.rec.ceiling_main_z, 2)}`],
    listInfo: (el) => esc(el.rec.name || ''),
    related: (el) => [...(el.rec.bounding_walls || []), ...(el.rec.openings || [])],
    queue: { label: 'rooms', on: false }, layer: { label: 'room outlines', rank: 5, on: true },
    extraLayers: [{ key: 'label', label: 'room labels (L)', rank: 6, on: true }],
  },

  ceiling: {
    key: 'ceilings', order: 3, levels: roomLevel, tint: 0.6,
    color: () => TYPE_COLORS.ceiling, legend: [['ceiling', TYPE_COLORS.ceiling]],
    draw(el, api) {
      (el.rec.patches || []).forEach((p, i) => {
        // a bulkhead's underside is drawn by the bulkhead itself; drawing the patch too would double the surface
        // (the patch names its bulkhead, or, in converted runs that do not, has the same outline and height)
        if (p.kind === 'bulkhead underside' && (ctx.DOC.bulkheads || []).some((b) => b.footprint
          && (b.id === p.source_element || (Math.abs(b.bottom_z - p.z) < 0.02 && sameOutline(b.footprint, p.polygon))))) return;
        api.mesh(p.modeled_as === 'cone' && p.cone ? B.coneGeometry(p, -0.012)
          : B.polygonGeometry(p.polygon, p.holes, offsetZ(B.patchZ(p), -0.012)), { patch: i });
      });
    },
    editFields: ['patches', 'notes'],
    shapes: (el) => (el.rec.patches || []).map((p, i) => ({ p, i })).filter(({ p }) => p.polygon && !(p.modeled_as === 'cone' && p.cone))
      .map(({ p, i }) => { const c = p.polygon.reduce((a, q) => [a[0] + q[0] / p.polygon.length, a[1] + q[1] / p.polygon.length], [0, 0]);
        return { path: `patches.${i}.polygon`, closed: true, z: B.patchZ(p)(c[0], c[1]) - 0.012 }; }),
    xf: X.ceilingXf,
    editDeps: (el) => ceilingBulkheads(el.rec).map((b) => b.id),     // moving / turning a ceiling takes its bulkheads along
    actions: (el) => ((el.rec.patches || []).length > 1 ? ['merge-patches', 'delete'] : ['delete']), deletable: true,
    noPoints: () => 'This ceiling is a cone (apex, slope and radius), not an outline: its shape has no corners to drag.',
    props(el, h) {
      const r = el.rec;
      return h.row('room', h.link(r.room)) + h.row('patches', `${(r.patches || []).length} (${[...new Set((r.patches || []).map((p) => p.kind))].join(', ')})`);
    },
    evidence: (el) => [`${(el.rec.patches || []).length} patches · main ${num(el.rec.main_z, 2)} · ${esc(el.rec.method || '')}`],
    related: (el) => [el.rec.room],
    queue: { label: 'ceilings', on: false }, layer: { label: 'ceilings', rank: 3, on: true },
  },

  floor: {
    key: 'floors', order: 4, levels: roomLevel, tint: 0.6,
    color: () => TYPE_COLORS.floor, legend: [['floor', TYPE_COLORS.floor]],
    draw(el, api) { api.mesh(B.polygonGeometry(el.rec.polygon, el.rec.holes, offsetZ(B.floorZ(el.rec), 0.012))); },
    editFields: ['z', 'polygon', 'notes'],
    shapes: polyShape('polygon', (r) => (r.z ?? floorOf(r)) + 0.012),
    xf: X.floorXf,
    actions: ['delete'], deletable: true,
    fields(el) {
      const r = el.rec;
      return r.modeled_as !== 'plane' ? [{ label: 'z', input: 'num', get: () => r.z, set: (v) => ({ z: mm(v) }) }] : [];
    },
    props: (el, h) => h.row('room', h.link(el.rec.room)) + h.row('z', num(el.rec.z, 3)),
    related: (el) => [el.rec.room],
    layer: { label: 'floors', rank: 2, on: true },
  },

  stair: {
    key: 'stairs', order: 5, levels: (rec) => (rec.connects_levels || []).filter(Boolean),
    color: () => TYPE_COLORS.stair, legend: [['stair', TYPE_COLORS.stair]],
    draw(el, api) {
      const r = el.rec;
      for (const f of r.flights || []) for (const t of f.tread_geometry || []) api.mesh(B.polygonGeometry(t.polygon, null, () => t.z + 0.006));
      for (const l of r.landings || []) api.mesh(B.polygonGeometry(l.polygon, null, () => l.z + 0.006));
    },
    editFields: ['flights', 'landings', 'bottom_z', 'top_z', 'notes'],
    xf: X.stairXf, actions: ['delete'], deletable: true,
    noPoints: () => 'A stair is generated from its flights (rise, going, width): its treads cannot be dragged one by one yet. Move / Rotate move the whole stair.',
    props(el, h) {
      const r = el.rec;
      return h.row('type', esc(r.type)) + h.row('levels', esc((r.connects_levels || []).join(' → ')))
        + h.row('risers', `${r.n_risers} · rise ${num(r.total_rise, 2)} m`);
    },
    evidence: (el) => [`${esc(el.rec.type)} · ${(el.rec.connects_levels || []).join(' → ')} · ${el.rec.n_risers} risers`],
    queue: { label: 'stairs', on: false }, layer: { label: 'stairs', rank: 4, on: true },
  },

  column: {
    key: 'columns', order: 6, levels: ownLevel,
    color: () => TYPE_COLORS.column, legend: [['column / post', TYPE_COLORS.column]],
    draw(el, api) { api.mesh(B.prismGeometry(el.rec.footprint, el.rec.base_z, el.rec.top_z)); },
    editFields: ['footprint', 'base_z', 'top_z', 'notes'],
    fields: (el) => [zField(el.rec, 'base z', 'base_z'), zField(el.rec, 'top z', 'top_z'), notesField(el.rec)],
    props: (el, h) => kvRows(el, h, ['name', 'shape', 'attached_to', 'angle_deg', 'confidence']),
    evidence: (el) => [`${esc(el.rec.shape || 'column')} · ${num(el.rec.base_z, 2)}–${num(el.rec.top_z, 2)} m`],
    listInfo: (el) => el.rec.name || '', tooltip: () => 'column',
    related: (el) => el.rec.attached_to || [],
    actions: ['delete'], deletable: true,
    xf: X.columnXf, match: ['base_z', 'top_z'], duplicate: (rec) => copyOf(rec),
    shapes: polyShape('footprint', (r) => r.base_z + 0.02),
    queue: { label: 'columns', on: false }, layer: { label: 'columns', rank: 7, on: true },
  },

  bulkhead: {
    key: 'bulkheads', order: 7, levels: roomLevel,          // the hand scenes give bulkheads a room, not a level
    color: () => TYPE_COLORS.bulkhead, legend: [['bulkhead / soffit', TYPE_COLORS.bulkhead]],
    draw(el, api) { if (el.rec.footprint) api.mesh(B.prismGeometry(el.rec.footprint, el.rec.bottom_z, el.rec.top_z)); },
    editFields: ['footprint', 'bottom_z', 'top_z', 'notes'],
    fields: (el) => (el.rec.footprint ? [zField(el.rec, 'bottom z', 'bottom_z', (v) => ({ depth: mm(el.rec.top_z - v) })),
      zField(el.rec, 'top z', 'top_z', (v) => ({ depth: mm(v - el.rec.bottom_z) }))] : []),
    props: (el, h) => kvRows(el, h, ['name', 'kind', 'room', 'depth', 'hangs_from', 'note']) + (el.rec.footprint ? '' : h.row('geometry', 'none (note-only entry)')),
    evidence: (el) => [`${esc(el.rec.kind || '')} · underside ${num(el.rec.bottom_z, 2)} m`],
    listInfo: (el) => el.rec.kind || '', tooltip: (el) => `bulkhead · ${el.rec.kind || ''}`,
    related: (el) => [el.rec.room],
    actions: ['delete'], deletable: true,
    xf: X.bulkheadXf, match: ['bottom_z', 'top_z', 'depth'], duplicate: (rec) => copyOf(rec),
    shapes: polyShape('footprint', (r) => r.bottom_z - 0.01),
    noPoints: () => 'This bulkhead is a note-only entry: it has no outline to edit.',
    queue: { label: 'bulkheads', on: false }, layer: { label: 'bulkheads', rank: 8, on: true },
  },

  beam: {
    key: 'beams', order: 8, levels: roomLevel,
    color: () => TYPE_COLORS.beam, legend: [['beam / rafter', TYPE_COLORS.beam]],
    draw(el, api) {
      const r = el.rec, a = r.axis.start, b = r.axis.end;
      api.mesh(a.length === 3 ? B.beam3DGeometry(a, b, r.width, r.depth) : B.axisBoxGeometry(a, b, r.width, r.bottom_z, r.top_z));
    },
    editFields: ['axis', 'width', 'depth', 'bottom_z', 'top_z', 'notes'],
    fields(el) {
      const r = el.rec, is3d = r.axis.start.length === 3;
      const bottom = (v) => {
        const d = v - r.bottom_z;
        return is3d ? { bottom_z: mm(v), top_z: mm(r.top_z + d), axis: { ...r.axis, start: [r.axis.start[0], r.axis.start[1], mm(r.axis.start[2] + d)], end: [r.axis.end[0], r.axis.end[1], mm(r.axis.end[2] + d)] } }
          : { bottom_z: mm(v), top_z: mm(v + r.depth) };
      };
      return [
        { label: 'width', input: 'num', get: () => r.width, set: (v) => ({ width: mm(Math.max(v, 0.01)) }) },
        { label: 'depth', input: 'num', get: () => r.depth, set: (v) => (is3d ? { depth: mm(Math.max(v, 0.01)) } : { depth: mm(Math.max(v, 0.01)), top_z: mm(r.bottom_z + Math.max(v, 0.01)) }) },
        { label: 'bottom z', input: 'num', get: () => r.bottom_z, set: bottom },
      ];
    },
    props: (el, h) => kvRows(el, h, ['name', 'kind', 'room', 'top_z', 'slope_deg', 'source']),
    evidence: (el) => [`${esc(el.rec.kind || 'beam')} · ${num(el.rec.width, 3)} × ${num(el.rec.depth, 3)} m${el.rec.slope_deg ? ` · slope ${num(el.rec.slope_deg, 1)}°` : ''}`],
    listInfo: (el) => el.rec.kind || el.rec.name || '', tooltip: (el) => el.rec.kind || 'beam',
    related: (el) => [el.rec.room],
    actions: ['delete'], deletable: true,
    xf: X.beamXf, match: ['width', 'depth'], duplicate: (rec) => copyOf(rec),
    shapes: (el) => [{ points: ['axis.start', 'axis.end'], z: el.rec.bottom_z }],
    queue: { label: 'beams', on: false }, layer: { label: 'beams / rafters', rank: 9, on: true },
  },

  screen: {
    key: 'screens', order: 9, levels: ownLevel,
    color: () => TYPE_COLORS.screen, legend: [['screen', TYPE_COLORS.screen]],
    draw(el, api) { const r = el.rec; api.mesh(B.axisBoxGeometry(r.axis.start, r.axis.end, r.thickness, r.base_z, r.top_z)); },
    editFields: ['axis', 'thickness', 'base_z', 'top_z', 'notes'],
    fields: (el) => [{ label: 'thickness', input: 'num', get: () => el.rec.thickness, set: (v) => ({ thickness: mm(Math.max(v, 0.005)) }) },
      zField(el.rec, 'base z', 'base_z'), zField(el.rec, 'top z', 'top_z'), notesField(el.rec)],
    props: (el, h) => kvRows(el, h, ['name', 'category']),
    evidence: (el) => [`${esc(el.rec.category || 'screen')} · ${num(el.rec.thickness, 3)} m thick`],
    listInfo: (el) => el.rec.category || '', tooltip: (el) => el.rec.category || 'screen',
    actions: ['delete'], deletable: true,
    xf: X.screenXf, match: ['thickness', 'base_z', 'top_z'], duplicate: (rec) => copyOf(rec),
    shapes: (el) => [{ points: ['axis.start', 'axis.end'], z: el.rec.base_z + 0.02 }],
    queue: { label: 'screens', on: false }, layer: { label: 'screens', rank: 10, on: true },
  },

  builtin: {
    key: 'builtins', order: 10, levels: roomLevel,
    color: (r) => (r.basin ? TYPE_COLORS.water : TYPE_COLORS.builtin), legend: [['built-in', TYPE_COLORS.builtin], ['pool / basin water', TYPE_COLORS.water]],
    draw(el, api) {
      const r = el.rec;
      if (r.basin) { const wz = r.basin.water_z ?? r.top_z - 0.15; api.mesh(B.prismGeometry(r.polygon, wz - 0.02, wz)); }
      else api.mesh(B.prismGeometry(r.polygon, r.base_z, r.top_z));
    },
    editFields: ['polygon', 'base_z', 'top_z', 'basin', 'notes'],
    fields: (el) => [zField(el.rec, 'base z', 'base_z'), zField(el.rec, 'top z', 'top_z'), notesField(el.rec)],
    props: (el, h) => kvRows(el, h, ['name', 'type', 'room', 'material', 'basin', 'confidence']),
    evidence: (el) => [`${esc(el.rec.type || 'built-in')} · ${num(el.rec.base_z, 2)}–${num(el.rec.top_z, 2)} m`],
    listInfo: (el) => el.rec.type || '', tooltip: (el) => el.rec.type || 'built-in',
    related: (el) => [el.rec.room],
    actions: ['delete'], deletable: true,
    xf: X.builtinXf, match: ['base_z', 'top_z'], duplicate: (rec) => copyOf(rec),
    shapes: polyShape('polygon', (r) => r.top_z + 0.01),
    queue: { label: 'built-ins', on: false }, layer: { label: 'built-ins', rank: 11, on: true },
  },

  railing: {
    key: 'railings', order: 11, levels: ownLevel,
    color: () => TYPE_COLORS.railing, legend: [['railing', TYPE_COLORS.railing]],
    draw(el, api) {
      const r = el.rec, h = r.height ?? r.top_z - r.base_z;
      const zb = (i) => (r.base_z_along_path ? r.base_z_along_path[i] : r.base_z);
      api.mesh(B.ribbonGeometry(r.path, 0.05, (i) => [zb(i), zb(i) + h]));
    },
    editFields: ['path', 'base_z', 'top_z', 'height', 'notes'],
    fields: (el) => [zField(el.rec, 'base z', 'base_z', (v) => ({ top_z: mm(v + (el.rec.height ?? el.rec.top_z - el.rec.base_z)) })),
      { label: 'height', input: 'num', get: () => el.rec.height ?? el.rec.top_z - el.rec.base_z, set: (v) => ({ height: mm(v), top_z: mm(el.rec.base_z + v) }) }],
    props: (el, h) => kvRows(el, h, ['name', 'infill', 'handrail', 'stair', 'confidence']),
    evidence: (el) => [`${esc(el.rec.infill || 'railing')} · ${num(el.rec.height, 2)} m high`],
    listInfo: (el) => el.rec.name || '', tooltip: () => 'railing',
    related: (el) => (el.rec.stair ? [el.rec.stair] : []),
    actions: ['delete'], deletable: true,
    xf: X.railingXf, shapes: (el) => [{ path: 'path', closed: false, z: el.rec.base_z }],
    queue: { label: 'railings', on: false }, layer: { label: 'railings', rank: 12, on: true },
  },

  skylight: {
    key: 'skylights', order: 12, levels: ownLevel,
    color: () => TYPE_COLORS.skylight, legend: [['skylight', TYPE_COLORS.skylight]],
    draw(el, api) {
      const r = el.rec;
      if (r.ring) api.mesh(B.ringGeometry(r.center, r.ring.r_inner, r.ring.r_outer, r.ring.z_bottom, r.ring.z_top));
      const gz = r.glazing && r.glazing.z;
      if (gz != null) api.mesh(B.ringGeometry(r.center, 0, r.opening_radius, gz - 0.005, gz + 0.005), { part: 'glazing' });
    },
    editFields: ['center', 'opening_radius', 'ring', 'glazing', 'notes'],
    props: (el, h) => kvRows(el, h, ['name', 'host_ceiling', 'center', 'opening_radius', 'ring', 'glazing', 'confidence']),
    evidence: (el) => [`opening radius ${num(el.rec.opening_radius, 2)} m`],
    listInfo: (el) => el.rec.name || '', tooltip: () => 'skylight',
    related: (el) => [el.rec.host_ceiling],
    xf: X.skylightXf, actions: ['delete'], deletable: true,
    shapes: (el) => [{ points: ['center'], z: el.rec.ring ? el.rec.ring.z_bottom : (el.rec.glazing?.z ?? 0) }],
    queue: { label: 'skylights', on: false }, layer: { label: 'skylights', rank: 13, on: true },
  },

  separator: {
    key: 'separators', order: 13, levels: ownLevel,
    color: () => TYPE_COLORS.separator, legend: [['virtual separator', TYPE_COLORS.separator]],
    draw(el, api) { const z = floorOf(el.rec); api.mesh(B.ribbonGeometry(el.rec.line, 0.02, () => [z, z + 0.6])); },
    editFields: ['line'],
    props: (el, h) => kvRows(el, h, ['name', 'line']),
    evidence: (el) => [esc(el.rec.name || '')],
    listInfo: (el) => el.rec.name || '', tooltip: () => 'virtual separator',
    actions: ['delete'], deletable: true,
    xf: X.separatorXf, shapes: (el) => [{ path: 'line', closed: false, z: floorOf(el.rec) + 0.02 }],
    queue: { label: 'separators', on: false }, layer: { label: 'separators', rank: 14, on: true },
  },

  unscanned: {
    key: 'unscanned_spaces', order: 14, levels: ownLevel, tint: 0.6,
    color: () => TYPE_COLORS.unscanned, legend: [['unscanned space', TYPE_COLORS.unscanned]],
    draw(el, api) { const z = floorOf(el.rec) + 0.02; api.mesh(B.polygonGeometry(el.rec.polygon, null, () => z)); },
    editFields: ['polygon'],
    shapes: polyShape('polygon', (r) => floorOf(r) + 0.02),
    afterEdit(el, api) { const p = el.rec.polygon; if (p && p.length > 2) el.rec.area = mm(shoelace(p)); api.rebuild(el); },
    fields: (el) => [{ label: 'name', input: 'text', get: () => el.rec.name || '', set: (v) => ({ name: v || null }) }],
    actions: ['delete'], deletable: true,
    props: (el, h) => kvRows(el, h, ['name', 'area']),
    evidence: (el) => [esc(el.rec.name || '')],
    listInfo: (el) => el.rec.name || '', tooltip: () => 'unscanned space',
    queue: { label: 'unscanned spaces', on: false }, layer: { label: 'unscanned spaces', rank: 15, on: true },
  },
};

/** Kinds in registry order (walls first, then openings: the build order). */
export const KINDS = Object.keys(TYPES);
/** Kinds in display / review order. */
export const KINDS_BY_ORDER = [...KINDS].sort((a, b) => (TYPES[a].order ?? 99) - (TYPES[b].order ?? 99));
export const typeOf = (kind) => TYPES[kind];
export const levelsOf = (kind, rec) => (TYPES[kind].levels || ownLevel)(rec);
/** Why an element cannot be edited (null when it can). */
export const readOnlyReason = (el) => (el && TYPES[el.kind].readOnly ? TYPES[el.kind].readOnly(el) : null);

/** Visibility layers: one per type with a `layer`, plus extra layers (room labels). */
export function layers() {
  const out = [];
  for (const k of KINDS) {
    const t = TYPES[k];
    if (t.layer) out.push({ key: k, ...t.layer });
    for (const x of t.extraLayers || []) out.push(x);
  }
  return out.sort((a, b) => a.rank - b.rank);
}
