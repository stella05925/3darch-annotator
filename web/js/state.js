// Shared state and small helpers used by every module.
export const params = new URLSearchParams(location.search);
export const $ = (s) => document.querySelector(s);
export const $$ = (s) => [...document.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const num = (x, d = 3) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : '—');
export const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
export const mm = (x) => Math.round(x * 1000) / 1000;

/** Version of the logged command format (1 = before `op` existed). */
export const LOG_SCHEMA_VERSION = 3;   // 3: 1 s activity ticks, field focus / blur, evidence levels in review commands

export const S = {
  scene: null, version: params.get('version') || 'original', level: null, cutOn: true, cutRel: 1.7, plan: false,
  colorMode: 'type', mode: 'select', sel: null, related: new Set(),
  selected: new Set(),   // multi-selection (S.sel is its primary element: the last one clicked)
  trashSel: null,        // a deleted element shown in the panel (picked in the element list)
  snapPx: 10,            // snap tolerance in screen pixels
  pointer: null,         // last pointer position {x, y} (client coordinates), for overlays
  view: '3d',            // '3d' | 'plan' | 'wall' (render.setView)
  elev: null,            // wall view: {wall: id, side: +1 (seen from its left face) | -1}
  // gizmo modes: translate / rotate (the gumball), scale (face handles), points (corners of plan shapes)
  gizmo: { mode: 'translate', space: 'local', pivot: {} },   // pivot: kind -> pivot name
  drawKind: 'room',      // what the draw tool makes
  fit: null,             // fitted scan plane {n, d, c, rms, tilt_deg, kind, count}
  fitRadius: 0.3,        // plane fit: metres of scan around each click
  selPatch: null,        // ceiling patch index under the last click
  hoverId: null,         // element under the pointer (hover), for the activity ticks
  lastTransform: null,   // for "repeat last transform" (Shift+R)
  layers: {},            // filled from the registry: layer key -> visible
  snapRule: 'deeper',    // snap-to-scan surface choice: 'deeper' | 'strongest' | 'median'
  scanOn: true, annOn: true, dirty: 0, lastSaveText: '', toolVersion: '?',
};

/** Values set once at startup (or replaced on load); read through ctx so every module sees the current ones. */
export const ctx = {
  DOC: null,          // the annotation being edited
  ORIG: null,         // kind -> Map(id -> record) of the original Opus annotation
  LEVELS: [],         // levels sorted by elevation
  LOG: null, history: null, annotator: null, session: null,
  dominant: 0,        // dominant wall direction of the house (radians, mod 90°)
};
export const EL = new Map();     // id -> {id, kind, rec, group, meshes, levels, label?, outline?}
export const EXT = new Map();    // wall id -> [extension past start, past end] (junction extensions of the footprint)
export const SCAN = [];          // [{mesh, box}]

export const REVIEW_COLORS = { none: '#7a8296', ok: '#3fbf6f', fixed: '#4f8cff', added: '#4f8cff', wrong: '#e5534b', unsure: '#e3a92b' };
export const CONF_COLORS = { high: '#3fbf6f', medium: '#e3a92b', low: '#e5534b', none: '#7a8296' };
export const CONF_RANK = { low: 0, medium: 1, high: 2 };

export const log = (type, data = {}) => { if (ctx.LOG) ctx.LOG.log(type, data); };
export const reviewOf = (id) => ctx.DOC.annotation_tool.review[id] || null;
export const statusOf = (id) => (reviewOf(id) || {}).status || 'none';
/** How much of the element (as it now stands) the editor could base on the scan: 'strong' | 'partial' | 'assumption'. */
export const evidenceOf = (id) => (reviewOf(id) || {}).evidence || 'none';
export const EVIDENCE = {
  strong: { label: 'Strong evidence', key: 'Q', tip: 'The scan shows it directly: its surfaces / edges are visible where they are drawn.' },
  partial: { label: 'Partial evidence', key: 'A', tip: 'Partly seen in the scan; the rest is inferred (e.g. one face seen, thickness or extent assumed).' },
  assumption: { label: 'Assumption', key: 'Z', tip: 'Not visible in the scan: placed from context, symmetry or building convention.' },
};
export const EVIDENCE_COLORS = { strong: '#3fbf6f', partial: '#e3a92b', assumption: '#e5534b', none: '#7a8296' };
export const levelById = (id) => ctx.LEVELS.find((l) => l.id === id);
export const recOf = (id) => (EL.get(id) || {}).rec;
export const openingsOf = (wallId) => ctx.DOC.openings.filter((o) => o.host_wall === wallId);
export const hostOf = (el) => (el.kind === 'opening' ? recOf(el.rec.host_wall) : null);

let toastTimer = null;
export function toast(msg, ms = 3500) {
  const t = $('#toast'); t.innerHTML = msg; t.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = 'none'; }, ms);
}
export function setProgress(text, frac) {
  $('#load-text').textContent = text;
  if (frac !== undefined) $('#load-bar').style.width = `${Math.round(frac * 100)}%`;
}

/** Equal up to half a millimetre (numbers, arrays, objects). */
export function nearlyEqual(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 5e-4;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => nearlyEqual(a[k], b[k]));
  }
  return a === b;
}

/**
 * Evaluate a typed number: plain arithmetic ("2.4-0.1", "0.5*2"); a leading +, * or / applies to `current`
 * ("+0.05", "*2", "/2"). A leading "-" is a negative number (coordinates are often negative). null when invalid.
 */
export function evalExpr(text, current) {
  let t = String(text ?? '').trim().replace(/,/g, '.').replace(/×/g, '*');
  if (!t) return null;
  if (/^[+*/]/.test(t)) t = `(${current})${t}`;
  if (!/^[0-9.+\-*/()\seE]+$/.test(t)) return null;
  try {
    const v = Function(`"use strict"; return (${t});`)();
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch { return null; }
}
