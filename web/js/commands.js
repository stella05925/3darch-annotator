// Commands: the only way the annotation changes.
//
// Edits run as transactions: beginEdit() snapshots the records an edit can touch (the element plus its dependents:
// a wall's openings, an opening's host wall), the edit then changes primary fields and recomputes derived ones
// live, and commit() records the exact before / after of every changed top-level field (derived ones included).
// Undo and redo write those exact values back and only rebuild meshes, so undoing everything restores the JSON
// byte for byte. Door / window detail fields follow their opening in the same transaction (see followDetails).
//
//   {op:'set', kind, id, before:{key: value}, after:{key: value}, beforeAbsent:[keys], afterAbsent:[keys]}
//   {op:'add', kind, rec, index}   {op:'delete', kind, rec, index}
//   {op:'review', id, before, after}
//   {op:'batch', cmds:[...]}
// plus `opName` (structured operation, e.g. 'wall.translate'), `label` (for people), `via` (input method) and,
// for transforms, `input`, `constraint`, `snaps` and a sampled `path`.
import * as M from './model.js';
import { TYPES } from './registry.js';
import { S, ctx, EL, $, reviewOf, recOf, toast } from './state.js';
import { addElementObject, removeElementObject, buildElement, refreshElement, styleElement } from './render.js';
import { select, computeRelated } from './selection.js';
import { buildHandles } from './tools.js';
import { renderProps, scheduleList } from './panel.js';
import { renderQueueCard } from './review.js';
import { updateSaveState } from './scene.js';
import { logCommand } from './logging.js';
import { updateGumball } from './gumball.js';
import { rot } from './xform.js';

// ------------------------------------------------------------------ records in and out of the document
export function insertRecord(kind, rec, index, at) {
  const key = TYPES[kind].key;
  const copy = M.clone(rec);
  ctx.DOC[key].splice(Math.min(index ?? ctx.DOC[key].length, ctx.DOC[key].length), 0, copy);
  const t = TYPES[kind], api = { rebuild: buildElement };
  if (t.beforeInsert) t.beforeInsert(copy, api, at);   // e.g. wall: junction extensions, level wall list
  const el = addElementObject(kind, copy);
  if (t.afterInsert) t.afterInsert(copy, api, at);     // e.g. opening: host wall's openings list
  return el;
}
export function removeRecord(kind, id) {
  const key = TYPES[kind].key;
  const i = ctx.DOC[key].findIndex((r) => r.id === id);
  if (i < 0) return;
  const rec = ctx.DOC[key][i];
  ctx.DOC[key].splice(i, 1);
  const el = EL.get(id);
  if (el) removeElementObject(el);
  const at = TYPES[kind].onRemove ? TYPES[kind].onRemove(rec, { rebuild: buildElement }) : undefined;
  S.selected.delete(id);
  if (S.sel === id) select(null, 'removed');
  return at;
}

// ------------------------------------------------------------------ trash (deleted elements stay listed and restorable)
export const trash = () => (ctx.DOC.annotation_tool.deleted = ctx.DOC.annotation_tool.deleted || {});
function trashPut(cmd, review) {
  const T = trash(), seq = Math.max(0, ...Object.values(T).map((e) => e.seq || 0)) + 1;
  T[cmd.rec.id] = { kind: cmd.kind, seq, index: cmd.index, ref_index: cmd.at ?? null, deleted_by: ctx.annotator,
    deleted_at: new Date().toISOString(), review: review ? M.clone(review) : null, rec: M.clone(cmd.rec) };
}
function trashTake(id) { delete trash()[id]; }

/**
 * Restore deleted elements (one undoable command). A wall comes back with the openings deleted along with it (a room
 * with its floor and ceiling); an opening whose wall is deleted brings its wall back. Restored in reverse deletion order, so each lands where it was.
 */
export function restoreDeleted(id, via = 'panel') {
  const T = trash(), want = new Set();
  const addWall = (wid) => {
    if (!T[wid] || want.has(wid)) return;
    want.add(wid);
    for (const oid of T[wid].rec.openings || []) if (T[oid] && T[oid].rec.host_wall === wid) want.add(oid);
  };
  const e = T[id];
  if (!e) return false;
  if (e.kind === 'wall') addWall(id);
  else if (e.kind === 'opening' && T[e.rec.host_wall]) { addWall(e.rec.host_wall); want.add(id); }
  else want.add(id);
  // a room comes back with the floor and ceiling deleted along with it
  if (e.kind === 'room') for (const [x, t] of Object.entries(T)) if ((t.kind === 'floor' || t.kind === 'ceiling') && t.rec.room === id) want.add(x);
  const order = [...want].sort((a, b) => T[b].seq - T[a].seq);
  const cmds = order.map((x) => ({ op: 'restore', kind: T[x].kind, rec: M.clone(T[x].rec), entry: M.clone(T[x]) }));
  const label = `restore ${id}${cmds.length > 1 ? ` (+${cmds.length - 1})` : ''}`;
  commit(cmds.length === 1 ? { ...cmds[0], opName: `${e.kind}.restore`, label, via } : { op: 'batch', cmds, opName: `${e.kind}.restore`, label, via });
  return order;
}

