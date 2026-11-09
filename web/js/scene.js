// Scene loading and saving: scene list, annotator name, the annotation (original + saved version), the scan, the
// diff against the original Opus annotation, saves and autosaves, and the startup sequence.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as M from './model.js';
import { TYPES, KINDS } from './registry.js';
import { History } from './history.js';
import { Logger, makeSessionId } from './logger.js';
import { S, ctx, EL, EXT, SCAN, params, $, esc, log, toast, setProgress, LOG_SCHEMA_VERSION } from './state.js';
import { scene, prepareScanMesh, setScanOpacity, addElementObject, resize, setLevel, fitLevel, finishAnimation, tick, focusOn, handleGroup, renderer } from './render.js';
import * as R from './render.js';
import { select } from './selection.js';
import { initTools, snapWallToScan, nudge, setMode } from './tools.js';
import { renderList, changedFields } from './panel.js';
import { rebuildQueue, Q } from './review.js';
import { applyCmd, commit, onHistory, restoreDeleted, trash } from './commands.js';
import { initUI } from './ui.js';
import { initLogging } from './logging.js';
import { initGumball, gumballDrive, orderedSelection, setGizmoMode, toggleSpace, setPivot, updateGumball, gizmoAxis } from './gumball.js';
import { initModal, startModal, confirmModal, cancelModal } from './modal.js';
import { TransformSession, transformable, runTransform } from './transform.js';
import * as Layout from './layout.js';
import { selectMany, toggleSelect } from './selection.js';
import { evalExpr } from './state.js';
import { initFitPlane, planeTargets, clearFit } from './fitplane.js';
import { finishDraw } from './shapes.js';
import { handleAt, buildHandles } from './tools.js';
import { setFields } from './commands.js';

function indexDoc(doc) {
  const out = {};
  for (const kind of KINDS) out[kind] = new Map((doc[TYPES[kind].key] || []).map((r) => [r.id, r]));
  return out;
}
export function diffDoc() {
  const edited = {}, added = [], deleted = [];
  for (const kind of KINDS) {
    const now = new Set();
    for (const r of ctx.DOC[TYPES[kind].key]) {
      now.add(r.id);
      const el = EL.get(r.id);
      const ch = el ? changedFields(el) : null;
      if (ch === null) added.push(r.id); else if (ch.length) edited[r.id] = ch;
    }
    for (const id of ctx.ORIG[kind].keys()) if (!now.has(id)) deleted.push(id);
  }
  return { edited, added, deleted };
}
function reviewCounts() {
  const c = {};
  for (const v of Object.values(ctx.DOC.annotation_tool.review)) c[v.status] = (c[v.status] || 0) + 1;
  return c;
}

