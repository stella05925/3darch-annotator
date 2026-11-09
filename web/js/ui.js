// UI wiring: top bar, tabs, review-queue controls, element list, layers (chips generated from the registry) and the
// keyboard.
import { TYPES, KINDS_BY_ORDER, layers } from './registry.js';
import { S, ctx, EL, SCAN, $, $$, esc, clamp, log, toast, recOf } from './state.js';
import { setLevel, setPlan, setView, applyCut, restyleAll, updateVisibility, focusOn, setScanOpacity } from './render.js';
import { select, showDeleted } from './selection.js';
import { buildHandles, setMode, copySelected, deleteSelected, nudge, hasPasteTemplate } from './tools.js';
import { renderLegend, scheduleList } from './panel.js';
import { rebuildQueue, queueGo, queueDecide, openQueueItem } from './review.js';
import { save, updateSaveState } from './scene.js';
import { setGizmoMode, toggleSpace } from './gumball.js';
import { finishDraw, undoDrawPoint } from './shapes.js';
import { openNote, noteOpen, initNotes } from './notes.js';
import { startModal, modalActive } from './modal.js';
import { duplicateSelection, repeatLast } from './layout.js';

/** Review-queue filters and visibility layers come from the registry (only the types this scene has). */
const present = (k) => (ctx.DOC[TYPES[k].key] || []).length > 0;
function buildChips() {
  $('#q-kinds').innerHTML = KINDS_BY_ORDER.filter((k) => TYPES[k].queue && present(k))
    .map((k) => `<label><input type="checkbox" value="${k}" ${TYPES[k].queue.on ? 'checked' : ''}> ${esc(TYPES[k].queue.label)}</label>`).join('\n');
  const ls = layers().filter((l) => !TYPES[l.key] || present(l.key));
  for (const l of layers()) S.layers[l.key] = l.on;
  $('#lay-kinds').innerHTML = ls.map((l) => `<label><input type="checkbox" value="${l.key}" ${l.on ? 'checked' : ''}> ${esc(l.label)}</label>`).join('\n');
}