export function setReview(id, val) {
  if (val) ctx.DOC.annotation_tool.review[id] = val; else delete ctx.DOC.annotation_tool.review[id];
  const el = EL.get(id);
  if (el) styleElement(el);
}

/** Rebuild an element's meshes (and the meshes that depend on it) without recomputing any field. */
export function rebuildExact(el) {
  if (!el) return;
  const t = TYPES[el.kind];
  if (t.rebuild) t.rebuild(el, { rebuild: buildElement }); else buildElement(el);
  if (S.sel === el.id || S.related.has(el.id)) { computeRelated(); buildHandles(); }
}

const delPath = (obj, path) => {
  const ks = path.split('.'); let o = obj;
  for (const k of ks.slice(0, -1)) { if (o == null) return; o = o[k]; }
  if (o) delete o[ks[ks.length - 1]];
};

export function applyCmd(cmd, dir) {
  switch (cmd.op) {
    case 'batch': (dir === 'do' ? cmd.cmds : [...cmd.cmds].reverse()).forEach((c) => applyCmd(c, dir)); break;
    case 'set': {
      const el = EL.get(cmd.id); if (!el) return;
      for (const [p, v] of Object.entries(dir === 'do' ? cmd.after : cmd.before)) M.setPath(el.rec, p, M.clone(v));
      for (const p of (dir === 'do' ? cmd.afterAbsent : cmd.beforeAbsent) || []) delPath(el.rec, p);
      if (cmd.exact === false) refreshElement(el); else rebuildExact(el);
      break;
    }
    case 'add': if (dir === 'do') insertRecord(cmd.kind, cmd.rec, cmd.index); else removeRecord(cmd.kind, cmd.rec.id); break;
    // a delete remembers where the id sat in its cross-reference list (wall openings, level walls) for an exact undo,
    // and keeps the record in the trash (annotation_tool.deleted) so it stays listed and can be restored
    case 'delete':
      if (dir === 'do') { const review = reviewOf(cmd.rec.id); cmd.at = removeRecord(cmd.kind, cmd.rec.id); trashPut(cmd, review); }
      else { trashTake(cmd.rec.id); insertRecord(cmd.kind, cmd.rec, cmd.index, cmd.at); }
      break;
    // restore from the trash: cmd.entry is the trash entry (put back unchanged on undo)
    case 'restore':
      if (dir === 'do') { trashTake(cmd.rec.id); insertRecord(cmd.kind, cmd.rec, cmd.entry.index, cmd.entry.ref_index); }
      else { removeRecord(cmd.kind, cmd.rec.id); trash()[cmd.rec.id] = M.clone(cmd.entry); }
      break;
    case 'review': setReview(cmd.id, dir === 'do' ? cmd.after : cmd.before); break;
    default: console.warn('unknown command', cmd);
  }
}

export function idsOf(cmd) {
  if (cmd.op === 'batch') return [...new Set(cmd.cmds.flatMap(idsOf))];
  if (cmd.op === 'add' || cmd.op === 'delete' || cmd.op === 'restore') return [cmd.rec.id];
  return [cmd.id];
}
export function reviewStamp(status, extra = {}) { return { status, by: ctx.annotator, at: new Date().toISOString(), ...extra }; }

/** Edits mark their elements as fixed / added / deleted (in the same undo step). `only`: ids to mark. */
function autoReview(cmd, only = null) {
  const out = [];
  const visit = (c) => {
    if (c.op === 'batch') return c.cmds.forEach(visit);
    if (c.op === 'review') return;
    const id = c.op === 'set' ? c.id : c.rec.id;
    if (only && !only.has(id)) return;
    const prev = reviewOf(id);
    let next = null;
    // automatic marks keep the editor's note and evidence level
    const keep = prev ? Object.fromEntries(['note', 'evidence', 'evidence_by', 'evidence_at'].filter((k) => prev[k] != null).map((k) => [k, prev[k]])) : {};
    if (c.op === 'set' && !(prev && ['fixed', 'added'].includes(prev.status))) next = reviewStamp('fixed', keep);
    if (c.op === 'add') next = reviewStamp('added');
    if (c.op === 'delete') next = reviewStamp('wrong', { deleted: true });
    if (c.op === 'restore') {                                  // back to the review it had before it was deleted
      if (!out.some((r) => r.id === id)) out.push({ op: 'review', opName: 'review.auto', id, before: M.clone(prev), after: M.clone(c.entry.review || null), via: 'auto' });
      return;
    }
    if (next && !out.some((r) => r.id === id)) out.push({ op: 'review', opName: 'review.auto', id, before: M.clone(prev), after: next, via: 'auto' });
  };
  visit(cmd);
  return out;
}

