// Properties panel (fields, rows and actions from the registry), element list and legend.
import * as M from './model.js';
import { TYPES, KINDS_BY_ORDER, layers, readOnlyReason, levelsOf } from './registry.js';
import { S, ctx, EL, $, $$, esc, num, mm, log, reviewOf, statusOf, evidenceOf, evalExpr, REVIEW_COLORS, CONF_COLORS, EVIDENCE, EVIDENCE_COLORS } from './state.js';
import { focusOn } from './render.js';
import { select } from './selection.js';
import { setFields, trash, restoreDeleted } from './commands.js';
import { setEvidence, reviewNote } from './review.js';
import { snapWallToScan, copySelected, deleteSelected, setMode } from './tools.js';
import * as L from './layout.js';
import { orderedSelection } from './gumball.js';
import { fitPanel, bindFitPanel } from './fitplane.js';
import { mergeFloors, mergeCeilings } from './merge.js';

const row = (label, html) => `<tr><td>${esc(label)}</td><td>${html}</td></tr>`;
const link = (id) => (id && EL.has(id) ? `<a data-goto="${esc(id)}">${esc(id)}</a>` : esc(id || '—'));

/** Panel action buttons (registry entries list which ones apply). */
const ACTIONS = {
  snap: { label: 'Snap faces to scan', title: 'Experimental: fit the faces to the scan', run: (el) => snapWallToScan(el) },
  'add-door': { label: '+ door', run: () => setMode('add-door', 'panel') },
  'add-window': { label: '+ window', run: () => setMode('add-window', 'panel') },
  copy: { label: 'Copy (Ctrl+C)', run: () => copySelected() },
  delete: { label: 'Delete', cls: 'bad', run: () => deleteSelected('panel') },
  'merge-patches': { label: 'Merge patches', title: 'Unite the flat patches of this ceiling that touch at the same height (within 2 cm)', run: (el) => mergeCeilings([el.id]) },
};

/** Fields of the element that differ from the original Opus annotation (null: the element is new). */
export function changedFields(el) {
  const o = ctx.ORIG[el.kind] && ctx.ORIG[el.kind].get(el.id);
  if (!o) return null;
  return (TYPES[el.kind].editFields || []).filter((p) => JSON.stringify(M.getPath(o, p)) !== JSON.stringify(M.getPath(el.rec, p)));
}
function origBadge(el) {
  const ch = changedFields(el);
  if (ch === null) return '<span class="badge edited">new</span>';
  return ch.length ? `<span class="badge edited" title="${esc(ch.join(', '))}">edited</span>` : '';
}

/** Several elements selected: what they are, and the layout tools that apply. */
function renderMulti(host) {
  const ids = orderedSelection(), els = ids.map((id) => EL.get(id));
  const kinds = {};
  for (const e of els) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  const prim = els[0];
  const btn = (act, label, title = '') => `<button data-lay="${act}" title="${esc(title)}">${esc(label)}</button>`;
  let html = `<h3>${ids.length} elements selected</h3><div class="sub">${Object.entries(kinds).map(([k, n]) => `${n} ${k}${n > 1 ? 's' : ''}`).join(' · ')}
    · reference (last clicked): <b>${esc(prim.id)}</b></div>`;
  html += `<div class="list">${els.map((e) => `<div class="it" data-goto-id="${esc(e.id)}"><span class="dot ${statusOf(e.id)}"></span>${esc(e.id)} <span class="muted">${esc(e.kind)}</span></div>`).join('')}</div>`;
  html += '<h4>Layout</h4><div class="actions">';
  if ((kinds.wall || 0) >= 2) html += btn('align-axis', 'Align axes', 'Move the walls onto the reference wall\'s axis line') + btn('align-faceL', 'Align left faces', 'Faces on the reference\'s left (+n) side onto its left face line') + btn('align-faceR', 'Align right faces');
  if ((kinds.opening || 0) >= 2) html += btn('align-sill', 'Align sills') + btn('align-head', 'Align heads');
  if (ids.length >= 3) html += btn('distribute', 'Distribute evenly', 'Equal gaps; the two outermost stay in place');
  if (els.every((e) => e.kind === 'floor')) html += btn('merge-floors', 'Merge floors', `Unite the outlines into ${prim.id}; the others are deleted (restorable)`);
  if (els.every((e) => e.kind === 'ceiling')) html += btn('merge-ceilings', 'Merge ceilings', `Move all patches into ${prim.id} and unite those that touch at the same height`);
  if (els.filter((e) => e.kind === prim.kind).length >= 2 && TYPES[prim.kind].match) html += btn('match', `Match ${TYPES[prim.kind].match.join(', ')} from ${prim.id}`);
  html += btn('duplicate', 'Duplicate (Shift+D)') + '</div>';
  html += '<p class="hint">Shift-click adds / removes elements; Shift-drag in plan view box-selects. The gumball moves and turns the whole selection.</p>';
  host.innerHTML = html;
  host.querySelectorAll('[data-goto-id]').forEach((d) => d.addEventListener('click', () => { focusOn(EL.get(d.dataset.gotoId), 'list'); }));
  host.querySelectorAll('[data-lay]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.lay;
    log('action', { act: a, ids });
    if (a.startsWith('align-')) { const m = a.slice(6); if (m === 'sill' || m === 'head') L.alignOpenings(m); else L.alignWalls(m); }
    if (a === 'distribute') L.distribute();
    if (a === 'match') L.matchProperties();
    if (a === 'duplicate') L.duplicateSelection();
    if (a === 'merge-floors') mergeFloors(ids);
    if (a === 'merge-ceilings') mergeCeilings(ids);
  }));
}

