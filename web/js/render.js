// three.js scene: renderer, cameras, clipping, element meshes (built from the records through the registry),
// styling and visibility, levels and the cut, plan view, camera framing.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import * as M from './model.js';
import { TYPES, levelsOf } from './registry.js';
import { S, ctx, EL, SCAN, $, $$, clamp, log, levelById, statusOf, evidenceOf, recOf, toast, REVIEW_COLORS, CONF_COLORS, EVIDENCE_COLORS } from './state.js';
import { computeRelated } from './selection.js';
import { buildHandles, scaleHandles } from './tools.js';
import { updateGumball } from './gumball.js';
import { scheduleList } from './panel.js';
import { rebuildQueue } from './review.js';

const V3 = THREE.Vector3;
export const vp = $('#viewport');
export const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;
vp.prepend(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
vp.appendChild(labelRenderer.domElement);

export const scene = new THREE.Scene();
scene.background = new THREE.Color('#111318');
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f4a, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(-6, -9, 14);
scene.add(sun);

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
export const persp = new THREE.PerspectiveCamera(55, 1, 0.03, 600);
persp.up.set(0, 0, 1);
export const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 600);
ortho.up.set(0, 1, 0);
export let camera = persp;
export const controlsP = new OrbitControls(persp, renderer.domElement);
controlsP.enableDamping = true; controlsP.dampingFactor = 0.15; controlsP.screenSpacePanning = true;
export const controlsO = new OrbitControls(ortho, renderer.domElement);
controlsO.enableRotate = false; controlsO.enabled = false; controlsO.screenSpacePanning = true;
controlsO.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
// wall elevation: an orthographic camera looking straight at one wall (Z up); only panning and zooming
export const orthoE = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 600);
orthoE.up.set(0, 0, 1);
export const controlsE = new OrbitControls(orthoE, renderer.domElement);
controlsE.enableRotate = false; controlsE.enabled = false; controlsE.screenSpacePanning = true;
controlsE.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
export let controls = controlsP;

export const CLIP = [];                                     // shared by every scan / annotation material
const cutPlane = new THREE.Plane(new V3(0, 0, -1), 0);
const lowPlane = new THREE.Plane(new V3(0, 0, 1), 0);
const slabA = new THREE.Plane(), slabB = new THREE.Plane();      // wall view: a slab around the wall
export const clipOk = (p) => CLIP.every((pl) => pl.distanceToPoint(p) >= -2e-3);

// The scan deviates from the fitted planes by mm–cm, so it is pushed a few cm back along each view ray (screen
// position unchanged) and annotation surfaces lying on it draw on top without flicker (as in the sandbox viewer).
const SCAN_PUSH = { value: 0.04 };
export function pushDepth(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uScanPush = SCAN_PUSH;
    shader.vertexShader = `uniform float uScanPush;\n${shader.vertexShader}`.replace('#include <project_vertex>', `#include <project_vertex>
      { vec4 pp = mvPosition;
        if ( isPerspectiveMatrix( projectionMatrix ) ) pp.xyz *= 1.0 + uScanPush / max( length( pp.xyz ), 1e-3 );
        else pp.z -= uScanPush;
        gl_Position = projectionMatrix * pp; }`);
  };
  material.customProgramCacheKey = () => 'scan-push';
  material.needsUpdate = true;
}

// ------------------------------------------------------------------ draw order and transparency
// See-through surfaces show only their nearest layer, drawn in a fixed order, so what is on screen is exactly the
// opacity set with the sliders and nothing re-sorts (flickers) as the camera moves:
//   scan depth (only when the scan is see-through) → scan → depth cleared (the annotation then shows through a
//   see-through scan) → annotation depth → annotation colour (only its nearest surface passes) → edges → selection.
// Everything is in three.js's transparent list (sorted by renderOrder first), and the scan's material stays
// `transparent` so changing its opacity never needs a shader recompile.
export const RO = { scanDepth: 0, scan: 1, clear: 2, annDepth: 3, ann: 4, edges: 5, selected: 6 };
const depthOnly = (side) => {
  const m = new THREE.MeshBasicMaterial({ transparent: true, colorWrite: false, side, clippingPlanes: CLIP,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });   // a little behind, so the colour pass of the same surface passes
  m.userData.shared = true;
  return m;
};
const annDepthMat = depthOnly(THREE.DoubleSide);
const scanDepthMat = depthOnly(THREE.FrontSide);
pushDepth(scanDepthMat);
const depthClear = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Array(9).fill(0), 3)),
  new THREE.MeshBasicMaterial({ transparent: true, colorWrite: false, depthTest: false, depthWrite: false }));
