// Logging glue: what gets logged for commands (structured op + schema version), camera moves, idle time, window
// focus and errors. The transport (buffering, posting) is logger.js.
import { S, ctx, EL, mm, log, LOG_SCHEMA_VERSION } from './state.js';
import { camera, controls, controlsP, controlsO, controlsE, anim } from './render.js';
import { idsOf } from './commands.js';
import { handleBusy } from './tools.js';
import { gizmoBusy } from './gumball.js';
import { modalActive } from './modal.js';

/** Structured operation name of a command: set where the command is made, derived for anything older. */
export function opNameOf(cmd) {
  if (cmd.opName) return cmd.opName;
  switch (cmd.op) {
    case 'batch': return cmd.cmds.length ? opNameOf(cmd.cmds[0]) : 'batch';
    case 'add': return `${cmd.kind}.add`;
    case 'delete': return `${cmd.kind}.delete`;
    case 'restore': return `${cmd.kind}.restore`;
    case 'review': return cmd.via === 'auto' ? 'review.auto' : 'review.set';
    case 'set': return `${cmd.kind}.edit`;
    default: return cmd.op;
  }
}

function summarize(cmd) {
  switch (cmd.op) {
    case 'batch': return { op: 'batch', cmds: cmd.cmds.map(summarize) };
    case 'set': return { op: 'set', kind: cmd.kind, id: cmd.id, before: cmd.before, after: cmd.after };
    case 'add': case 'delete': return { op: cmd.op, kind: cmd.kind, id: cmd.rec.id, rec: cmd.rec };
    case 'restore': return { op: 'restore', kind: cmd.kind, id: cmd.rec.id };
    case 'review': return { op: 'review', id: cmd.id, via: cmd.via, before: cmd.before && cmd.before.status, after: cmd.after && cmd.after.status,
      evidence_before: cmd.before && cmd.before.evidence, evidence_after: cmd.after && cmd.after.evidence, note: cmd.after && cmd.after.note };
    default: return { op: cmd.op };
  }
}

/**
 * One 'cmd' event per command done, undone or redone. Transforms add: input (gumball / keyboard / panel / numeric /
 * handle / layout), constraint (axis, space, pivot), every snap target hit, the drag path sampled at 10 Hz and the
 * duration. Before / after values are those of the changed fields only (detail).
 */
export function logCommand(action, cmd) {
  log('cmd', { action, op: opNameOf(cmd), schema_version: LOG_SCHEMA_VERSION, label: cmd.label, via: cmd.via,
    ids: idsOf(cmd), snap: cmd.snap || null, field: cmd.field, input: cmd.input, constraint: cmd.constraint,
    snaps: cmd.snaps, path: action === 'do' ? cmd.path : undefined, duration_ms: cmd.duration_ms, typed: cmd.typed,
    detail: summarize(cmd) });
}

/** A transform that was started and then cancelled (Esc / right-click): logged with `cancelled: true`. */
export function logCancelled(info) {
  log('cmd', { action: 'cancel', cancelled: true, schema_version: LOG_SCHEMA_VERSION, ...info });
}

export function camPose() {
  const t = controls.target, p = camera.position;
  return { view: S.view, wall: S.view === 'wall' ? S.elev.wall : undefined, side: S.view === 'wall' ? S.elev.side : undefined,
    pos: [p.x, p.y, p.z].map((x) => mm(x)), target: [t.x, t.y, t.z].map((x) => mm(x)), zoom: camera.isOrthographicCamera ? mm(camera.zoom) : undefined };
}

/** What the annotator is working on right now (the context of each activity tick). */
function taskContext() {
  const el = S.sel && EL.get(S.sel), a = document.activeElement;
  const typing = a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) ? (a.closest('#props') ? 'panel' : a.closest('#note-modal') ? 'note' : 'other') : null;
  return { sel: S.sel || null, kind: el ? el.kind : null, n: S.selected.size, tool: S.mode === 'select' ? S.gizmo.mode : S.mode,
    view: S.view, level: S.level, hover: S.hoverId, busy: handleBusy() ? 'handle' : gizmoBusy() ? 'gumball' : modalActive() ? 'keyboard' : null, typing };
}

/**
 * Activity: one 'tick' per second in which there was any input (pointer moves, presses, keys, wheel) or a drag /
 * keyboard transform in progress, with the input counts, whether the tab was visible and focused, and the task
 * context. Seconds without a tick had no input: AFK and thinking time are decided at analysis time (analyze.py).
 */
function initActivity() {
  const n = { move: 0, down: 0, key: 0, wheel: 0 };
  addEventListener('pointermove', () => { n.move++; }, { passive: true, capture: true });
  addEventListener('pointerdown', () => { n.down++; }, { passive: true, capture: true });
  addEventListener('keydown', () => { n.key++; }, { passive: true, capture: true });
  addEventListener('wheel', () => { n.wheel++; }, { passive: true, capture: true });
  setInterval(() => {
    const ctxNow = taskContext();
    if (n.move + n.down + n.key + n.wheel || ctxNow.busy) {
      log('tick', { in: { ...n }, vis: document.visibilityState === 'visible' ? 1 : 0, foc: document.hasFocus() ? 1 : 0, ...ctxNow });
    }
    n.move = 0; n.down = 0; n.key = 0; n.wheel = 0;
  }, 1000);
  // time spent typing in a field: focus and blur of every input (panel fields, notes, filters)
  const fieldOf = (t) => ({ field: t.id || t.dataset.f || t.name || t.tagName.toLowerCase(), where: t.closest('#props') ? 'panel' : t.closest('aside') ? 'sidebar' : 'other', el: S.sel || null });
  document.addEventListener('focusin', (e) => { if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) log('field_focus', fieldOf(e.target)); });
  document.addEventListener('focusout', (e) => { if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) log('field_blur', fieldOf(e.target)); });
}

/** Idle / focus / error tracking (for active-time metrics) and camera logging (start, end, 4 Hz samples). */
export function initLogging() {
  initActivity();
  let lastInput = performance.now(), idle = false;
  const markInput = () => {
    lastInput = performance.now();
    if (idle) { idle = false; log('idle_end'); }
  };
  ['pointerdown', 'pointermove', 'keydown', 'wheel'].forEach((ev) => addEventListener(ev, markInput, { passive: true }));
  setInterval(() => {
    if (!idle && performance.now() - lastInput > 60000) { idle = true; log('idle_start', { since_ms: Math.round(performance.now() - lastInput) }); }
  }, 5000);
  addEventListener('focus', () => log('window_focus'));
  addEventListener('blur', () => log('window_blur'));
  document.addEventListener('visibilitychange', () => log('visibility', { state: document.visibilityState }));
  addEventListener('error', (e) => log('error', { message: String(e.message), source: e.filename, line: e.lineno }));
  addEventListener('unhandledrejection', (e) => log('error', { message: String(e.reason) }));
  addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

  let camT = 0;
  for (const c of [controlsP, controlsO, controlsE]) {
    c.addEventListener('start', () => log('camera_start', camPose()));
    c.addEventListener('end', () => log('camera_end', camPose()));
    c.addEventListener('change', () => { const n = performance.now(); if (n - camT > 250 && !anim) { camT = n; log('camera', camPose()); } });
  }
  return ctx.LOG;
}