export function initUI() {
  buildChips();
  $('#btn-undo').addEventListener('click', () => { ctx.history.undo(); log('ui', { button: 'undo' }); });
  $('#btn-redo').addEventListener('click', () => { ctx.history.redo(); log('ui', { button: 'redo' }); });
  $('#btn-undo').disabled = true; $('#btn-redo').disabled = true;
  $('#btn-save').addEventListener('click', () => save(false));
  $$('[data-view]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.view === 'wall') wallView('button'); else setView(b.dataset.view, { via: 'button' });
  }));
  $('#btn-help').addEventListener('click', () => { $('#help').classList.remove('hidden'); log('help_open'); });
  $('#help-close').addEventListener('click', () => $('#help').classList.add('hidden'));
  $('#who').addEventListener('click', () => {
    if (S.dirty && !confirm('Unsaved changes will be lost. Switch annotator?')) return;
    localStorage.removeItem('annotator'); S.dirty = 0; location.reload();
  });
  $('#scene-select').addEventListener('change', (e) => { location.search = `?scene=${encodeURIComponent(e.target.value)}`; });
  $('#version-select').addEventListener('change', (e) => {
    location.search = `?scene=${encodeURIComponent(S.scene)}&version=${encodeURIComponent(e.target.value)}${S.level ? `&level=${S.level}` : ''}`;
  });
  const lsel = $('#level-select');
  lsel.innerHTML = `<option value="">all levels</option>${[...ctx.LEVELS].reverse().map((l) => `<option value="${esc(l.id)}">${esc(l.id)} · ${esc(l.name)}</option>`).join('')}`;
  lsel.addEventListener('change', () => setLevel(lsel.value, { fit: true }));
  $('#cut').addEventListener('input', (e) => { S.cutRel = Number(e.target.value); applyCut(); buildHandles(); });
  $('#cut').addEventListener('change', () => log('view', { what: 'cut_height', value: S.cutRel }));
  $('#cut-on').addEventListener('change', (e) => { S.cutOn = e.target.checked; applyCut(); log('view', { what: 'cut', value: S.cutOn }); });
  $('#color-mode').addEventListener('change', (e) => { S.colorMode = e.target.value; restyleAll(); renderLegend(); log('view', { what: 'color', value: S.colorMode }); });
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.tab').forEach((t) => t.classList.toggle('on', t.id === `tab-${b.dataset.tab}`));
    log('ui', { tab: b.dataset.tab });
  }));
  $$('#tools button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  // review queue
  $$('#q-kinds input, #q-scope, #q-unreviewed, #q-lowconf').forEach((x) => x.addEventListener('change', () => rebuildQueue('filters')));
  $('#q-prev').addEventListener('click', () => queueGo(-1, 'prev'));
  $('#q-next').addEventListener('click', () => queueGo(1, 'next'));
  $$('#tab-review [data-ev]').forEach((b) => b.addEventListener('click', () => queueDecide(b.dataset.ev, 'queue_button')));
  $('#q-card').addEventListener('click', () => openQueueItem('card'));
  $('#level-missing-checked').addEventListener('change', (e) => {
    if (!S.level) return;
    if (e.target.checked) ctx.DOC.annotation_tool.levels_checked[S.level] = { by: ctx.annotator, at: new Date().toISOString() };
    else delete ctx.DOC.annotation_tool.levels_checked[S.level];
    S.dirty += 1; updateSaveState();
    log('level_checked', { level: S.level, value: e.target.checked });
  });
  // element list
  $('#el-filter').addEventListener('input', scheduleList);
  $('#el-level-only').addEventListener('change', scheduleList);
  $('#el-list').addEventListener('click', (e) => {
    const it = e.target.closest('.it'); if (!it) return;
    if (it.dataset.delId) { showDeleted(it.dataset.delId); return; }
    select(it.dataset.id, 'list'); focusOn(EL.get(it.dataset.id), 'list');
  });
  // layers
  $('#lay-scan').addEventListener('change', (e) => { S.scanOn = e.target.checked; SCAN.forEach((s) => { s.mesh.visible = S.scanOn; }); log('view', { what: 'scan', value: S.scanOn }); });
  $('#lay-ann').addEventListener('change', (e) => { S.annOn = e.target.checked; updateVisibility(); buildHandles(); log('view', { what: 'annotation', value: S.annOn }); });
  $('#scan-opacity').addEventListener('input', (e) => {
    setScanOpacity(Number(e.target.value));
  });
  $('#scan-opacity').addEventListener('change', (e) => log('view', { what: 'scan_opacity', value: Number(e.target.value) }));
  $('#ann-opacity').addEventListener('input', restyleAll);
  $('#ann-opacity').addEventListener('change', (e) => log('view', { what: 'annotation_opacity', value: Number(e.target.value) }));
  $$('#lay-kinds input').forEach((x) => x.addEventListener('change', () => {
    S.layers[x.value] = x.checked; updateVisibility(); buildHandles();
    log('view', { what: `layer_${x.value}`, value: x.checked });
  }));
  renderLegend();
  initNotes();
  addEventListener('keydown', onKey);
  addEventListener('pointermove', (e) => { S.pointer = { x: e.clientX, y: e.clientY }; }, { passive: true, capture: true });
}