depthClear.frustumCulled = false; depthClear.renderOrder = RO.clear; depthClear.visible = false;
depthClear.onBeforeRender = (r) => { r.state.buffers.depth.setMask(true); r.clearDepth(); };
scene.add(depthClear);

/** A scan mesh from the glb: clipping, pushed back, fixed draw order, and its depth-only twin for see-through mode. */
export function prepareScanMesh(o) {
  o.material.side = THREE.FrontSide;
  o.material.clippingPlanes = CLIP;
  o.material.transparent = true;
  pushDepth(o.material);
  o.renderOrder = RO.scan;
  const d = new THREE.Mesh(o.geometry, scanDepthMat);
  d.renderOrder = RO.scanDepth; d.raycast = () => {}; d.visible = false;
  o.add(d); o.userData.depth = d;
}
export function setScanOpacity(v) {
  for (const s of SCAN) {
    s.mesh.material.opacity = v;
    s.mesh.material.depthWrite = v >= 1;                   // opaque: occludes the annotation behind it
    s.mesh.userData.depth.visible = v < 1;                 // see-through: nearest scan surface only
  }
  depthClear.visible = v < 1;
}

export const annGroup = new THREE.Group(); scene.add(annGroup);
export const handleGroup = new THREE.Group(); scene.add(handleGroup);
export const guideGroup = new THREE.Group(); scene.add(guideGroup);
export const ghostGroup = new THREE.Group(); scene.add(ghostGroup);
export const HANDLE_GEOM = new THREE.SphereGeometry(1, 16, 12);

// ------------------------------------------------------------------ elements: build, style, visibility
function makeMaterial() {
  return new THREE.MeshLambertMaterial({ color: '#fff', transparent: true, opacity: 0.35, side: THREE.DoubleSide,
    depthWrite: false, clippingPlanes: CLIP });
}
function edgeMaterial() { return new THREE.LineBasicMaterial({ color: '#fff', transparent: true, opacity: 0.9, clippingPlanes: CLIP }); }
export function disposeGroup(g) {
  g.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.dispose && !o.material.userData.shared) o.material.dispose(); });
  for (const c of [...g.children]) g.remove(c);
}

export function addElementObject(kind, rec) {
  const el = { id: rec.id, kind, rec, group: new THREE.Group(), meshes: [], levels: [] };
  EL.set(rec.id, el);
  annGroup.add(el.group);
  buildElement(el);
  return el;
}
export function removeElementObject(el) {
  disposeGroup(el.group); annGroup.remove(el.group); EL.delete(el.id);
}

/** Rebuild an element's meshes from its record (never edits geometry directly). */
export function buildElement(el) {
  if (!el) return;
  disposeGroup(el.group);
  el.meshes = []; el.label = null; el.outline = null;
  el.levels = levelsOf(el.kind, el.rec);
  const api = {
    mesh(geom, extra = {}) {
      if (!geom || !geom.attributes.position.count) return;
      const mesh = new THREE.Mesh(geom, makeMaterial());
      mesh.renderOrder = RO.ann;
      Object.assign(mesh.userData, { el }, extra);
      const depth = new THREE.Mesh(geom, annDepthMat);    // nearest-surface-only (see the draw order above)
      depth.renderOrder = RO.annDepth; depth.raycast = () => {};
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 25), edgeMaterial());
      edges.raycast = () => {}; edges.renderOrder = RO.edges;
      mesh.add(depth, edges); mesh.userData.edges = edges;
      el.group.add(mesh); el.meshes.push(mesh);
    },
    outline(poly, z) {
      const pts = poly.map((p) => new V3(p[0], p[1], z));
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), edgeMaterial());
      line.renderOrder = RO.edges; line.userData.el = el; el.group.add(line); el.outline = line;
    },
    label(text, pos) {
      const div = document.createElement('div'); div.className = 'room-label'; div.textContent = text;
      const lab = new CSS2DObject(div); lab.position.set(...pos); el.group.add(lab); el.label = lab;
    },
  };
  try { TYPES[el.kind].draw(el, api); } catch (err) { console.warn('build failed', el.id, err); }
  styleElement(el);
  visibilityOf(el);
}