export function renderProps() {
  const host = $('#props');
  renderPropsOf(host);
  if (S.fit) { host.insertAdjacentHTML('afterbegin', fitPanel()); bindFitPanel(host); }   // a fitted scan plane, ready to apply
}
function renderPropsOf(host) {
  if (S.selected.size > 1) { renderMulti(host); return; }
  const el = S.sel && EL.get(S.sel);
  if (!el && S.trashSel && trash()[S.trashSel]) { renderDeleted(host, S.trashSel); return; }
  if (!el) {
    host.innerHTML = '<p class="muted">Click an element to inspect and edit it. Clicking the same spot again cycles through the elements behind it.</p>';
    return;
  }
  const t = TYPES[el.kind];
  const r = el.rec, rv = reviewOf(el.id), st = statusOf(el.id);
  const ro = readOnlyReason(el);
  const fields = t.fields ? t.fields(el) : [];
  let html = `<h3>${esc(r.name || r.id)}</h3><div class="sub">${esc(el.kind)} · ${esc(r.id)} · level ${esc(el.levels.join(', ') || '—')}
    ${st !== 'none' ? `<span class="badge ${st}">${st}</span>` : ''}${origBadge(el)}</div>`;
  const ev = evidenceOf(el.id);
  html += `<div class="evidence-row">${Object.entries(EVIDENCE).map(([k, v]) => `<button data-ev="${k}" class="${{ strong: 'ok', partial: 'warn', assumption: 'bad' }[k]}${ev === k ? ' on' : ''}"
      title="${esc(v.tip)} (${v.key})">${esc(v.label)}</button>`).join('')}<button data-ev="" title="Clear the evidence level">clear</button></div>
    <textarea id="rv-note" placeholder="review note (why wrong, what is missing…)">${esc(rv && rv.note || '')}</textarea>`;
  if (ro) html += `<div class="readonly">🔒 ${esc(ro)}</div>`;
  if (r.stale_detail && r.stale_detail.length) html += `<div class="readonly">⚠ Door / window details may be stale after a resize or re-host
    (not recomputed, please check): <b>${esc(r.stale_detail.join(', '))}</b></div>`;
  html += '<table>';
  fields.forEach((f, i) => {
    const v = f.get();
    let input;
    if (f.input === 'select') input = `<select data-f="${i}">${(f.options || []).concat(f.options.includes(v) ? [] : [v]).map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    else if (f.input === 'num') input = `<input data-f="${i}" class="num" inputmode="decimal" title="a value, or arithmetic: +0.05, *2, 2.4-0.1" value="${typeof v === 'number' ? mm(v) : ''}">`;
    else input = `<input data-f="${i}" value="${esc(v)}">`;
    if (ro) input = input.replace(/^<(select|input)/, '<$1 disabled');
    html += row(f.label, input);
  });
  if (t.props) html += t.props(el, { row, link });
  html += '</table><div class="actions">';
  html += '<button data-act="focus">Focus (F)</button>';
  for (const a of (typeof t.actions === 'function' ? t.actions(el) : t.actions || []).filter((x) => !ro || x === 'copy')) {
    const A = ACTIONS[a];
    html += `<button data-act="${a}"${A.cls ? ` class="${A.cls}"` : ''}${A.title ? ` title="${esc(A.title)}"` : ''}>${esc(A.label)}</button>`;
  }
  html += '</div>';
  const raw = JSON.stringify(r, (k, v) => (k === 'tread_geometry' || k === 'riser_geometry' ? `[${v.length} items]` : v), 1);
  html += `<details><summary>Raw JSON</summary><pre>${esc(raw.length > 6000 ? `${raw.slice(0, 6000)}\n…` : raw)}</pre></details>`;
  host.innerHTML = html;

  host.querySelectorAll('[data-f]').forEach((inp) => {
    const f = fields[Number(inp.dataset.f)];
    inp.addEventListener('change', () => {
      let v = inp.value;
      const typed = inp.value.trim();
      if (f.input === 'num') {
        v = evalExpr(typed, f.get());                      // arithmetic: "+0.05", "*2", "2.4-0.1"
        if (v === null) { inp.classList.add('err'); log('panel_error', { id: el.id, field: f.label, value: inp.value }); return; }
      }
      const isExpr = f.input === 'num' && !/^-?[0-9]*\.?[0-9]+$/.test(typed);
      if (!setFields(el, f.set(v), `${el.id}: ${f.label}`, 'panel', { field: f.label, opName: `${el.kind}.set_field`, input: 'panel', typed: isExpr ? typed : undefined })) renderProps();
    });
  });
  host.querySelectorAll('[data-ev]').forEach((b) => b.addEventListener('click', () => setEvidence(el.id, b.dataset.ev || null, 'panel')));
  const note = $('#rv-note');
  note.addEventListener('change', () => reviewNote(el.id, note.value));
  host.querySelectorAll('[data-goto]').forEach((a) => a.addEventListener('click', () => { select(a.dataset.goto, 'link'); focusOn(EL.get(a.dataset.goto), 'link'); }));
  host.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    const act = b.dataset.act;
    log('action', { act, id: el.id });
    if (act === 'focus') focusOn(el, 'panel');
    else ACTIONS[act].run(el);
  }));
}

/** A deleted element (clicked in the element list): what it was, who deleted it, and Restore. */
function renderDeleted(host, id) {
  const T = trash(), e = T[id], r = e.rec;
  const withIt = e.kind === 'wall' ? (r.openings || []).filter((o) => T[o] && T[o].rec.host_wall === id)
    : e.kind === 'opening' && T[r.host_wall] ? [r.host_wall]
      : e.kind === 'room' ? Object.keys(T).filter((x) => ['floor', 'ceiling'].includes(T[x].kind) && T[x].rec.room === id) : [];
  const when = (e.deleted_at || '').replace('T', ' ').slice(0, 16);
  let html = `<h3>${esc(r.name || id)}</h3><div class="sub">${esc(e.kind)} · ${esc(id)} · level ${esc(levelsOf(e.kind, r).join(', ') || '—')}
    <span class="badge wrong">deleted</span></div>`;
  html += `<p class="muted">Deleted by ${esc(e.deleted_by || '?')}${when ? ` on ${esc(when)}` : ''}. It is hidden from the view and left out of the
    annotation; the record is kept in the save (<code>annotation_tool.deleted</code>) until restored.</p>`;
  html += `<div class="actions"><button data-restore class="ok">Restore${withIt.length ? ` (with ${withIt.map(esc).join(', ')})` : ''}</button></div>`;
  const raw = JSON.stringify(r, null, 1);
  html += `<details><summary>Raw JSON</summary><pre>${esc(raw.length > 6000 ? `${raw.slice(0, 6000)}\n…` : raw)}</pre></details>`;
  host.innerHTML = html;
  host.querySelector('[data-restore]').addEventListener('click', () => {
    log('action', { act: 'restore', id });
    restoreDeleted(id, 'panel');
    S.trashSel = null;
    select(id, 'restore');
  });
}

// ------------------------------------------------------------------ element list
let listTimer = null;
export const scheduleList = () => { clearTimeout(listTimer); listTimer = setTimeout(renderList, 150); };
export function renderList() {
  const q = $('#el-filter').value.trim().toLowerCase();
  const levelOnly = $('#el-level-only').checked;
  const groups = {}, gone = {};
  // elements without a level (no level, no room) are shown on every level, in the list as in the view
  const keep = (id, r, levels) => !(levelOnly && S.level && levels.length && !levels.includes(S.level))
    && !(q && !`${id} ${r.name || ''} ${r.type || ''} ${r.category || ''}`.toLowerCase().includes(q));
  for (const el of EL.values()) if (keep(el.id, el.rec, el.levels)) (groups[el.kind] = groups[el.kind] || []).push(el);
  // deleted elements stay listed (struck through); clicking one offers Restore
  for (const [id, e] of Object.entries(trash())) if (keep(id, e.rec, levelsOf(e.kind, e.rec)) || (q && 'deleted'.includes(q))) (gone[e.kind] = gone[e.kind] || []).push(id);
  let html = '';
  for (const k of KINDS_BY_ORDER) {
    const g = groups[k] || [], d = gone[k] || [];
    if (!g.length && !d.length) continue;
    html += `<div class="grp">${k}s (${g.length}${d.length ? ` · ${d.length} deleted` : ''})</div>`;
    const rows = [...g.map((el) => [el.id, el]), ...d.map((id) => [id, null])].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
    for (const [id, el] of rows) {
      if (!el) { html += `<div class="it deleted ${S.trashSel === id ? 'sel' : ''}" data-del-id="${esc(id)}" title="deleted: click to see it or restore it"><span class="dot wrong"></span>${esc(id)} <span class="muted">deleted</span></div>`; continue; }
      const info = TYPES[k].listInfo ? TYPES[k].listInfo(el) : '';
      html += `<div class="it ${S.sel === id ? 'sel' : ''}" data-id="${esc(id)}"><span class="dot ${evidenceOf(id) !== 'none' ? `ev-${evidenceOf(id)}` : statusOf(id) === 'added' ? 'fixed' : statusOf(id)}"></span>${esc(id)} <span class="muted">${esc(info)}</span></div>`;
    }
  }
  $('#el-list').innerHTML = html || '<span class="muted">No elements.</span>';
}
export function markListSelection() {
  $$('#el-list .it').forEach((d) => d.classList.toggle('sel', d.dataset.delId ? d.dataset.delId === S.trashSel : d.dataset.id === S.sel));
}

// ------------------------------------------------------------------ legend
export function renderLegend() {
  const typeRows = layers().flatMap((l) => (TYPES[l.key] && TYPES[l.key].legend) || []);
  const sets = {
    type: typeRows,
    review: Object.entries(REVIEW_COLORS).filter(([k]) => !['ok', 'unsure'].includes(k)).map(([k, v]) => [k === 'none' ? 'not edited' : k, v]),
    evidence: Object.entries(EVIDENCE_COLORS).map(([k, v]) => [k === 'none' ? 'not rated' : EVIDENCE[k].label, v]),
    confidence: Object.entries(CONF_COLORS).map(([k, v]) => [k === 'none' ? 'no value' : k, v]),
    thickness: [['measured (both faces)', '#3fbf6f'], ['assumed', '#e3a92b'], ['set by annotator', '#4f8cff'], ['not a wall', '#555b66']],
  };
  $('#legend').innerHTML = `<div class="muted">Colour: ${esc(S.colorMode)}</div>${sets[S.colorMode].map(([k, c]) => `<div><span class="sw" style="background:${c}"></span>${esc(k)}</div>`).join('')}
    <div class="muted" style="margin-top:6px">Resize handles: red = length, green = thickness, blue = height</div>`;
}