let saving = false;
export async function save(autosave = false) {
  if (saving) return;
  saving = true;
  const changes = diffDoc();
  Object.assign(ctx.DOC.annotation_tool, {
    format: 'archscan-annotator/0.1', tool_version: S.toolVersion, scene: S.scene, base_version: 'original',
    loaded_version: S.loadedVersion || S.version, annotator: ctx.annotator, session: ctx.session, saved_at: new Date().toISOString(),
    changes, review_counts: reviewCounts(),
    // openings whose door / window detail fields may be stale after a resize or re-host (see their `stale_detail`)
    stale_detail: ctx.DOC.openings.filter((o) => o.stale_detail && o.stale_detail.length).map((o) => o.id),
  });
  try {
    const res = await fetch(`api/save/${encodeURIComponent(S.scene)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ annotator: ctx.annotator, session: ctx.session, autosave, doc: ctx.DOC }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || res.status);
    S.dirty = 0;
    S.lastSaveText = `${autosave ? 'autosaved' : 'saved'} ${new Date().toLocaleTimeString()}${autosave ? '' : ` as ${out.saved}`}`;
    log('save', { autosave, name: out.saved, edited: Object.keys(changes.edited).length, added: changes.added.length, deleted: changes.deleted.length, reviews: reviewCounts() });
    // the address now names this version, so a reload reopens the work instead of the original
    S.version = out.saved;
    const q = new URLSearchParams(location.search);
    q.set('version', out.saved);
    window.history.replaceState(null, '', `${location.pathname}?${q.toString()}`);
    fillVersions(out.saves);
    if (out.kept) toast(`Your earlier autosave was kept as version <b>${esc(out.kept)}</b> (version menu).`, 6000);
    if (!autosave) toast(`Saved version <b>${esc(out.saved)}</b>.`);
  } catch (err) {
    log('save_error', { autosave, error: String(err) });
    toast(`Save failed: ${esc(String(err))}`, 6000);
  } finally {
    saving = false;
    updateSaveState();
  }
}
export function updateSaveState() {
  const st = $('#save-state');
  st.textContent = S.dirty ? `${S.dirty} unsaved change${S.dirty > 1 ? 's' : ''}` : S.lastSaveText || 'no changes';
  st.classList.toggle('dirty', S.dirty > 0);
}
function fillVersions(saves) {
  const sel = $('#version-select');
  sel.innerHTML = `<option value="original">Original (Opus)</option>${(saves || []).map((s) => `<option value="${esc(s.name)}">${esc(s.name)} · ${esc(s.modified.replace('T', ' '))}</option>`).join('')}`;
  sel.value = S.version;
}

function askAnnotator() {
  return new Promise((resolve) => {
    const saved = localStorage.getItem('annotator');
    if (saved) { resolve(saved); return; }
    $('#modal').classList.remove('hidden');
    const done = () => {
      const v = $('#modal-name').value.trim().replace(/[^A-Za-z0-9_-]/g, '_');
      if (!v) return;
      localStorage.setItem('annotator', v);
      $('#modal').classList.add('hidden');
      resolve(v);
    };
    $('#modal-ok').addEventListener('click', done);
    $('#modal-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
    $('#modal-name').focus();
  });
}

function dominantDirection() {
  // area-weighted circular mean of wall directions modulo 90°
  let sx = 0, sy = 0;
  for (const w of ctx.DOC.walls) {
    const f = M.wallFrame(w), a = Math.atan2(f.t[1], f.t[0]) * 4;
    sx += f.L * Math.cos(a); sy += f.L * Math.sin(a);
  }
  return Math.atan2(sy, sx) / 4;
}

function loadScan() {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(`scan/${encodeURIComponent(S.scene)}.glb`, (g) => {
      g.scene.updateMatrixWorld(true);
      const meshes = [];
      g.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });   // collected first: preparing adds a child mesh
      for (const o of meshes) {
        SCAN.push({ mesh: o, box: new THREE.Box3().setFromObject(o) });
        prepareScanMesh(o);
      }
      scene.add(g.scene);
      resolve();
    }, (ev) => { if (ev.total) setProgress(`Loading scan… ${(ev.loaded / 1e6).toFixed(0)} / ${(ev.total / 1e6).toFixed(0)} MB`, ev.loaded / ev.total); }, reject);
  });
}

export async function start() {
  const t0 = performance.now();
  const info = await (await fetch('api/scenes')).json();
  S.toolVersion = info.tool_version;
  $('#tool-version').textContent = `v${info.tool_version}`;
  S.scene = params.get('scene') || info.scenes[0].id;
  const sc = info.scenes.find((s) => s.id === S.scene) || info.scenes[0];
  S.scene = sc.id;
  $('#scene-select').innerHTML = info.scenes.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('');
  $('#scene-select').value = S.scene;
  fillVersions(sc.saves);

  ctx.annotator = await askAnnotator();
  $('#who').textContent = `👤 ${ctx.annotator}`;
  // opening a scene without a version: offer this annotator's latest save or autosave of it, if there is one
  if (!params.get('version')) {
    const mine = (sc.saves || []).filter((s) => s.name === `autosave_${ctx.annotator}` || s.name.endsWith(`_${ctx.annotator}`)
      || s.name.includes(`_${ctx.annotator}_`));
    if (mine.length && confirm(`You have saved work on this scene: ${mine[0].name} (${mine[0].modified.replace('T', ' ')}).\n\nOpen it? (Cancel opens the original annotation.)`)) {
      S.version = mine[0].name;
      const q = new URLSearchParams(location.search); q.set('version', S.version);
      window.history.replaceState(null, '', `${location.pathname}?${q.toString()}`);
      fillVersions(sc.saves);
    }
  }
  S.loadedVersion = S.version;
  ctx.session = makeSessionId(ctx.annotator);
  ctx.LOG = new Logger({ scene: S.scene, annotator: ctx.annotator, session: ctx.session });
  log('session_start', { scene: S.scene, version: S.version, annotator: ctx.annotator, tool_version: S.toolVersion, schema_version: LOG_SCHEMA_VERSION,
    user_agent: navigator.userAgent, screen: [screen.width, screen.height], viewport: [innerWidth, innerHeight], url: location.href });
  initLogging();
  window.__annot = { S, EL, TYPES, M, select, commit, applyCmd, save, setLevel, focusOn, snapWallToScan, nudge, setMode, rebuildQueue, Q,
    get LOG() { return ctx.LOG; }, get DOC() { return ctx.DOC; }, get history() { return ctx.history; }, get camera() { return R.camera; },
    handleGroup, renderer, diffDoc, gumballDrive, gizmoAxis, orderedSelection, setGizmoMode, toggleSpace, setPivot, updateGumball,
    startModal, confirmModal, cancelModal, TransformSession, transformable, runTransform, Layout, selectMany, toggleSelect, evalExpr, restoreDeleted, trash,
    R, setView: R.setView, finishDraw, planeTargets, clearFit, handleAt, buildHandles, setFields };

  setProgress('Loading annotation…', 0.02);
  const origText = await (await fetch(`api/doc/${encodeURIComponent(S.scene)}?version=original`)).text();
  ctx.ORIG = indexDoc(JSON.parse(origText));
  if (S.version === 'original') ctx.DOC = JSON.parse(origText);
  else {
    const r = await fetch(`api/doc/${encodeURIComponent(S.scene)}?version=${encodeURIComponent(S.version)}`);
    if (!r.ok) { toast(`Version ${esc(S.version)} not found; loaded the original.`); S.version = 'original'; ctx.DOC = JSON.parse(origText); }
    else ctx.DOC = await r.json();
  }
  const DOC = ctx.DOC;
  DOC.annotation_tool = DOC.annotation_tool || {};
  DOC.annotation_tool.review = DOC.annotation_tool.review || {};
  DOC.annotation_tool.levels_checked = DOC.annotation_tool.levels_checked || {};
  DOC.annotation_tool.deleted = DOC.annotation_tool.deleted || {};   // trash: deleted records, restorable
  for (const kind of KINDS) DOC[TYPES[kind].key] = DOC[TYPES[kind].key] || [];
  ctx.LEVELS = [...(DOC.levels || [])].sort((a, b) => a.elevation - b.elevation);
  ctx.dominant = dominantDirection();

  // derive junction extensions from the original footprints, then build every element (registry order: walls first)
  for (const w of DOC.walls) EXT.set(w.id, M.footprintExtents(w));
  for (const kind of KINDS) for (const r of DOC[TYPES[kind].key]) addElementObject(kind, r);

  ctx.history = new History(applyCmd, onHistory);
  initUI();
  initTools();
  initGumball();
  initModal();
  initFitPlane();
  resize();
  addEventListener('resize', resize);
  // default: the lowest level of the scene (so single-level scenes start with the cut working)
  const asked = params.get('level');
  const startLevel = asked !== null && (asked === '' || ctx.LEVELS.some((l) => l.id === asked)) ? asked : (ctx.LEVELS[0] ? ctx.LEVELS[0].id : '');
  setLevel(startLevel, { via: 'startup' });
  fitLevel();
  finishAnimation();
  rebuildQueue('startup');
  renderList();
  updateSaveState();
  tick();

  setProgress('Loading scan…', 0.05);
  try { await loadScan(); } catch (err) { toast(`Scan failed to load: ${esc(String(err))}`, 8000); }
  setScanOpacity(Number($('#scan-opacity').value));   // the browser may have restored the slider on reload
  $('#loading').style.display = 'none';
  log('scene_loaded', { ms: Math.round(performance.now() - t0), counts: Object.fromEntries(KINDS.map((k) => [k, DOC[TYPES[k].key].length])) });

  setInterval(() => { if (S.dirty) save(true); }, 60000);
  if (!localStorage.getItem('annotator_seen_help')) { localStorage.setItem('annotator_seen_help', '1'); $('#help').classList.remove('hidden'); }
}