export const typeColor = (el) => TYPES[el.kind].color(el.rec);
function colorOf(el) {
  const r = el.rec;
  switch (S.colorMode) {
    case 'review': return REVIEW_COLORS[statusOf(el.id)];
    case 'evidence': return EVIDENCE_COLORS[evidenceOf(el.id)];
    case 'confidence': return CONF_COLORS[r.confidence] || CONF_COLORS.none;
    case 'thickness':
      if (el.kind !== 'wall') return '#555b66';
      return /measured|fit/.test(r.thickness_source || '') ? '#3fbf6f' : /human/.test(r.thickness_source || '') ? '#4f8cff' : '#e3a92b';
    default: return typeColor(el);
  }
}
export function styleElement(el) {
  const sel = S.sel === el.id || S.selected.has(el.id), rel = S.related.has(el.id);
  const base = new THREE.Color(colorOf(el));
  const op = Number($('#ann-opacity').value);
  const kindOp = op * (TYPES[el.kind].tint ?? 1);
  for (const m of el.meshes) {
    m.material.color.copy(base);
    m.material.opacity = sel ? Math.min(1, kindOp + 0.35) : kindOp;
    const e = m.userData.edges;
    e.material.color.set(sel ? '#00e5ff' : rel ? '#29c7b6' : base);
    e.material.opacity = sel || rel ? 1 : 0.85;
    e.material.depthTest = !sel; e.renderOrder = sel ? RO.selected : RO.edges;   // the selection's outline shows through walls
  }
  if (el.outline) el.outline.material.color.set(sel ? '#00e5ff' : rel ? '#29c7b6' : '#ffffff');
}
export const restyleAll = () => EL.forEach(styleElement);

export function levelOk(el) {
  if (!S.level) return true;
  return el.levels.length === 0 || el.levels.includes(S.level);
}
export function visibilityOf(el) {
  const t = TYPES[el.kind];
  const vis = S.annOn && levelOk(el) && (t.layerVisible ? t.layerVisible() : S.layers[el.kind] !== false);
  el.group.visible = vis;
  if (el.outline) el.outline.visible = S.layers.room;
  if (el.label) el.label.visible = vis && S.layers.label && !!S.level;
}
export const updateVisibility = () => EL.forEach(visibilityOf);

/** After an edit: recompute derived fields through the registry and rebuild the affected meshes. */
export function refreshElement(el) {
  if (!el) return;
  const t = TYPES[el.kind];
  if (t.afterEdit) t.afterEdit(el, { rebuild: buildElement }); else buildElement(el);
  if (S.sel === el.id || S.related.has(el.id)) { computeRelated(); buildHandles(); }
}

// ------------------------------------------------------------------ levels, cut, views
export const SLAB = 0.5;                                    // wall view: metres kept in front of / behind the wall faces
export function applyCut() {
  CLIP.length = 0;
  const w = S.view === 'wall' && S.elev ? recOf(S.elev.wall) : null;
  if (w) {
    const f = M.wallFrame(w), v = f.n[0] * f.s[0] + f.n[1] * f.s[1], h = w.thickness / 2;
    slabA.set(new V3(f.n[0], f.n[1], 0), -(v - h - SLAB)); slabB.set(new V3(-f.n[0], -f.n[1], 0), v + h + SLAB);
    CLIP.push(slabA, slabB);
    return;
  }
  const lv = S.level ? levelById(S.level) : null;
  if (lv) {
    lowPlane.constant = -(lv.elevation - 0.35); CLIP.push(lowPlane);
    if (S.cutOn) { cutPlane.constant = lv.elevation + S.cutRel; CLIP.push(cutPlane); }
  }
  $('#cut-val').textContent = S.cutRel.toFixed(2);
  $('#cut').disabled = !lv; $('#cut-on').disabled = !lv;
}

export function setLevel(id, { fit = false, via = 'ui' } = {}) {
  S.level = id || null;
  $('#level-select').value = S.level || '';
  applyCut(); updateVisibility(); buildHandles(); updateGumball();
  $('#level-missing-checked').checked = !!(S.level && ctx.DOC.annotation_tool.levels_checked[S.level]);
  $('#level-missing-checked').disabled = !S.level;
  if (fit) fitLevel();
  scheduleList();
  if ($('#q-scope').value === 'level') rebuildQueue();
  const q = new URLSearchParams(location.search);
  if (S.level) q.set('level', S.level); else q.delete('level');
  window.history.replaceState(null, '', `${location.pathname}?${q.toString()}`);
  log('view', { what: 'level', value: S.level, via });
}

function boxOfLevel(id) {
  const box = new THREE.Box3();
  for (const el of EL.values()) {
    if (el.kind !== 'wall' || (id && !el.levels.includes(id))) continue;
    for (const p of el.rec.footprint) box.expandByPoint(new V3(p[0], p[1], el.rec.base_z));
  }
  if (box.isEmpty()) box.setFromObject(annGroup);
  return box;
}
export function fitLevel() {
  const box = boxOfLevel(S.level);
  const c = box.getCenter(new V3()), size = box.getSize(new V3());
  const lv = S.level ? levelById(S.level) : null;
  if (lv) c.z = lv.elevation + 0.8;
  const r = Math.max(size.x, size.y, 6);
  if (S.view === 'wall') { setView('3d', { via: 'fit' }); }
  if (S.plan) { setPlanFrame(c, r); return; }
  animateCamera(new V3(c.x - 0.35 * r, c.y - 0.75 * r, c.z + 0.85 * r), c);
}