/** Record a command that is not a field edit (add, delete, review, batches of those), with its review marks. */
export function commit(cmd, { applied = false } = {}) {
  const extra = autoReview(cmd);
  if (!extra.length) return ctx.history.exec(cmd, { applied });
  if (!applied) applyCmd(cmd, 'do');
  extra.forEach((c) => applyCmd(c, 'do'));
  // the wrapper carries the command's metadata (op name, input, constraint, snaps, path ...) for the log
  const { op, cmds, kind, id, rec, index, before, after, beforeAbsent, afterAbsent, ...meta } = cmd;
  ctx.history.exec({ ...meta, op: 'batch', cmds: [cmd, ...extra] }, { applied: true });
}

export function onHistory(action, cmd) {
  logCommand(action, cmd);
  S.dirty += 1;
  updateSaveState();
  $('#btn-undo').disabled = !ctx.history.undoStack.length;
  $('#btn-redo').disabled = !ctx.history.redoStack.length;
  if (S.sel && !EL.has(S.sel)) select(null, 'removed');
  for (const id of [...S.selected]) if (!EL.has(id)) S.selected.delete(id);
  renderProps(); renderQueueCard(); scheduleList(); updateGumball();
}

// ------------------------------------------------------------------ door / window details
const DETAIL = {
  door: ['hinge_point', 'leaf_direction', 'open_angle_deg', 'glass_planes_y', 'parked_span', 'leaf_face_x'],
  window: ['panes', 'mullions_u_from_jamb_start'],
};
/** Detail fields present on an opening ('door.hinge_point', ...). */
export function detailPaths(o) {
  const out = [];
  for (const blk of Object.keys(DETAIL)) {
    const b = o[blk];
    if (!b || typeof b !== 'object') continue;
    for (const k of DETAIL[blk]) if (b[k] != null) out.push(`${blk}.${k}`);
  }
  return out;
}
function placement(o, w) {
  if (!o || !w) return null;
  if (w.shape === 'arc') {                                  // round wall: the chord's middle, the tangent there
    const P = o.position, span = M.relDeg(P.theta_end, P.theta_start), mid = P.theta_start + span / 2;
    return { host: w.id, c: P.center, ang: (mid + 90) * M.DEG, width: P.width, height: o.head_z - o.sill_z };
  }
  const f = M.wallFrame(w), P = o.position;
  return { host: w.id, c: M.at(f, (P.u_start + P.u_end) / 2), ang: Math.atan2(f.t[1], f.t[0]),
    width: P.u_end - P.u_start, height: o.head_z - o.sill_z };
}
/**
 * After an edit: a pure move of the opening (same host, same size; also when its wall moves or turns) moves its
 * point-valued detail fields rigidly with it. Anything else (a resize, a new host) is not guessed: the fields are
 * listed in the record's `stale_detail` and the panel warns. Axis-specific values (glass_planes_y, leaf_face_x)
 * cannot follow a rotation and become stale then. Relative values (angles, panes, mullion offsets) do not change.
 */
function followDetails(o, o0, w0, w1) {
  const paths = detailPaths(o0);
  if (!paths.length) return;
  const P0 = placement(o0, w0), P1 = placement(o, w1);
  if (!P0 || !P1) return;
  const rigid = P0.host === P1.host && Math.abs(P0.width - P1.width) < 1e-4 && Math.abs(P0.height - P1.height) < 1e-4;
  const a = P1.ang - P0.ang, dx = P1.c[0] - P0.c[0], dy = P1.c[1] - P0.c[1];
  if (rigid && Math.hypot(dx, dy) < 1e-7 && Math.abs(a) < 1e-9) return;
  const stale = new Set(o.stale_detail || []);
  if (!rigid) paths.forEach((p) => stale.add(p));
  else {
    const rotated = Math.abs(a) > 1e-9;
    const tp = (p) => { const q = rot(p, P0.c, a); return [M.r4(q[0] + dx), M.r4(q[1] + dy)]; };
    for (const path of paths) {
      const [blk, k] = path.split('.'), v = o0[blk][k], b = o[blk];
      if (k === 'hinge_point') b[k] = tp(v);
      else if (k === 'parked_span') b[k] = v.map(tp);
      else if (k === 'leaf_direction') b[k] = rotated ? rot(v, [0, 0], a).map(M.r4) : v;
      else if (k === 'leaf_face_x') { if (rotated) stale.add(path); else b[k] = M.r4(v + dx); }
      else if (k === 'glass_planes_y') { if (rotated) stale.add(path); else b[k] = Array.isArray(v) ? v.map((y) => M.r4(y + dy)) : M.r4(v + dy); }
    }
  }
  if (stale.size) o.stale_detail = [...stale].sort();
}