function isTyping(e) { return ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName); }
/** Wall view of the selected wall (or of the selected opening's wall). */
function wallView(via) {
  const el = S.sel && EL.get(S.sel);
  const w = el && (el.kind === 'wall' ? el.rec : el.kind === 'opening' ? recOf(el.rec.host_wall) : null);
  if (!w) { toast('Select a wall (or an opening) first, then press V for its straight-on view.'); return; }
  setView('wall', { wall: w, via });
}
function onKey(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); save(false); log('key', { key: 'Ctrl+S' }); return; }
  if (isTyping(e) || modalActive() || noteOpen()) return;
  let handled = true;
  const k = e.key;
  const lower = k.toLowerCase();
  if (S.mode === 'add-shape' && !ctrl && (k === 'Enter' || k === 'Backspace')) {   // drawing: finish / remove the last corner
    e.preventDefault();
    if (k === 'Enter') finishDraw('enter'); else undoDrawPoint();
    return;
  }
  if (ctrl && k.toLowerCase() === 'z' && !e.shiftKey) ctx.history.undo();
  else if (ctrl && (k.toLowerCase() === 'y' || (k.toLowerCase() === 'z' && e.shiftKey))) ctx.history.redo();
  else if (ctrl && k.toLowerCase() === 'c') copySelected();
  else if (ctrl && k.toLowerCase() === 'v') { if (hasPasteTemplate()) setMode('paste', 'key'); else toast('Nothing copied yet.'); }
  else if (ctrl) handled = false;
  else if (e.shiftKey && lower === 'd') duplicateSelection();
  else if (e.shiftKey && lower === 'r') repeatLast();
  else if (e.shiftKey && lower === 's') { $('#lay-scan').click(); }
  else if (k === 'Tab' && !e.shiftKey) setGizmoMode('points');
  else if (lower === 'v') wallView('key');
  else if (lower === 'n') openNote();
  else if (lower === 'g') startModal('translate');
  else if (lower === 'r') startModal('rotate');
  else if (lower === 's') startModal('scale');
  else if (lower === 'w') setGizmoMode('translate');
  else if (lower === 'e') setGizmoMode('rotate');
  else if (lower === 't') setGizmoMode('scale');
  else if (k === '.') toggleSpace();
  else if (k === 'Escape') { if (S.mode !== 'select') setMode('select', 'key'); else select(null, 'key'); }
  else if (k === 'Delete' || k === 'Backspace') deleteSelected('key');
  else if (lower === 'q') queueDecide('strong', 'key');          // evidence: Q / A / Z, top to bottom on the keyboard
  else if (lower === 'a') queueDecide('partial', 'key');
  else if (lower === 'z') queueDecide('assumption', 'key');
  else if (k === ']') queueGo(1, 'next');
  else if (k === '[') queueGo(-1, 'prev');
  else if (k === 'f' || k === 'F') focusOn(S.sel && EL.get(S.sel), 'key');
  else if (k === 'p' || k === 'P') setPlan(!S.plan, 'key');
  else if (k === 'c' || k === 'C') { S.cutOn = !S.cutOn; $('#cut-on').checked = S.cutOn; applyCut(); log('view', { what: 'cut', value: S.cutOn, via: 'key' }); }
  else if (k === 'h' || k === 'H') { $('#lay-ann').click(); }
  else if (k === 'l' || k === 'L') { const x = $('#lay-kinds input[value=label]'); if (x) x.click(); }
  else if (k === '?') { $('#btn-help').click(); }
  else if (['1', '2', '3', '4', '5', '6', '7'].includes(k)) setMode(['select', 'add-door', 'add-window', 'add-opening', 'add-wall', 'add-shape', 'fit-plane'][Number(k) - 1], 'key');
  else if (k === 'PageUp' || k === 'PageDown') {
    const ids = ctx.LEVELS.map((l) => l.id), i = ids.indexOf(S.level);
    const j = clamp((i < 0 ? 0 : i) + (k === 'PageUp' ? 1 : -1), 0, ids.length - 1);
    setLevel(ids[j], { fit: true, via: 'key' });
  } else if (k.startsWith('Arrow') && S.sel) {
    const step = e.shiftKey ? 0.1 : 0.01;
    const dx = k === 'ArrowRight' ? 1 : k === 'ArrowLeft' ? -1 : 0, dy = k === 'ArrowUp' ? 1 : k === 'ArrowDown' ? -1 : 0;
    nudge(dx, dy, step);
  } else handled = false;
  if (handled) { e.preventDefault(); log('key', { key: (ctrl ? 'Ctrl+' : '') + (e.shiftKey && k.length > 1 ? 'Shift+' : '') + k }); }
}