let orthoHalf = 10;
function setPlanFrame(center, extent) {
  controlsO.target.set(center.x, center.y, 0);
  ortho.position.set(center.x, center.y, 300);
  ortho.lookAt(center.x, center.y, 0);
  ortho.zoom = 1;
  orthoHalf = extent * 0.6;
  resize();
}

/** The current view: '3d' (orbit), 'plan' (from above) or 'wall' (elevation of one wall, from one side). */
export function setPlan(on, via = 'ui') { return setView(on ? 'plan' : '3d', { via }); }

let elevHalf = 3;
function setElevFrame(w, center = null, extent = null) {
  const f = M.wallFrame(w), s = S.elev.side;
  const mid = M.at(f, f.L / 2), zc = (w.base_z + w.top_z) / 2;
  const c = center || new V3(mid[0], mid[1], zc);
  controlsE.target.copy(c);
  orthoE.position.set(c.x + f.n[0] * s * 40, c.y + f.n[1] * s * 40, c.z);
  orthoE.lookAt(c);
  orthoE.zoom = 1;
  const a = vp.clientWidth / Math.max(vp.clientHeight, 1);
  elevHalf = extent ? extent * 0.6 : Math.max((w.top_z - w.base_z) / 2 + 0.4, (f.L / 2 + 0.6) / a);
  resize();
}

/**
 * Switch view. 'wall' needs opts.wall (a wall record); asking for the wall view of the wall already shown flips the
 * side it is seen from. Returns false when the view cannot be shown.
 */
