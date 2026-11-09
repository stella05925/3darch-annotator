// Notes: what was hard or impossible to do with the tool, kept with the annotation (annotation_tool.notes) together
// with the view, level and selection at the time, so the list can be read later and each note reopened where it was
// written. Notes are not edits of the annotation (not undoable); adding or deleting one marks the scene unsaved.
import { S, ctx, EL, $, esc, log, toast } from './state.js';
import * as R from './render.js';
import { camPose } from './logging.js';
import { selectMany } from './selection.js';
import { orderedSelection } from './gumball.js';

const CATS = { hard: 'hard to do', impossible: 'impossible', wrong: "wrong, can't fix", bug: 'tool bug', other: 'other' };
const notes = () => (ctx.DOC.annotation_tool.notes = ctx.DOC.annotation_tool.notes || []);
let open = false;
export const noteOpen = () => open;

export function openNote() {
  const ids = orderedSelection();
  $('#note-elements').textContent = ids.length ? ids.join(', ') : 'nothing selected';
  $('#note-text').value = '';
  $('#note-modal').classList.remove('hidden');
  open = true;
  setTimeout(() => $('#note-text').focus(), 0);
}
function closeNote() { $('#note-modal').classList.add('hidden'); open = false; }

function saveNote() {
  const text = $('#note-text').value.trim();
  if (!text) { toast('Write what got in the way first.'); return; }
  const n = { id: `N${Date.now().toString(36)}`, category: $('#note-cat').value, text, elements: orderedSelection(), level: S.level,
    scene: S.scene, mode: S.mode === 'select' ? S.gizmo.mode : S.mode, view: camPose(), by: ctx.annotator, at: new Date().toISOString() };
  notes().push(n);
  S.dirty += 1;
  import('./scene.js').then((m) => m.updateSaveState());
  log('note', { id: n.id, category: n.category, text: n.text, elements: n.elements, mode: n.mode });
  closeNote();
  renderNotes();
  toast('Note saved (with this view). It is kept in the next save.');
}

export function renderNotes() {
  const list = notes();
  $('#notes-count').textContent = list.length ? `(${list.length})` : '';
  $('#notes-list').innerHTML = list.length ? [...list].reverse().map((n) => `<div class="note ${esc(n.category)}" data-note="${esc(n.id)}">
      <span class="x" data-del="${esc(n.id)}" title="Delete this note">×</span><span class="cat">${esc(CATS[n.category] || n.category)}</span>
      ${n.elements.length ? `<span class="muted">· ${esc(n.elements.slice(0, 4).join(', '))}${n.elements.length > 4 ? '…' : ''}</span>` : ''}
      <div>${esc(n.text)}</div><div class="muted">${esc(n.by || '')} · ${esc((n.at || '').slice(0, 16).replace('T', ' '))}</div></div>`).join('')
    : '<span class="muted">Nothing noted yet. Press N (or ⚑ Note) when something is hard or impossible to do.</span>';
  $('#notes-list').querySelectorAll('[data-del]').forEach((x) => x.addEventListener('click', (e) => {
    e.stopPropagation();
    const i = list.findIndex((n) => n.id === x.dataset.del);
    if (i < 0 || !confirm('Delete this note?')) return;
    log('note_delete', { id: list[i].id });
    list.splice(i, 1); S.dirty += 1;
    import('./scene.js').then((m) => m.updateSaveState());
    renderNotes();
  }));
  $('#notes-list').querySelectorAll('[data-note]').forEach((d) => d.addEventListener('click', () => {
    const n = list.find((x) => x.id === d.dataset.note);
    if (!n) return;
    if (n.level && n.level !== S.level) R.setLevel(n.level, { via: 'note' });
    R.restoreView(n.view);
    selectMany(n.elements.filter((id) => EL.has(id)), 'note');
    log('note_open', { id: n.id });
  }));
}

export function initNotes() {
  $('#btn-note').addEventListener('click', openNote);
  $('#btn-note2').addEventListener('click', openNote);
  $('#note-save').addEventListener('click', saveNote);
  $('#note-cancel').addEventListener('click', closeNote);
  $('#note-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNote(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeNote(); }
  });
  renderNotes();
}