// ------------------------------------------------------------------ edit transactions
function diffRecords(a, b) {
  const before = {}, after = {}, beforeAbsent = [], afterAbsent = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
    if (k in a) before[k] = M.clone(a[k]); else beforeAbsent.push(k);
    if (k in b) after[k] = M.clone(b[k]); else afterAbsent.push(k);
  }
  if (!Object.keys(before).length && !Object.keys(after).length && !beforeAbsent.length && !afterAbsent.length) return null;
  return { before, after, ...(beforeAbsent.length ? { beforeAbsent } : {}), ...(afterAbsent.length ? { afterAbsent } : {}) };
}
function restore(rec, snap) {
  for (const k of Object.keys(rec)) if (!(k in snap)) delete rec[k];
  Object.assign(rec, M.clone(snap));
}

/** Start an edit of some elements: snapshots them and their dependents. */
export function beginEdit(ids) {
  const tx = { snap: new Map(), primary: new Set(ids), done: false };
  tx.ensure = (id) => {
    if (!id || tx.snap.has(id)) return;
    const el = EL.get(id);
    if (el) tx.snap.set(id, { kind: el.kind, rec: M.clone(el.rec) });
  };
  for (const id of ids) {
    tx.ensure(id);
    const el = EL.get(id), t = el && TYPES[el.kind];
    if (t && t.editDeps) for (const d of t.editDeps(el)) tx.ensure(d);
  }
  tx.rec0 = (id) => (tx.snap.get(id) || {}).rec;
  tx.commit = (meta = {}) => commitEdit(tx, meta);
  tx.cancel = () => cancelEdit(tx);
  return tx;
}

/** Undo an unfinished edit exactly (cancelled transform, drag that changed nothing). */
export function cancelEdit(tx) {
  if (tx.done) return;
  tx.done = true;
  for (const [id, s] of tx.snap) { const el = EL.get(id); if (el) restore(el.rec, s.rec); }
  for (const id of tx.snap.keys()) rebuildExact(EL.get(id));
}

/** Record an edit as one undoable command. Returns false (and restores everything) when nothing changed. */
export function commitEdit(tx, meta = {}) {
  if (tx.done) return false;
  for (const [id, s] of tx.snap) {
    if (s.kind !== 'opening') continue;
    const el = EL.get(id); if (!el) continue;
    const w0 = (tx.snap.get(s.rec.host_wall) || {}).rec || recOf(s.rec.host_wall);
    followDetails(el.rec, s.rec, w0, recOf(el.rec.host_wall));
  }
  const leaves = [];
  for (const [id, s] of tx.snap) {
    const el = EL.get(id); if (!el) continue;
    const d = diffRecords(s.rec, el.rec);
    if (d) leaves.push({ op: 'set', kind: s.kind, id, ...d });
  }
  if (!leaves.some((l) => tx.primary.has(l.id))) { cancelEdit(tx); return false; }
  tx.done = true;
  const reviews = autoReview({ op: 'batch', cmds: leaves }, tx.primary);
  reviews.forEach((c) => applyCmd(c, 'do'));
  const cmds = [...leaves, ...reviews];
  const cmd = cmds.length === 1 ? { ...cmds[0], ...meta } : { op: 'batch', cmds, ...meta };
  ctx.history.exec(cmd, { applied: true });
  return true;
}

/** Set some fields of one element as one undoable edit ({path: value}); derived fields are recomputed. */
export function setFields(el, after, label, via, extra = {}) {
  const tx = beginEdit([el.id]);
  let changed = false;
  for (const [p, v] of Object.entries(after)) {
    if (JSON.stringify(M.getPath(el.rec, p)) !== JSON.stringify(v)) { M.setPath(el.rec, p, M.clone(v)); changed = true; }
  }
  if (!changed) { tx.cancel(); return false; }
  refreshElement(el);
  return tx.commit({ label, via, ...extra });
}

/** Run fn(el) on several elements as one edit (align, distribute, match properties ...). */
export function editMany(ids, fn, meta) {
  const tx = beginEdit(ids);
  for (const id of ids) { const el = EL.get(id); if (el) { fn(el, tx); refreshElement(el); } }
  const ok = tx.commit(meta);
  if (!ok) toast('Nothing changed.');
  return ok;
}