export function setView(view, opts = {}) {
  const via = opts.via || 'ui';
  const from = S.view || '3d';
  const t = controls.target.clone();
  if (view === 'wall') {
    const w = opts.wall;
    if (!w || w.shape === 'arc') { toast('Select a straight wall (or an opening in one) for the wall view.'); return false; }
    const f = M.wallFrame(w);
    let side = opts.side;
    if (side == null) {
      if (from === 'wall' && S.elev && S.elev.wall === w.id) side = -S.elev.side;          // again: the other side
      else {
        const cam = camera.position, v = (cam.x - f.s[0]) * f.n[0] + (cam.y - f.s[1]) * f.n[1];
        const left = (w.faces?.left?.rooms || []).length, right = (w.faces?.right?.rooms || []).length;
        side = Math.abs(v) > 0.05 && camera === persp ? Math.sign(v) : left >= right ? 1 : -1;
      }
    }
    S.elev = { wall: w.id, side };
    camera = orthoE; controls = controlsE;
    controlsP.enabled = false; controlsO.enabled = false; controlsE.enabled = true;
    S.view = 'wall'; S.plan = false;
    setElevFrame(w);
  } else if (view === 'plan') {
    camera = ortho; controls = controlsO;
    controlsP.enabled = false; controlsE.enabled = false; controlsO.enabled = true;
    S.view = 'plan'; S.plan = true;
    setPlanFrame(t, from === '3d' ? Math.max(persp.position.distanceTo(t), 8) : Math.max(orthoHalf, elevHalf) * 1.6);
  } else {
    if (S.level) t.z = levelById(S.level).elevation + 0.8;
    camera = persp; controls = controlsP;
    controlsO.enabled = false; controlsE.enabled = false; controlsP.enabled = true;
    if (from !== '3d') { controlsP.target.copy(t); persp.position.set(t.x - 4, t.y - 8, t.z + 8); }
    S.view = '3d'; S.plan = false;
  }
  $$('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
  applyCut(); updateVisibility(); buildHandles(); updateGumball();
  log('view', { what: 'view', value: S.view, wall: S.view === 'wall' ? S.elev.wall : undefined, side: S.view === 'wall' ? S.elev.side : undefined, via });
  return true;
}

/** Go back to a pose from camPose() (a note's view): view, level-free camera position, target and zoom. */
export function restoreView(pose) {
  if (!pose) return;
  if (pose.view === 'wall') { const w = recOf(pose.wall); if (!w || !setView('wall', { wall: w, side: pose.side, via: 'note' })) return; }
  else setView(pose.view || '3d', { via: 'note' });
  camera.position.set(...pose.pos); controls.target.set(...pose.target);
  if (pose.zoom && camera.isOrthographicCamera) { camera.zoom = pose.zoom; camera.updateProjectionMatrix(); }
  if (camera === persp) camera.lookAt(controls.target);
}

// camera animation
export let anim = null;
export function animateCamera(pos, target, ms = 450) {
  if (S.plan) { controlsO.target.set(target.x, target.y, 0); ortho.position.set(target.x, target.y, 300); return; }
  if (S.view === 'wall') { const d = orthoE.position.clone().sub(controlsE.target); controlsE.target.copy(target); orthoE.position.copy(target).add(d); return; }
  anim = { p0: persp.position.clone(), t0: controlsP.target.clone(), p1: pos.clone(), t1: target.clone(), start: performance.now(), ms };
}
/** Jump to the end of a running camera animation (used at startup). */
export function finishAnimation() {
  if (!anim) return;
  persp.position.copy(anim.p1); controlsP.target.copy(anim.t1); anim = null;
}
function stepAnim() {
  if (!anim) return;
  const k = Math.min(1, (performance.now() - anim.start) / anim.ms), e = k * k * (3 - 2 * k);
  persp.position.lerpVectors(anim.p0, anim.p1, e);
  controlsP.target.lerpVectors(anim.t0, anim.t1, e);
  if (k >= 1) anim = null;
}

export function focusOn(el, via = 'ui') {
  if (!el) return;
  if (S.level && !levelOk(el) && el.levels.length) setLevel(el.levels[0], { via: 'focus' });
  const box = new THREE.Box3();
  for (const m of el.meshes) box.expandByObject(m);
  if (el.kind === 'room' && el.rec.polygon) for (const p of el.rec.polygon) box.expandByPoint(new V3(p[0], p[1], el.rec.floor_z ?? 0));
  if (box.isEmpty()) return;
  const c = box.getCenter(new V3()), size = box.getSize(new V3());
  if (S.plan) { setPlanFrame(c, Math.max(size.x, size.y, 3)); return; }
  if (S.view === 'wall') {
    const w = recOf(S.elev.wall);
    if (w && (el.id === w.id || el.rec.host_wall === w.id)) { setElevFrame(w, c, Math.max(size.x, size.y, size.z, 1.5)); return; }
    setView('3d', { via: 'focus' });
  }
  let dir;
  const w = TYPES[el.kind].focusWall ? TYPES[el.kind].focusWall(el) : null;
  if (w) {
    const f = M.wallFrame(w);
    const left = (w.faces?.left?.rooms || []).length, right = (w.faces?.right?.rooms || []).length;
    let side = left >= right ? 1 : -1;
    // stay on the side the camera is already on when both sides face rooms
    if (left && right) side = Math.sign((persp.position.x - f.s[0]) * f.n[0] + (persp.position.y - f.s[1]) * f.n[1]) || 1;
    // oblique view: the face is visible and handles can be dragged both along and across the wall
    dir = new V3(f.n[0] * side * 0.8 + f.t[0] * 0.45, f.n[1] * side * 0.8 + f.t[1] * 0.45, 0.5).normalize();
    if (S.level && w.base_z !== undefined) c.z = clamp(c.z, w.base_z + 0.3, levelById(S.level).elevation + S.cutRel - 0.2);
  } else dir = new V3(-0.4, -0.6, 0.9).normalize();
  const dist = clamp(Math.max(size.x, size.y, size.z) * 1.1, 2.2, 25);
  animateCamera(c.clone().addScaledVector(dir, dist), c);
  log('focus', { id: el.id, via });
}

/** Metres per screen pixel at a world point (for pixel snap tolerances). */
export function worldPerPixel(p) {
  const h = renderer.domElement.clientHeight || 1;
  if (camera.isOrthographicCamera) return (camera.top - camera.bottom) / camera.zoom / h;
  const d = camera.position.distanceTo(p);
  return (2 * d * Math.tan(((persp.fov * Math.PI) / 180) / 2)) / h;
}

export function resize() {
  const w = vp.clientWidth, h = vp.clientHeight;
  renderer.setSize(w, h); labelRenderer.setSize(w, h);
  persp.aspect = w / h; persp.updateProjectionMatrix();
  const a = w / h;
  Object.assign(ortho, { left: -orthoHalf * a, right: orthoHalf * a, top: orthoHalf, bottom: -orthoHalf });
  ortho.updateProjectionMatrix();
  Object.assign(orthoE, { left: -elevHalf * a, right: elevHalf * a, top: elevHalf, bottom: -elevHalf });
  orthoE.updateProjectionMatrix();
}

export function tick() {
  requestAnimationFrame(tick);
  stepAnim();
  controls.update();
  scaleHandles();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
