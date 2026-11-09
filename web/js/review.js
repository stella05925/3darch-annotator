// Review decisions and the guided review queue (a fixed list built from the filters, in registry order: walls first,
// because openings and rooms depend on them).
import * as M from './model.js';
import { TYPES, KINDS_BY_ORDER } from './registry.js';
import { S, EL, $, $$, esc, clamp, log, reviewOf, statusOf, evidenceOf, EVIDENCE, CONF_RANK, ctx } from './state.js';
import { focusOn } from './render.js';
import { select } from './selection.js';
import { commit, reviewStamp } from './commands.js';

export function review(id, status, via) {
  const prev = reviewOf(id);
  const after = status ? reviewStamp(status, prev && prev.note ? { note: prev.note } : {}) : null;
  if (prev && after && prev.status === after.status) return;
  commit({ op: 'review', opName: 'review.set', id, before: M.clone(prev), after, label: `${id}: ${status || 'clear'}`, via });
}
/** Set (or clear, level null) how much of the element is based on the scan. One undoable command. */
export function setEvidence(id, level, via) {
  const prev = reviewOf(id);
  if ((prev && prev.evidence || null) === level) return;
  const after = { ...(prev || reviewStamp('none')) };
  if (level) Object.assign(after, { evidence: level, evidence_by: ctx.annotator, evidence_at: new Date().toISOString() });
  else { delete after.evidence; delete after.evidence_by; delete after.evidence_at; }
  commit({ op: 'review', opName: 'review.evidence', id, before: M.clone(prev), after, label: `${id}: ${level ? EVIDENCE[level].label : 'no evidence level'}`, via });
}
export function reviewNote(id, note) {
  const prev = reviewOf(id);
  if ((prev && prev.note || '') === note) return;
  const after = { ...(prev || reviewStamp('none')), note, by: ctx.annotator, at: new Date().toISOString() };
  commit({ op: 'review', opName: 'review.note', id, before: M.clone(prev), after, label: `${id}: note`, via: 'note' });
}

export const Q = { items: [], i: 0, opened: false };
export function rebuildQueue(via = 'filters') {
  const kinds = $$('#q-kinds input:checked').map((x) => x.value);
  const scopeLevel = $('#q-scope').value === 'level' ? S.level : null;
  const onlyNew = $('#q-unreviewed').checked, lowFirst = $('#q-lowconf').checked;
  const items = [...EL.values()].filter((el) => kinds.includes(el.kind)
    && (!scopeLevel || el.levels.includes(scopeLevel))
    && (!onlyNew || evidenceOf(el.id) === 'none'));
  items.sort((a, b) => KINDS_BY_ORDER.indexOf(a.kind) - KINDS_BY_ORDER.indexOf(b.kind)
    || (lowFirst ? (CONF_RANK[a.rec.confidence] ?? 3) - (CONF_RANK[b.rec.confidence] ?? 3) : 0)
    || (a.levels[0] || '').localeCompare(b.levels[0] || '') || a.id.localeCompare(b.id));
  Q.items = items.map((el) => el.id); Q.i = 0; Q.opened = false;
  log('queue_build', { via, kinds, scope: scopeLevel || 'all', only_unreviewed: onlyNew, low_conf_first: lowFirst, n: Q.items.length });
  renderQueueCard();
}
export function queueGo(delta, via) {
  if (!Q.items.length) return;
  if (Q.opened) Q.i = clamp(Q.i + delta, 0, Q.items.length - 1);   // the first press opens the current item
  openQueueItem(via);
}
export function openQueueItem(via) {
  Q.opened = true;
  const id = Q.items[Q.i];
  const el = EL.get(id);
  if (!el) { renderQueueCard(); return; }
  select(id, 'queue');
  focusOn(el, 'queue');
  log('queue', { action: via, index: Q.i, total: Q.items.length, id });
  renderQueueCard();
}
/** Rate the selected element (or the queue item) and move on to the next queue item. */
export function queueDecide(level, via) {
  const id = S.sel || Q.items[Q.i];   // the selected element, which is the queue item unless the user clicked elsewhere
  if (!id) return;
  setEvidence(id, level, via);
  if (Q.items[Q.i] === id && Q.i < Q.items.length - 1) queueGo(1, 'after_decision');
  else renderQueueCard();
}

function cardRows(el) {
  const t = TYPES[el.kind];
  const rows = t.evidence ? [...t.evidence(el)] : [];
  if (el.rec.notes) rows.push(`<i>${esc(el.rec.notes)}</i>`);
  return rows.map((x) => `<div>${x}</div>`).join('');
}
export function renderQueueCard() {
  const n = Q.items.length;
  const done = Q.items.filter((id) => evidenceOf(id) !== 'none').length;
  $('#q-progress > div').style.width = n ? `${(100 * done) / n}%` : '0';
  const id = Q.items[Q.i], el = id && EL.get(id);
  if (!n) { $('#q-card').innerHTML = '<span class="muted">Nothing to review with these filters.</span>'; return; }
  if (!el) { $('#q-card').innerHTML = `<span class="muted">Item ${Q.i + 1} of ${n} was deleted.</span>`; return; }
  const st = statusOf(id), ev = evidenceOf(id);
  $('#q-card').innerHTML = `<h4>${esc(el.kind)} · ${esc(id)} ${st !== 'none' ? `<span class="badge ${st}">${st}</span>` : ''}${ev !== 'none' ? `<span class="badge ev-${ev}">${esc(EVIDENCE[ev].label)}</span>` : ''}</h4>
    <div class="meta">${Q.i + 1} of ${n} · ${done} rated · level ${esc(el.levels.join(', ') || '—')} · Opus confidence <b>${esc(el.rec.confidence || '—')}</b></div>
    <div class="evidence">${cardRows(el)}</div>`;
}
