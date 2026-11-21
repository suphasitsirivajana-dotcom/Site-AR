// SiteAR — main application wiring.
import * as THREE from 'three';
import { Viewer } from './viewer.js';
import { loadModelFile, getIfcElementInfo, ifcColumnIds, extOf, MODEL_EXT } from './loaders.js';
import { store } from './store.js';
import { Ribbon, toast, hint, hideHint, modal, confirmBox, promptBox, download, fileToDataURL, $, $$, h, esc } from './ui.js';
import { icon, LOGO } from './icons.js';
import { newProject, newMarkup, uuid, MARKUP_TYPES, STATUSES, PRIORITIES, statusColor, markupTitle, timeAgo, SCHEMA } from './project.js';
import { gpsToModel, modelToGps, ifcToRaw, rawToIfc, gpsToEN, bearingFromPair, normDeg, modelHeadingOfRawDir, fmtM, fmtLL } from './geo.js';
import { GPS, DeviceOrient, StepTracker } from './sensors.js';
import { ARController, xrARSupported } from './ar.js';
import { exportBCF, importBCF } from './bcf.js';
import { encodeCP, decodeCP, cpSheet, startScan, decodeImageFile } from './qr.js';
import { poseFromDetection, poseToModel } from './pose.js';

// ================================================================ settings
const SETTINGS_KEY = 'sitear.settings', LAST_KEY = 'sitear.lastProject';
const settings = { author: '', eye: 1.6, camFov: 45, arOpacity: 0.75, gpsAvg: 8, stepLen: 0.7, stepSens: 0.8, trackMode: 'hybrid', qrSize: 0.2, showTrack: true, showMarkups: true, grid: true, scope: true, scopeFactor: 3 };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { /* private mode */ }
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ } };

// ================================================================ state
const app = {
  project: null,
  tool: 'select', toolData: null,
  sel: null,               // selected markup id
  elSel: null,             // { modelId, eid, info }
  loc: { ifc: null, raw: null, acc: null, heading: null, corr: { x: 0, y: 0 }, fix: null, fixZ: null },
  panelTab: 'markups', mkFilter: 'all',
  xr: false,
  dirty: false
};
const isTouch = matchMedia('(pointer: coarse)').matches;

// ================================================================ core objects
const viewer = new Viewer($('#viewport'), $('#c'));
viewer.walk.eye = settings.eye;
viewer.setGrid(settings.grid);
viewer.scopeOn = settings.scope; viewer.scopeFactor = settings.scopeFactor;
viewer.addEventListener('scope-limit', () => toast('Scope limit reached — press Home or turn off Scope in View', 'info', 1400));
const gps = new GPS();
const orient = new DeviceOrient();
const steps = new StepTracker();
viewer.orientSource = orient;
const ar = new ARController({
  viewer, orient, video: $('#camfeed'), overlay: $('#ar-overlay'), settings, toast,
  getRefs, getPositionRaw: () => app.loc.raw, getBearing, onMark: createMarkupFromAR,
  getFaceHeading, toggleSteps: () => cycleTrack(), stepsActive: () => steps.active, trackLabel: () => TRACK_LABEL[settings.trackMode],
  manualStep: () => doStep(false), stepCount: () => app._stepN || 0,
  onQrDetect: (det, K) => onQrDetect(det, K),
  toggleTripod: () => toggleTripod(), tripodActive: () => !!app.loc.tripod
});
ar.addEventListener('end', () => { syncModeUI(); });

// ================================================================ ribbon
// Shown in the status bar so you can see at a glance whether a phone/iPad has picked up the latest upload.
// Bump this together with VERSION in sw.js every time files are uploaded.
const APP_VERSION = '1.4.0';

// Location features (GPS, step tracking, QR control points, tripod, Walk&Mark, AR overlay) are SHELVED for now.
// All the code is still here — set this to true to bring every button back.
const LOCATION_FEATURES = false;
const LOCATION_CMDS = new Set(['walk-mark', 'self-mark', 'face-point', 'set-location', 'gps', 'follow', 'qr-create', 'qr-scan', 'track', 'track-clear',
  'heading-2pt', 'compass', 'ar-xr', 'ar-cam', 'walk-track', 'track-mode', 'steps']);

const RIBBON_FULL = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Project', items: [
      { cmd: 'new', icon: 'newfile', label: 'New', tip: 'New project' },
      { cmd: 'open-model', icon: 'open', label: 'Open Model', tip: 'Open an IFC / DXF / GLB / OBJ file' },
      { cmd: 'projects', icon: 'layers', label: 'Projects', tip: 'Projects stored on this device' },
      { cmd: 'save', icon: 'save', label: 'Save', tip: 'Download the project file (.sitear.json)' }] },
    { label: 'Navigate', items: [
      { cmd: 'walk-mark', icon: 'walk', label: 'Walk&Mark', tip: 'Simple mode: tap where you stand → walk → mark where you stand' },
      { cmd: 'mode-orbit', icon: 'orbit', label: '3D', tip: 'Orbit the 3D model' },
      { cmd: 'mode-plan', icon: 'plan', label: 'Plan', tip: 'Plan view (section cut)' },
      { cmd: 'mode-walk', icon: 'walk', label: 'Walk', tip: 'Walk through the model (WASD / sticks)' },
      { cmd: 'gyro', icon: 'gyro', label: 'Gyro', tip: 'Optional: turn the device to look around (Walk mode)' },
      { cmd: 'home', icon: 'home', label: 'Home', tip: 'Back to the Home view (H)' },
      { cmd: 'set-home', icon: 'sethome', label: 'Set Home', tip: 'Set the current view as Home' },
      { cmd: 'fit', icon: 'fit', label: 'Fit', tip: 'Zoom to fit the whole model' }] },
    { label: 'Markup', items: [
      { cmd: 'select', icon: 'select', label: 'Select' },
      { cmd: 'capture', icon: 'photo', label: 'Capture', tip: 'Capture this view into the active group (C)' },
      { cmd: 'mark-center', icon: 'pin', label: 'Mark', tip: 'Mark the point under the crosshair (M)' },
      { cmd: 'groups', icon: 'layers', label: 'Group', tip: 'Group captures and marks in sequence' },
      { cmd: 'save-view', icon: 'bookmark', label: 'Save View' }] }] },
  { id: 'markup', label: 'Markup', groups: [
    { label: 'Create', items: [
      { cmd: 'capture', icon: 'photo', label: 'Capture', tip: 'Capture this view into the active group (C)' },
      { cmd: 'mark-center', icon: 'pin', label: 'Mark', tip: 'Mark the point under the crosshair (M)' },
      { cmd: 'groups', icon: 'layers', label: 'Group' },
      { cmd: 'mk-comment', icon: 'comment', label: 'Comment' },
      { cmd: 'mk-note', icon: 'note', label: 'Note' },
      { cmd: 'mk-issue', icon: 'issue', label: 'Issue' }] },
    { label: 'Edit', items: [
      { cmd: 'mk-edit', icon: 'edit', label: 'Edit' },
      { cmd: 'mk-lock', icon: 'lock', label: 'Lock', tip: 'Lock the selected markup (no edit / delete)' },
      { cmd: 'mk-resolve', icon: 'resolve', label: 'Resolve' },
      { cmd: 'mk-delete', icon: 'trash', label: 'Delete' }] },
    { label: 'Show', items: [
      { cmd: 'toggle-markups', icon: 'pin', label: 'Pins' },
      { cmd: 'panel-markups', icon: 'panel', label: 'List' }] }] },
  { id: 'view', label: 'View', groups: [
    { label: 'Saved views', items: [
      { cmd: 'save-view', icon: 'bookmark', label: 'Save View' },
      { cmd: 'panel-views', icon: 'views', label: 'Views' }] },
    { label: 'Display', items: [
      { cmd: 'xray', icon: 'xray', label: 'X-Ray' },
      { cmd: 'section', icon: 'section', label: 'Section', tip: 'Horizontal section (plan cut)' },
      { cmd: 'grid', icon: 'grid', label: 'Grid' },
      { cmd: 'models', icon: 'layers', label: 'Models' }] },
    { label: 'Navigation', items: [
      { cmd: 'home', icon: 'home', label: 'Home', tip: 'Back to the Home view (H)' },
      { cmd: 'set-home', icon: 'sethome', label: 'Set Home', tip: 'Set the current view as Home' },
      { cmd: 'scope', icon: 'scope', label: 'Scope', tip: 'Scope box: keep the model on screen and the camera in range' },
      { cmd: 'nav-lock', icon: 'navlock', label: 'Lock View', tip: 'Lock the view (no orbit / pan)' },
      { cmd: 'fit', icon: 'fit', label: 'Fit' }] }] },
  { id: 'site', label: 'Site', groups: [
    { label: 'Location', items: [
      { cmd: 'self-mark', icon: 'pin', label: "I'm Here", tip: 'Self-mark: tap where you stand on the plan (e.g. next to a column)' },
      { cmd: 'face-point', icon: 'target', label: 'Face Point', tip: 'Tap the point you are facing (e.g. the next column) to lock the heading' },
      { cmd: 'set-location', icon: 'anchor', label: 'Set Location', tip: 'Stand on a point → tap it on the plan → capture GPS' },
      { cmd: 'gps', icon: 'gps', label: 'Locate Me', tip: 'Turn on GPS and show your position on the plan' },
      { cmd: 'follow', icon: 'follow', label: 'Follow', tip: 'Walk camera follows GPS' }] },
    { label: 'QR control point', items: [
      { cmd: 'qr-create', icon: 'qr', label: 'Create QR', tip: 'Create a QR at model coordinates for the surveyor to set out' },
      { cmd: 'qr-scan', icon: 'scan', label: 'Scan QR', tip: 'Scan a QR on site to lock your position' }] },
    { label: 'Path', items: [
      { cmd: 'track', icon: 'path', label: 'Path', tip: 'Show the walked path' },
      { cmd: 'track-clear', icon: 'erase', label: 'Clear' }] },
    { label: 'Calibrate', items: [
      { cmd: 'heading-2pt', icon: 'twopoint', label: '2nd Point', tip: 'Refine heading with a second point (better than the compass)' },
      { cmd: 'compass', icon: 'compass', label: 'Compass' }] }] },
  { id: 'ar', label: 'AR', groups: [
    { label: 'Augmented reality', items: [
      { cmd: 'ar-xr', icon: 'ar', label: 'WebXR AR', tip: 'Android Chrome (ARCore) — tracking 6DoF' },
      { cmd: 'ar-cam', icon: 'camera', label: 'Camera AR', tip: 'iPhone / iPad / any device — camera + gyro + GPS/QR' }] },
    { label: 'Walkthrough', items: [
      { cmd: 'self-mark', icon: 'pin', label: "I'm Here", tip: 'Tap where you stand on the plan' },
      { cmd: 'mode-walk', icon: 'walk', label: 'Walk' },
      { cmd: 'walk-track', icon: 'walk', label: 'Walk Track', tip: 'Walk for real: the model follows your steps and the phone heading' },
      { cmd: 'track-mode', icon: 'path', label: 'Tracking', tip: 'Switch tracking: Hybrid (steps + GPS) → Steps only → GPS' },
      { cmd: 'gyro', icon: 'gyro', label: 'Gyro Look', tip: 'Turn the phone to look around' },
      { cmd: 'follow', icon: 'follow', label: 'Follow GPS' }] },
    { label: 'Setup', items: [{ cmd: 'settings', icon: 'sliders', label: 'Settings' }] }] },
  { id: 'share', label: 'Export', groups: [
    { label: 'openBIM (BCF 3.0)', items: [
      { cmd: 'bcf-export', icon: 'bcf', label: 'Export BCF', tip: 'Open in Revit / Navisworks / Solibri / BIMcollab' },
      { cmd: 'bcf-import', icon: 'import', label: 'Import BCF' }] },
    { label: 'Data', items: [
      { cmd: 'json-export', icon: 'json', label: 'Project JSON', tip: 'Project file (for Unity / Revit scripts)' },
      { cmd: 'json-import', icon: 'import', label: 'Import JSON' },
      { cmd: 'csv-export', icon: 'table', label: 'CSV' }] },
    { label: 'Help', items: [{ cmd: 'settings', icon: 'sliders', label: 'Settings' }, { cmd: 'revit-guide', icon: 'info', label: 'Revit Guide' }] }] }
];
// shelved features: drop the Site / AR tabs and every location button (the code stays, nothing is deleted)
const RIBBON = LOCATION_FEATURES ? RIBBON_FULL : RIBBON_FULL
  .filter((t) => t.id !== 'site' && t.id !== 'ar')
  .map((t) => ({ ...t, groups: t.groups.map((g) => ({ ...g, items: g.items.filter((i) => !LOCATION_CMDS.has(i.cmd)) })).filter((g) => g.items.length) }));
const ribbon = new Ribbon($('#ribbon-tabs'), $('#ribbon'), RIBBON, onCommand);
// mouse wheel scrolls the ribbon sideways when it is wider than the window
for (const el of [$('#ribbon'), $('#ribbon-tabs')]) {
  el.addEventListener('wheel', (e) => {
    if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault(); el.scrollLeft += e.deltaY;
  }, { passive: false });
}

async function onCommand(cmd) {
  const P = app.project;
  switch (cmd) {
    case 'new': return cmdNewProject();
    case 'open-model': return $('#file-model').click();
    case 'projects': return cmdProjects();
    case 'save': case 'json-export': return download(new Blob([JSON.stringify(P, null, 2)], { type: 'application/json' }), `${slug(P.name)}.sitear.json`);
    case 'json-import': case 'bcf-import': $('#file-project').dataset.kind = cmd; return $('#file-project').click();
    case 'mode-orbit': return setMode('orbit');
    case 'mode-plan': return setMode('plan');
    case 'mode-walk': return setMode('walk');
    case 'fit': return viewer.fitAll();
    case 'home': return goHome();
    case 'set-home': return setHome();
    case 'scope': settings.scope = !settings.scope; saveSettings(); viewer.scopeOn = settings.scope; toast(settings.scope ? 'Scope box on — model stays in view' : 'Scope box off — free navigation', 'info'); return syncToggles();
    case 'select': return setTool('select');
    case 'mk-comment': return startPlace('comment');
    case 'mk-note': return startPlace('note');
    case 'mk-issue': return startPlace('issue');
    case 'mk-photo': return startPlace('comment', true);
    case 'mk-edit': return withSel((m) => openMarkupEditor(m, false));
    case 'mk-lock': return withSel((m) => { m.locked = !m.locked; touch(m); toast(m.locked ? 'Markup locked' : 'Markup unlocked', 'ok'); });
    case 'mk-resolve': return withSel((m) => { if (m.locked) return toast('Markup is locked', 'warn'); m.status = m.status === 'resolved' ? 'open' : 'resolved'; touch(m); });
    case 'mk-delete': return withSel((m) => deleteMarkup(m));
    case 'toggle-markups': settings.showMarkups = !settings.showMarkups; saveSettings(); refreshMarkers(); return syncToggles();
    case 'panel-markups': return openPanel('markups');
    case 'panel-views': return openPanel('views');
    case 'models': return openPanel('info');
    case 'save-view': return saveView();
    case 'capture': return captureView();
    case 'mark-center': return markCenter();
    case 'groups': return groupDialog();
    case 'xray': viewer.setXray(!viewer.xray); return syncToggles();
    case 'section': return setSection(!viewer.clipOn);
    case 'grid': settings.grid = !settings.grid; saveSettings(); viewer.setGrid(settings.grid); return syncToggles();
    case 'nav-lock': viewer.setNavLocked(!viewer.navLocked); toast(viewer.navLocked ? 'View locked' : 'View unlocked', 'info'); return syncToggles();
    case 'self-mark': return startSelfMark();
    case 'walk-mark': return startWalkMark();
    case 'face-point': return startFacePoint();
    case 'steps': return toggleSteps();
    case 'track-mode': return cycleTrack();
    case 'walk-track': return startWalkTrack();
    case 'set-location': return anchorWizard();
    case 'gps': return toggleGPS();
    case 'follow': viewer.walk.follow = !viewer.walk.follow; if (viewer.walk.follow) { if (!gps.active) await toggleGPS(); setMode('walk'); } return syncToggles();
    case 'gyro': return toggleGyro();
    case 'qr-create': return startCPCreate();
    case 'qr-scan': return scanQR();
    case 'track': settings.showTrack = !settings.showTrack; saveSettings(); renderTrack(); return syncToggles();
    case 'track-clear': if (await confirmBox('Clear path', 'Delete all recorded paths?', 'Clear', true)) { P.tracks = []; save(); renderTrack(); } return;
    case 'heading-2pt': return twoPointWizard();
    case 'compass': return compassDialog();
    case 'ar-xr': return startXR();
    case 'ar-cam': return startCamAR();
    case 'settings': return settingsDialog();
    case 'bcf-export': return cmdExportBCF();
    case 'csv-export': return cmdExportCSV();
    case 'revit-guide': return revitGuide();
    default: console.warn('unknown command', cmd);
  }
}
function withSel(fn) {
  const m = app.project.markups.find((x) => x.id === app.sel);
  if (!m) { toast('Select a markup first (tap a pin or pick one in the list)', 'warn'); return; }
  fn(m);
}
function syncToggles() {
  ribbon.setActive('xray', viewer.xray);
  ribbon.setActive('section', viewer.clipOn);
  ribbon.setActive('grid', settings.grid);
  ribbon.setActive('nav-lock', viewer.navLocked);
  ribbon.setActive('scope', settings.scope);
  ribbon.setActive('steps', steps.active);
  ribbon.setActive('walk-track', steps.active && viewer.walk.gyro && viewer.walk.follow && viewer.mode === 'walk');
  ribbon.setActive('face-point', app.tool === 'face');
  ribbon.setActive('gps', gps.active);
  ribbon.setActive('follow', viewer.walk.follow);
  ribbon.setActive('gyro', viewer.walk.gyro);
  ribbon.setActive('track', settings.showTrack);
  ribbon.setActive('toggle-markups', settings.showMarkups);
  const sel = app.project && app.project.markups.find((x) => x.id === app.sel);
  ribbon.setActive('mk-lock', !!(sel && sel.locked));
  for (const t of ['select', 'mk-comment', 'mk-note', 'mk-issue', 'mk-photo', 'set-location', 'qr-create', 'heading-2pt']) ribbon.setActive(t, false);
  ribbon.setActive('self-mark', app.tool === 'self');
  const toolCmd = { select: 'select', anchor: 'set-location', cp: 'qr-create', second: 'heading-2pt' }[app.tool]
    || (app.tool === 'place' ? (app.toolData.photo ? 'mk-photo' : `mk-${app.toolData.type}`) : null);
  if (toolCmd) ribbon.setActive(toolCmd, true);
  ribbon.setActive('mode-orbit', viewer.mode === 'orbit'); ribbon.setActive('mode-plan', viewer.mode === 'plan'); ribbon.setActive('mode-walk', viewer.mode === 'walk');
  $('#lock-badge').hidden = !viewer.navLocked;
}
// re-sync when the ribbon tab changes (it re-renders)
new MutationObserver(() => syncToggles()).observe($('#ribbon'), { childList: true });

// ================================================================ modes & tools
function setMode(m) {
  if (ar.active) ar.stop();
  const first = m === 'plan' && !app._planSeen;
  viewer.setMode(m);
  if (m === 'plan' && !app._planHint) { app._planHint = true; toast('Plan view: drag to pan · pinch to zoom · switch to 3D to orbit', 'info', 4500); }
  if (first) { app._planSeen = true; if (!viewer.clipOn) setSection(true); viewer.fitAll(); }
  syncModeUI();
}
function syncModeUI() {
  $$('#modebar [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === viewer.mode || (b.dataset.mode === 'ar' && (viewer.mode === 'xr' || viewer.mode === 'cam-ar'))));
  const walking = viewer.mode === 'walk';
  // game-style controls in Walk: left stick = move, right stick = look (touch), ▲▼ = fly up / down, speed
  $('#joystick').hidden = !(walking && isTouch);
  $('#joystick-look').hidden = !(walking && isTouch);
  $('#fly').hidden = !walking;
  $('#gyro-btn').hidden = !(walking && isTouch);
  $('#gyro-btn').classList.toggle('on', !!viewer.walk.gyro);
  $('#gyro-state').textContent = viewer.walk.gyro ? 'ON' : 'OFF';
  $('#step-btn').hidden = !LOCATION_FEATURES || (app.wm ? app.wm.state !== 'walk' : !(walking && app.loc.stepMode));
  $('#crosshair').hidden = !(viewer.mode === 'cam-ar' || walking); // aim point for Mark / Capture
  $('#quick').hidden = viewer.mode === 'xr' || viewer.mode === 'cam-ar';
  document.body.dataset.mode = viewer.mode;
  syncToggles();
}
// Ground points (anchor / QR) are picked most accurately on a cut plan, not on the roof in 3D
function goPlanForPicking() {
  // remember where the user was, so we can put them back (otherwise they stay stuck in Plan, which cannot rotate)
  if (!app.prePick) app.prePick = { mode: viewer.mode, clip: viewer.clipOn };
  if (viewer.mode !== 'plan') setMode('plan');
  if (!viewer.clipOn) setSection(true);
}
function restorePickMode() {
  const p = app.prePick; app.prePick = null;
  if (!p) return;
  if (p.mode !== viewer.mode && (p.mode === 'orbit' || p.mode === 'walk')) setMode(p.mode);
  if (!p.clip && viewer.clipOn) setSection(false);
}
// ---------------- Home view (like the Revit ViewCube home)
function goHome() {
  const h = app.project && app.project.app.home;
  if (viewer.mode !== 'orbit' && viewer.mode !== 'plan' && viewer.mode !== 'walk') return;
  if (h) viewer.setViewState(h); else viewer.fitAll();
  syncModeUI();
}
function setHome() {
  app.project.app.home = viewer.getViewState();
  save();
  toast('Home view set — press Home / H to come back', 'ok');
}

function setTool(t, data = null) {
  app.tool = t; app.toolData = data;
  if (t === 'select') hideHint();
  else if (window.innerWidth < 900) { document.body.classList.remove('panel-open'); setTimeout(() => viewer.resize(), 300); } // free the screen on phones
  document.body.dataset.tool = t;
  syncToggles();
}
function cancelTool() { setTool('select'); restorePickMode(); }
document.addEventListener('keydown', (e) => {
  if (/input|textarea|select/i.test(e.target.tagName) || $('#modal-root').children.length) return;
  if (e.key === 'Escape') cancelTool();
  if (e.key === 'f' || e.key === 'F') viewer.fitAll();
  if (e.key === 'h' || e.key === 'H') goHome();
  if (e.key === '1') setMode('orbit'); if (e.key === '2') setMode('plan'); if (e.key === '3') setMode('walk');
  if (e.key === 'c' || e.key === 'C') captureView();
  if (e.key === 'm' || e.key === 'M') markCenter();
  if (e.key === 'n' || e.key === 'N') startPlace('note');
  if (e.key === 'Delete' && app.sel) withSel(deleteMarkup);
});

function startPlace(type, photo = false) {
  if (!viewer.models.children.length) return toast('Open a model first (Open Model)', 'warn');
  setTool('place', { type, photo });
  hint(`Tap the model where the ${MARKUP_TYPES[type].label} should go${photo ? ' + Photo' : ''}`, cancelTool);
}

viewer.addEventListener('tap', async (e) => {
  const { x, y } = e.detail;
  if (viewer.mode === 'xr' || viewer.mode === 'cam-ar') return;
  const tool = app.tool;
  if (tool === 'select') {
    const hit = viewer.pick(x, y);
    if (!hit) return clearSelection();
    if (hit.type === 'marker') return selectMarkup(hit.id, false);
    if (hit.type === 'cp') return showCPSheet(app.project.geo.controlPoints.find((c) => c.id === hit.id));
    // (control points keep full ids in the project; only QR payloads are shortened)
    if (hit.type === 'model' && hit.eid != null) return selectElement(hit);
    setPickReadout(viewer.worldToIfc(hit.point));
    return clearSelection();
  }
  const hit = viewer.pick(x, y, { markers: false });
  if (!hit) return toast('No surface there — tap on the model', 'warn');
  const ifc = viewer.worldToIfc(hit.point);
  const data = app.toolData;
  setTool('select');
  if (tool === 'place') return createMarkupAt(hit, ifc, data);
  if (tool === 'anchor') { restorePickMode(); return anchorStep2(ifc); }
  if (tool === 'cp') { restorePickMode(); return cpDialog(ifc); }
  if (tool === 'second') { restorePickMode(); return twoPointStep2(ifc); }
  if (tool === 'wmpos') { await selfMarkAt(hit, ifc); return wmState('face'); }
  if (tool === 'wmface') return wmSetFacing(ifc);
  if (tool === 'self') { await selfMarkAt(hit, ifc); return restorePickMode(); }
  if (tool === 'face') { facePointAt(ifc); return restorePickMode(); }
});
viewer.addEventListener('dbltap', (e) => {
  if (viewer.mode !== 'orbit') return;
  const hit = viewer.pick(e.detail.x, e.detail.y, { markers: false });
  if (hit) viewer.focusPoint(hit.point, viewer.persp.position.distanceTo(viewer.orbit.target) * 0.6);
});

// ================================================================ project lifecycle
let saveTimer = null;
function save() {
  if (!app.project) return;
  app.project.modifiedAt = new Date().toISOString();
  setSaveState('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await store.putProject(app.project); setSaveState('saved'); } catch (e) { console.error(e); setSaveState('error'); }
  }, 500);
}
function setSaveState(s) {
  const el = $('#save-state');
  el.dataset.state = s;
  el.innerHTML = s === 'saving' ? '<span class="spin-sm"></span>Saving' : s === 'error' ? `${icon('x')}Not saved` : `${icon('check')}Saved`;
}
function touch(m) { m.modifiedAt = new Date().toISOString(); save(); refreshMarkers(); renderPanel(); syncToggles(); }

async function openProject(p) {
  for (const o of [...viewer.models.children]) viewer.removeModel(o.userData.modelId);
  viewer.hasOffset = false; viewer.root.position.set(0, 0, 0); viewer.root.updateMatrixWorld(true);
  steps.stop(); app.loc.stepMode = false; app.loc.tripod = false; app.prePick = null; app.wm = null; document.body.classList.remove('wm'); $('#wm').hidden = true;
  app.project = p; app.sel = null; app.elSel = null; app.loc.corr = { x: 0, y: 0 }; app.loc.fix = null;
  // migrate older/foreign files
  p.geo = p.geo || { anchor: null, controlPoints: [] }; p.geo.controlPoints = p.geo.controlPoints || [];
  p.markups = p.markups || []; p.groups = p.groups || []; p.views = p.views || []; p.tracks = p.tracks || []; p.app = p.app || { viewOrigin: null };
  p.nextNumber = p.nextNumber || (Math.max(0, ...p.markups.map((m) => m.number || 0)) + 1);
  // restore the last "I'm Here" / QR position
  if (LOCATION_FEATURES && p.geo.here && p.geo.here.position) { app.loc.fix = { id: p.geo.here.id, position: { ...p.geo.here.position }, t: p.geo.here.t }; app.loc.fixZ = p.geo.here.position.z; }
  try { localStorage.setItem(LAST_KEY, p.id); } catch (e) { /* ignore */ }
  $('#project-name').textContent = p.name;
  for (const rec of p.models) {
    const f = await store.getFile(rec.fileId);
    if (!f) { rec.missing = true; continue; }
    rec.missing = false;
    try { await addLoadedModel(rec, f.name, f.data, false); } catch (e) { console.error(e); toast(`Could not load ${rec.name}: ${e.message}`, 'error', 5000); }
  }
  busy(false);
  updateEmptyState();
  refreshAll();
  if (viewer.models.children.length) { if (p.app.home) viewer.setViewState(p.app.home); else viewer.fitAll(false); }
  const missing = p.models.filter((m) => m.missing);
  if (missing.length) toast(`Model file not on this device: ${missing.map((m) => m.name).join(', ')} — use Open Model to add it again`, 'warn', 7000);
}

async function addLoadedModel(rec, name, data, isNew) {
  busy(`Loading ${name}…`);
  const res = await loadModelFile(name, data, { unitScale: rec.unitScale }, (t) => busy(t));
  viewer.addModel(res.object, rec.id, app.project.app.viewOrigin);
  app._cols = null; // column snap cache
  if (!app.project.app.viewOrigin) app.project.app.viewOrigin = viewer.offset.toArray();
  res.object.visible = rec.visible !== false;
  rec.info = { ...res.info };
  if (isNew) rec.format = res.info.format;
  updateFloorFromStoreys();
  return res;
}

async function onModelFiles(files) {
  for (const file of files) {
    const ext = extOf(file.name);
    if (!MODEL_EXT.includes(ext) && !['dwg', 'rvt'].includes(ext)) { toast(`.${ext} is not supported`, 'warn'); continue; }
    try {
      const data = await file.arrayBuffer();
      const P = app.project;
      let rec = P.models.find((m) => m.name === file.name && m.missing);
      const isNew = !rec;
      if (!rec) rec = { id: uuid(), name: file.name, format: ext, fileId: null, visible: true, unitScale: null, info: null };
      if (!rec.fileId) rec.fileId = rec.id;
      const res = await addLoadedModel(rec, file.name, data, isNew);
      await store.putFile({ id: rec.fileId, name: file.name, data });
      rec.missing = false;
      if (isNew) P.models.push(rec);
      busy(false);
      save(); updateEmptyState(); refreshAll();
      viewer.fitAll();
      toast(`${file.name} loaded`, 'ok');
      if (res.info.site && !P.geo.anchor) suggestSiteAnchor(res.info);
    } catch (e) {
      busy(false); console.error(e);
      toast(e.message || String(e), 'error', 6000);
    }
  }
}

async function cmdNewProject() {
  const name = await promptBox('New project', 'Project name', 'Untitled project');
  if (name === null) return;
  const p = newProject(name || 'Untitled project');
  await store.putProject(p);
  await openProject(p);
}

async function cmdProjects() {
  const list = (await store.listProjects()).sort((a, b) => (b.modifiedAt || '').localeCompare(a.modifiedAt || ''));
  const body = h(`<div class="proj-list">${list.map((p) => `
    <div class="proj-item ${p.id === app.project.id ? 'current' : ''}" data-id="${p.id}">
      <div class="proj-icon">${icon('layers')}</div>
      <div class="proj-main"><b>${esc(p.name)}</b><span>${p.models.length} models · ${p.markups.length} markups · ${timeAgo(p.modifiedAt)}</span></div>
      <button class="icon-btn" data-act="rename" title="Rename">${icon('edit')}</button>
      <button class="icon-btn" data-act="del" title="Delete">${icon('trash')}</button>
    </div>`).join('')}</div>`);
  const m = modal({ title: 'Projects', body, actions: [{ label: 'New project', icon: 'plus', kind: 'primary', onClick: (c) => { c(); cmdNewProject(); } }] });
  body.onclick = async (e) => {
    const item = e.target.closest('.proj-item'); if (!item) return;
    const id = item.dataset.id, act = e.target.closest('[data-act]')?.dataset.act;
    const p = list.find((x) => x.id === id);
    if (act === 'del') {
      if (id === app.project.id) return toast('The open project cannot be deleted', 'warn');
      if (!(await confirmBox('Delete project', `Delete "${p.name}" and its model files on this device? This cannot be undone.`, 'Delete', true))) return;
      for (const md of p.models) await store.deleteFile(md.fileId);
      await store.deleteProject(id); item.remove(); return;
    }
    if (act === 'rename') {
      const n = await promptBox('Rename project', 'Name', p.name); if (!n) return;
      p.name = n; await store.putProject(p);
      if (id === app.project.id) { app.project.name = n; $('#project-name').textContent = n; save(); }
      item.querySelector('b').textContent = n; return;
    }
    m.close(); if (id !== app.project.id) openProject(await store.getProject(id));
  };
}
$('#project-name').onclick = async () => {
  const n = await promptBox('Rename project', 'Project name', app.project.name);
  if (n) { app.project.name = n; $('#project-name').textContent = n; save(); }
};

// ================================================================ busy / empty state
function busy(text) {
  const el = $('#busy');
  if (!text) { el.hidden = true; return; }
  el.hidden = false; el.querySelector('span').textContent = text;
}
function updateEmptyState() { $('#empty').hidden = viewer.models.children.length > 0; }

// ================================================================ markups
async function ensureAuthor() {
  if (settings.author) return settings.author;
  const n = await promptBox('Your name', 'Author name (shown in BCF / Revit)', '');
  settings.author = n || 'Site user'; saveSettings();
  return settings.author;
}
async function elementInfoFor(modelId, eid) {
  if (eid == null) return null;
  try {
    const info = await getIfcElementInfo(viewer.getModel(modelId), eid);
    return info ? { guid: info.guid, name: info.name, ifcType: info.ifcType, modelId, expressID: eid } : null;
  } catch (e) { return null; }
}
function gpsOfPoint(ifc) {
  const a = app.project.geo.anchor;
  if (a) { const g = modelToGps(a, ifc); return { lat: g.lat, lon: g.lon, acc: null, derived: true }; }
  return null;
}

async function createMarkupAt(hit, ifc, { type, photo, source }) {
  const author = await ensureAuthor();
  const element = hit.type === 'model' ? await elementInfoFor(hit.modelId, hit.eid) : null;
  const m = newMarkup({ nextNumber: app.project.nextNumber }, {
    type, author, position: ifc, element, gps: gpsOfPoint(ifc), group: ensureGroup().id,
    source: source || (viewer.mode === 'plan' ? 'plan' : viewer.mode === 'walk' ? 'walk' : '3d'),
    viewpoint: viewer.getViewState(), snapshot: viewer.snapshot(720)
  });
  openMarkupEditor(m, true, photo);
}

async function createMarkupFromAR(raw, info) {
  const author = await ensureAuthor();
  const ifc = rawToIfc(raw);
  const element = info.eid != null ? await elementInfoFor(info.modelId, info.eid) : null;
  const gpsNow = gps.last && gps.active ? { lat: gps.last.lat, lon: gps.last.lon, acc: gps.last.acc } : gpsOfPoint(ifc);
  const m = newMarkup(app.project, {
    type: info.type, text: info.text, author, position: ifc, element, gps: gpsNow, source: info.source,
    viewpoint: { ...viewer.getViewState(), mode: 'orbit' }, snapshot: info.photo || null, photos: info.photo ? [info.photo] : []
  });
  app.project.markups.push(m);
  save(); refreshMarkers(); renderPanel();
}

function openMarkupEditor(m, isNew, openCamera = false) {
  const draft = JSON.parse(JSON.stringify(m));
  const lockedAtOpen = m.locked && !isNew;
  const opts = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(typeof v === 'string' ? v : v.label)}</option>`).join('');
  const body = h(`<div class="mk-editor ${lockedAtOpen ? 'is-locked' : ''}">
    <div class="seg type-seg" id="me-type">${Object.entries(MARKUP_TYPES).map(([k, t]) => `<button type="button" data-t="${k}" class="${draft.type === k ? 'on' : ''}" style="--c:${t.color}">${icon(t.icon)}<span>${t.label}</span></button>`).join('')}</div>
    <label class="field"><span>Title</span><input id="me-title" value="${esc(draft.title)}" placeholder="${esc(markupTitle(draft))}"></label>
    <label class="field"><span>Description</span><textarea id="me-text" rows="4" placeholder="Describe what you found / what needs fixing…">${esc(draft.text)}</textarea></label>
    <div class="field-row">
      <label class="field"><span>Status</span><select id="me-status">${opts(STATUSES, draft.status)}</select></label>
      <label class="field"><span>Priority</span><select id="me-prio">${opts(PRIORITIES, draft.priority)}</select></label>
      <label class="field"><span>Assigned to</span><input id="me-assign" value="${esc(draft.assignedTo)}" placeholder="—"></label>
    </div>
    <label class="field"><span>Group</span><select id="me-group"><option value="">— No group</option>${((app.project.groups) || []).map((g) => `<option value="${g.id}" ${g.id === draft.group ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
    <div class="field"><span>Photos</span><div class="photos" id="me-photos"></div></div>
    <div class="meta-grid">
      <div><span>Position · IFC (m)</span><b class="mono">X ${fmtM(draft.position.x)} · Y ${fmtM(draft.position.y)} · Z ${fmtM(draft.position.z)}</b></div>
      <div><span>GPS</span><b class="mono">${draft.gps ? `${fmtLL(draft.gps.lat)}, ${fmtLL(draft.gps.lon)}` : '—'}</b></div>
      <div class="span2"><span>BIM element</span><b>${draft.element ? `${esc(draft.element.ifcType)} · ${esc(draft.element.name || '')}` : '— (not linked to an element)'}</b>${draft.element && draft.element.guid ? `<code>${esc(draft.element.guid)}</code>` : ''}</div>
      <div><span>Created</span><b>${esc(draft.author || '—')} · ${new Date(draft.createdAt).toLocaleString()}</b></div>
      <div><span>Source</span><b>${esc(draft.source)}</b></div>
    </div>
    <label class="switch"><input type="checkbox" id="me-lock" ${draft.locked ? 'checked' : ''}><i></i><span>${icon('lock')} Lock — prevent edit / move / delete</span></label>
    ${isNew ? '' : `<div class="replies"><div class="rep-head">Replies</div><div id="me-replies"></div>
      <div class="rep-input"><input id="me-reply" placeholder="Reply…"><button class="icon-btn accent" id="me-send">${icon('send')}</button></div></div>`}
    <input type="file" id="me-file" accept="image/*" multiple hidden>
  </div>`);
  const renderPhotos = () => {
    const el = body.querySelector('#me-photos');
    el.innerHTML = draft.photos.map((p, i) => `<div class="ph"><img src="${p}" alt=""><button class="ph-x" data-i="${i}" ${lockedAtOpen ? 'hidden' : ''}>${icon('x')}</button></div>`).join('') +
      (lockedAtOpen ? '' : `<button class="ph add" id="me-addph">${icon('photo')}<span>Add photo</span></button>`) +
      (draft.snapshot ? `<div class="ph snap" title="3D view snapshot"><img src="${draft.snapshot}" alt=""><em>3D view</em></div>` : '');
  };
  const renderReplies = () => {
    const el = body.querySelector('#me-replies'); if (!el) return;
    el.innerHTML = draft.replies.length ? draft.replies.map((r) => `<div class="rep"><b>${esc(r.author)}</b><span>${timeAgo(r.date)}</span><p>${esc(r.text)}</p></div>`).join('') : '<p class="muted small">No replies yet</p>';
  };
  renderPhotos(); renderReplies();
  if (lockedAtOpen) body.querySelectorAll('#me-title,#me-text,#me-status,#me-prio,#me-assign').forEach((x) => (x.disabled = true));
  body.querySelector('#me-type').onclick = (e) => {
    if (lockedAtOpen) return;
    const b = e.target.closest('[data-t]'); if (!b) return;
    draft.type = b.dataset.t; body.querySelectorAll('#me-type button').forEach((x) => x.classList.toggle('on', x === b));
  };
  body.querySelector('#me-photos').onclick = (e) => {
    const x = e.target.closest('.ph-x'); if (x) { draft.photos.splice(+x.dataset.i, 1); renderPhotos(); return; }
    if (e.target.closest('#me-addph')) body.querySelector('#me-file').click();
  };
  body.querySelector('#me-file').onchange = async (e) => {
    for (const f of e.target.files) { try { draft.photos.push(await fileToDataURL(f)); } catch (err) { toast(err.message, 'error'); } }
    e.target.value = ''; renderPhotos();
  };
  const send = body.querySelector('#me-send');
  if (send) {
    const doSend = () => {
      const inp = body.querySelector('#me-reply'); const t = inp.value.trim(); if (!t) return;
      draft.replies.push({ id: uuid(), author: settings.author || 'Site user', date: new Date().toISOString(), text: t });
      inp.value = ''; renderReplies();
    };
    send.onclick = doSend; body.querySelector('#me-reply').onkeydown = (e) => { if (e.key === 'Enter') doSend(); };
  }
  const collect = () => {
    if (!lockedAtOpen) {
      draft.title = body.querySelector('#me-title').value.trim();
      draft.text = body.querySelector('#me-text').value.trim();
      draft.status = body.querySelector('#me-status').value;
      draft.priority = body.querySelector('#me-prio').value;
      draft.assignedTo = body.querySelector('#me-assign').value.trim();
      draft.group = body.querySelector('#me-group').value || null;
    }
    draft.locked = body.querySelector('#me-lock').checked;
    draft.modifiedAt = new Date().toISOString();
  };
  const actions = [];
  if (!isNew && !lockedAtOpen) actions.push({ label: 'Delete', icon: 'trash', kind: 'danger ghost', left: true, onClick: (c) => { c(); deleteMarkup(m); } });
  if (!isNew) actions.push({ label: 'Go to', icon: 'target', left: true, onClick: (c) => { c(); selectMarkup(m.id, true); } });
  actions.push({ label: 'Cancel', onClick: (c) => c() });
  actions.push({ label: isNew ? 'Create' : 'Save', icon: 'check', kind: 'primary', onClick: (c) => {
    collect();
    if (isNew) { draft.number = app.project.nextNumber++; app.project.markups.push(draft); app.sel = draft.id; }
    else Object.assign(m, draft);
    c(); save(); refreshMarkers(); if (app.wm) renderPanel(); else openPanel('markups'); syncToggles(); // Walk&Mark keeps the map full-screen
    toast(isNew ? `${MARKUP_TYPES[draft.type].label} #${draft.number} created` : 'Saved', 'ok');
  } });
  const md = modal({ title: isNew ? `New ${MARKUP_TYPES[draft.type].label}` : `${MARKUP_TYPES[m.type].label} #${m.number}`, body, actions, wide: true });
  if (openCamera) setTimeout(() => body.querySelector('#me-file').click(), 200);
  else if (isNew) setTimeout(() => body.querySelector('#me-text').focus(), 120);
  return md;
}

async function deleteMarkup(m) {
  if (m.locked) return toast('This markup is locked — unlock it before deleting', 'warn');
  if (!(await confirmBox('Delete markup', `Delete ${MARKUP_TYPES[m.type].label} #${m.number}?`, 'Delete', true))) return;
  app.project.markups = app.project.markups.filter((x) => x.id !== m.id);
  if (app.sel === m.id) app.sel = null;
  save(); refreshMarkers(); renderPanel(); syncToggles();
}

function selectMarkup(id, fly = true) {
  const m = app.project.markups.find((x) => x.id === id); if (!m) return;
  app.sel = id; app.elSel = null; hideSelChip();
  viewer.clearHighlight();
  if (m.element && m.element.modelId && m.element.expressID != null) viewer.highlightElement(m.element.modelId, m.element.expressID);
  refreshMarkers(); openPanel('markups'); syncToggles();
  if (fly) viewer.focusPoint(viewer.ifcToWorld(m.position), 7);
  setPickReadout(m.position);
}
function clearSelection() {
  app.sel = null; app.elSel = null; viewer.clearHighlight(); hideSelChip(); refreshMarkers(); renderPanel(); syncToggles();
}
async function selectElement(hit) {
  app.sel = null;
  viewer.highlightElement(hit.modelId, hit.eid);
  refreshMarkers();
  const ifc = viewer.worldToIfc(hit.point);
  setPickReadout(ifc);
  let info = null;
  try { info = await getIfcElementInfo(viewer.getModel(hit.modelId), hit.eid); } catch (e) { /* ignore */ }
  app.elSel = { modelId: hit.modelId, eid: hit.eid, info, hit, ifc };
  showSelChip();
  if (app.panelTab === 'info') renderPanel();
}
function showSelChip() {
  const s = app.elSel; const el = $('#selchip');
  if (!s) return hideSelChip();
  el.innerHTML = `<div class="sc-main"><b>${esc(s.info ? s.info.ifcType : 'Element')}</b><span>${esc(s.info ? (s.info.name || s.info.guid) : `#${s.eid}`)}</span></div>
    <button class="chip-btn" data-a="comment">${icon('comment')}<span>Comment</span></button>
    <button class="chip-btn" data-a="issue">${icon('issue')}<span>Issue</span></button>
    <button class="chip-btn" data-a="info">${icon('info')}</button>
    <button class="chip-btn" data-a="x">${icon('x')}</button>`;
  el.hidden = false;
  el.onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    if (a === 'x') return clearSelection();
    if (a === 'info') return openPanel('info');
    createMarkupAt(s.hit, s.ifc, { type: a });
  };
}
function hideSelChip() { $('#selchip').hidden = true; }

function refreshMarkers() {
  const P = app.project;
  const list = P.markups.filter(filterFn()).map((m) => ({ id: m.id, number: m.number, position: m.position, color: statusColor(m) }));
  viewer.setMarkers(list, app.sel, settings.showMarkups);
  $('#mk-count').textContent = P.markups.length;
  renderBadges(); renderTrack(); updateGroupChip();
}
function filterFn() {
  const f = app.mkFilter, gsel = app.mkGroup || 'all';
  return (m) => (gsel === 'all' || m.group === gsel) &&
    (f === 'all' || (f === 'open' ? m.status === 'open' || m.status === 'in-progress' : f === 'done' ? m.status === 'resolved' || m.status === 'closed' : m.type === f));
}

// ================================================================ Groups: captures / marks that belong together, in order
function activeGroup() { const P = app.project; return (P.groups || []).find((g) => g.id === P.app.activeGroup) || null; }
function ensureGroup() {
  const P = app.project; P.groups = P.groups || [];
  let g = activeGroup();
  if (!g) { g = { id: uuid(), name: `Group ${P.groups.length + 1}`, createdAt: new Date().toISOString() }; P.groups.push(g); P.app.activeGroup = g.id; save(); }
  updateGroupChip();
  return g;
}
function groupName(id) { const g = ((app.project && app.project.groups) || []).find((x) => x.id === id); return g ? g.name : ''; }
function updateGroupChip() { const g = app.project && activeGroup(); const el = $('#q-group-name'); if (el) el.textContent = g ? g.name : 'No group'; }
function groupDialog() {
  const P = app.project; P.groups = P.groups || [];
  const body = h('<div class="proj-list"></div>');
  const render = () => {
    body.innerHTML = P.groups.map((g) => {
      const n = P.markups.filter((m) => m.group === g.id).length, on = g.id === P.app.activeGroup;
      return `<div class="proj-item ${on ? 'current' : ''}" data-id="${g.id}"><div class="proj-icon">${icon('layers')}</div>
        <div class="proj-main"><b>${esc(g.name)}</b><span>${n} item${n === 1 ? '' : 's'}${on ? ' · active (new captures / marks go here)' : ' · tap to make active'}</span></div>
        <button class="icon-btn" data-a="ren" title="Rename">${icon('edit')}</button><button class="icon-btn" data-a="del" title="Delete group">${icon('trash')}</button></div>`;
    }).join('') || '<p class="muted">No groups yet — press "New group"</p>';
  };
  const refresh = () => { save(); updateGroupChip(); render(); refreshMarkers(); renderPanel(); };
  render();
  modal({ title: 'Groups', body, actions: [
    { label: 'Close', onClick: (c) => c() },
    { label: 'New group', icon: 'plus', kind: 'primary', onClick: async () => {
      const n = await promptBox('New group', 'Group name', `Group ${P.groups.length + 1}`); if (!n) return;
      const g = { id: uuid(), name: n, createdAt: new Date().toISOString() }; P.groups.push(g); P.app.activeGroup = g.id; refresh();
    } }] });
  body.onclick = async (e) => {
    const it = e.target.closest('.proj-item'); if (!it) return;
    const g = P.groups.find((x) => x.id === it.dataset.id), a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'ren') { const n = await promptBox('Rename group', 'Name', g.name); if (n) { g.name = n; refresh(); } return; }
    if (a === 'del') {
      if (await confirmBox('Delete group', `Delete group "${g.name}"? Its captures and marks are kept, just ungrouped.`, 'Delete', true)) {
        P.markups.forEach((m) => { if (m.group === g.id) m.group = null; });
        P.groups = P.groups.filter((x) => x !== g); if (P.app.activeGroup === g.id) P.app.activeGroup = null; refresh();
      }
      return;
    }
    P.app.activeGroup = g.id; refresh();
  };
}

// ---------------- aim point = what is under the crosshair (centre of the screen)
function aimPoint() {
  viewer.raycaster.setFromCamera(new THREE.Vector2(0, 0), viewer.camera);
  viewer.raycaster.camera = viewer.camera;
  const hit = viewer.pickRay(viewer.raycaster, { markers: false });
  if (hit && hit.point) return { point: hit.point.clone(), hit };
  return { point: viewer.raycaster.ray.at(5, new THREE.Vector3()), hit: null };
}
// Capture: save a screenshot of the current 3D view into the active group straight away (no dialog) — like a game screenshot
async function captureView() {
  if (!viewer.models.children.length) return toast('Open a model first', 'warn');
  const author = await ensureAuthor(), g = ensureGroup(), a = aimPoint();
  const m = newMarkup(app.project, {
    type: 'capture', author, position: viewer.worldToIfc(a.point), group: g.id, source: 'capture',
    viewpoint: viewer.getViewState(), snapshot: viewer.snapshot(1280, 'image/jpeg', 0.85)
  });
  app.project.markups.push(m); app.sel = m.id;
  const s = h('<div class="shutter"></div>'); $('#viewport').appendChild(s); setTimeout(() => s.remove(), 400);
  save(); refreshMarkers(); renderPanel();
  toast(`Captured #${m.number} · ${g.name}`, 'ok', 1800);
}
async function markCenter() {
  if (!viewer.models.children.length) return toast('Open a model first', 'warn');
  const a = aimPoint();
  await createMarkupAt(a.hit || { type: 'plane' }, viewer.worldToIfc(a.point), { type: 'comment' });
}
$('#q-capture').onclick = captureView;
$('#q-mark').onclick = markCenter;
$('#q-group').onclick = groupDialog;

// ================================================================ views
async function saveView() {
  const n = await promptBox('Save view', 'View name', `View ${app.project.views.length + 1}`);
  if (n === null) return;
  const v = { id: uuid(), name: n || `View ${app.project.views.length + 1}`, createdAt: new Date().toISOString(), locked: false, ...viewer.getViewState(), thumb: viewer.snapshot(360) };
  app.project.views.push(v); save(); openPanel('views');
  toast('View saved', 'ok');
}

// ================================================================ panel
function openPanel(tab) {
  app.panelTab = tab;
  document.body.classList.add('panel-open');
  renderPanel();
  setTimeout(() => viewer.resize(), 260);
}
function renderPanel() {
  $$('#panel-tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === app.panelTab));
  const el = $('#panel-body');
  if (app.panelTab === 'markups') el.innerHTML = markupsHTML();
  else if (app.panelTab === 'views') el.innerHTML = viewsHTML();
  else el.innerHTML = infoHTML();
}
$('#panel-tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) openPanel(b.dataset.tab); };
$('#btn-panel').onclick = () => { document.body.classList.toggle('panel-open'); renderPanel(); setTimeout(() => viewer.resize(), 260); };
$('#panel-close').onclick = () => { document.body.classList.remove('panel-open'); setTimeout(() => viewer.resize(), 260); };

function markupsHTML() {
  const P = app.project;
  const sel = P.markups.find((m) => m.id === app.sel);
  const items = P.markups.filter(filterFn()).sort((a, b) => b.number - a.number);
  const filters = [['all', 'All'], ['open', 'Open'], ['done', 'Done'], ['capture', 'Captures'], ['comment', 'Comments'], ['note', 'Notes'], ['issue', 'Issues']];
  const gsel = app.mkGroup || 'all';
  const groupPills = (P.groups && P.groups.length) ? `<div class="filters"><button class="pill ${gsel === 'all' ? 'on' : ''}" data-group="all">All groups</button>${P.groups.map((g) => `<button class="pill ${gsel === g.id ? 'on' : ''}" data-group="${g.id}">${esc(g.name)}</button>`).join('')}</div>` : '';
  const detail = sel ? `
    <div class="mk-detail">
      ${sel.photos[0] || sel.snapshot ? `<div class="mk-hero"><img src="${sel.photos[0] || sel.snapshot}" alt="">${sel.photos.length > 1 ? `<span class="badge">+${sel.photos.length - 1}</span>` : ''}</div>` : ''}
      <div class="mk-dh"><span class="mk-pin" style="--c:${statusColor(sel)}">${sel.number}</span><div><b>${esc(markupTitle(sel))}</b>
        <span class="muted small">${MARKUP_TYPES[sel.type].label} · ${STATUSES[sel.status].label} · ${esc(sel.author || '')} · ${timeAgo(sel.createdAt)}</span></div>
        ${sel.locked ? `<span class="lock-ic" title="Locked">${icon('lock')}</span>` : ''}</div>
      ${sel.text ? `<p class="mk-text">${esc(sel.text)}</p>` : ''}
      ${sel.element ? `<div class="mk-el">${icon('layers')}<span>${esc(sel.element.ifcType)} · ${esc(sel.element.name || sel.element.guid)}</span></div>` : ''}
      <div class="mk-actions">
        <button class="btn sm" data-mk="edit">${icon('edit')}<span>Open</span></button>
        <button class="btn sm" data-mk="goto">${icon('target')}<span>Go to</span></button>
        <button class="btn sm ${sel.locked ? 'on' : ''}" data-mk="lock">${icon(sel.locked ? 'lock' : 'unlock')}<span>${sel.locked ? 'Locked' : 'Lock'}</span></button>
        <button class="btn sm" data-mk="resolve" ${sel.locked ? 'disabled' : ''}>${icon('resolve')}<span>${sel.status === 'resolved' ? 'Reopen' : 'Resolve'}</span></button>
      </div>
    </div>` : '';
  return `${detail}
    ${groupPills}
    <div class="filters">${filters.map(([k, l]) => `<button class="pill ${app.mkFilter === k ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('')}</div>
    <div class="mk-list">${items.map((m) => `
      <button class="mk-item ${m.id === app.sel ? 'on' : ''}" data-id="${m.id}">
        <span class="mk-pin" style="--c:${statusColor(m)}">${m.number}</span>
        <span class="mk-body"><span class="mk-title">${esc(markupTitle(m))}</span>
        <span class="mk-meta">${MARKUP_TYPES[m.type].label} · ${STATUSES[m.status].label} · ${timeAgo(m.createdAt)}</span></span>
        <span class="mk-icons">${m.photos.length ? icon('image', 'sm') : ''}${m.locked ? icon('lock', 'sm') : ''}</span>
      </button>`).join('') || `<div class="empty-list">${icon('comment')}<p>No markups yet</p><span>Use Capture / Mark, or Markup → Comment / Note / Issue and tap the model</span></div>`}</div>`;
}
function viewsHTML() {
  const V = app.project.views;
  return `<div class="views-head"><button class="btn sm primary" data-v="new">${icon('bookmark')}<span>Save current view</span></button></div>
    <div class="views-grid">${V.map((v) => `
      <div class="view-card" data-id="${v.id}">
        <button class="vc-img" data-v="go">${v.thumb ? `<img src="${v.thumb}" alt="">` : icon('views')}<span class="vc-mode">${v.mode}</span></button>
        <div class="vc-foot"><b title="${esc(v.name)}">${esc(v.name)}</b>
          <button class="icon-btn sm ${v.locked ? 'on' : ''}" data-v="lock" title="${v.locked ? 'Unlock' : 'Lock'}">${icon(v.locked ? 'lock' : 'unlock')}</button>
          <button class="icon-btn sm" data-v="ren" title="Rename" ${v.locked ? 'disabled' : ''}>${icon('edit')}</button>
          <button class="icon-btn sm" data-v="del" title="Delete" ${v.locked ? 'disabled' : ''}>${icon('trash')}</button></div>
      </div>`).join('') || `<div class="empty-list">${icon('views')}<p>No saved views yet</p><span>View → Save View</span></div>`}</div>`;
}
function infoHTML() {
  const P = app.project, a = P.geo.anchor, s = app.elSel;
  const el = s && s.info ? `
    <section><h4>Selected element</h4>
      <div class="kv"><span>Type</span><b>${esc(s.info.ifcType)}</b></div>
      <div class="kv"><span>Name</span><b>${esc(s.info.name || '—')}</b></div>
      ${s.info.objectType ? `<div class="kv"><span>Object type</span><b>${esc(s.info.objectType)}</b></div>` : ''}
      ${s.info.tag ? `<div class="kv"><span>Tag (Revit Id)</span><b class="mono">${esc(s.info.tag)}</b></div>` : ''}
      <div class="kv"><span>IFC GUID</span><b class="mono copy" data-copy="${esc(s.info.guid)}">${esc(s.info.guid)} ${icon('copy', 'sm')}</b></div>
      ${s.info.psets.map((ps) => `<details><summary>${esc(ps.name)}</summary>${ps.props.map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</details>`).join('')}
    </section>` : '';
  return `${el}
    <section><h4>Models</h4>${P.models.map((m) => `
      <div class="model-row ${m.missing ? 'missing' : ''}" data-id="${m.id}">
        <button class="icon-btn sm" data-m="vis" title="Show/hide">${icon(m.visible === false ? 'eyeoff' : 'xray')}</button>
        <div><b>${esc(m.name)}</b><span>${(m.format || '').toUpperCase()}${m.info && m.info.schema ? ` · ${m.info.schema}` : ''}${m.info && m.info.elements ? ` · ${m.info.elements} elements` : ''}${m.missing ? ' · file missing' : ''}</span></div>
        <button class="icon-btn sm" data-m="del" title="Remove">${icon('trash')}</button>
      </div>`).join('') || '<p class="muted small">No models yet</p>'}
      <button class="btn sm" data-m="add">${icon('plus')}<span>Add model</span></button></section>
    ${LOCATION_FEATURES ? `<section><h4>Site location</h4>
      ${a ? `<div class="kv"><span>Anchor (IFC)</span><b class="mono">${fmtM(a.position.x, 2)}, ${fmtM(a.position.y, 2)}, ${fmtM(a.position.z, 2)}</b></div>
        <div class="kv"><span>GPS</span><b class="mono">${fmtLL(a.lat)}, ${fmtLL(a.lon)}</b></div>
        <div class="kv"><span>Project north</span><b class="mono">${a.bearing.toFixed(2)}° from true north</b></div>
        <div class="kv"><span>Method</span><b>${esc(a.method)}${a.accuracy ? ` · ±${a.accuracy.toFixed(1)} m` : ''}</b></div>`
      : '<p class="muted small">No location yet — Site → Set Location (one point)</p>'}
      <button class="btn sm" data-g="anchor">${icon('anchor')}<span>${a ? 'Re-set location' : 'Set location'}</span></button>
    </section>
    <section><h4>QR control points</h4>
      ${P.geo.controlPoints.map((c) => `<div class="model-row" data-cp="${c.id}">
        <span class="cp-ic">${icon('qr')}</span><div><b>${esc(c.name)}</b><span class="mono">${fmtM(c.position.x, 3)}, ${fmtM(c.position.y, 3)}, ${fmtM(c.position.z, 3)}</span></div>
        <button class="icon-btn sm" data-c="show" title="QR">${icon('print')}</button>
        <button class="icon-btn sm" data-c="del" title="Delete">${icon('trash')}</button></div>`).join('') || '<p class="muted small">No QR points yet</p>'}
      <button class="btn sm" data-g="cp">${icon('qr')}<span>Create QR point</span></button>
    </section>` : ''}
    <section><h4>Project</h4>
      <div class="kv"><span>Name</span><b>${esc(P.name)}</b></div>
      <div class="kv"><span>Markups / views</span><b>${P.markups.length} / ${P.views.length}</b></div>
      <div class="kv"><span>Schema</span><b class="mono">${SCHEMA}</b></div>
    </section>`;
}
$('#panel-body').onclick = async (e) => {
  const t = e.target;
  const f = t.closest('[data-filter]'); if (f) { app.mkFilter = f.dataset.filter; refreshMarkers(); return renderPanel(); }
  const gp = t.closest('[data-group]'); if (gp) { app.mkGroup = gp.dataset.group; refreshMarkers(); return renderPanel(); }
  const it = t.closest('.mk-item'); if (it) return selectMarkup(it.dataset.id, true);
  const mk = t.closest('[data-mk]');
  if (mk) {
    const act = mk.dataset.mk;
    if (act === 'edit') return withSel((m) => openMarkupEditor(m, false));
    if (act === 'goto') return withSel((m) => { viewer.focusPoint(viewer.ifcToWorld(m.position), 7); });
    if (act === 'lock') return onCommand('mk-lock');
    if (act === 'resolve') return onCommand('mk-resolve');
  }
  const v = t.closest('[data-v]');
  if (v) {
    const act = v.dataset.v;
    if (act === 'new') return saveView();
    const card = v.closest('.view-card'); const view = app.project.views.find((x) => x.id === card.dataset.id);
    if (act === 'go') { viewer.setViewState(view); syncModeUI(); return; }
    if (act === 'lock') { view.locked = !view.locked; save(); return renderPanel(); }
    if (act === 'ren') { const n = await promptBox('Rename view', 'Name', view.name); if (n) { view.name = n; save(); renderPanel(); } return; }
    if (act === 'del') { if (await confirmBox('Delete view', `Delete view "${view.name}"?`, 'Delete', true)) { app.project.views = app.project.views.filter((x) => x !== view); save(); renderPanel(); } return; }
  }
  const md = t.closest('[data-m]');
  if (md) {
    const act = md.dataset.m;
    if (act === 'add') return $('#file-model').click();
    const id = md.closest('.model-row').dataset.id; const rec = app.project.models.find((x) => x.id === id);
    if (act === 'vis') { rec.visible = rec.visible === false; viewer.setModelVisible(id, rec.visible); save(); return renderPanel(); }
    if (act === 'del') {
      if (!(await confirmBox('Remove model', `Remove "${rec.name}" from the project? Markups are kept.`, 'Remove', true))) return;
      viewer.removeModel(id); app._cols = null; await store.deleteFile(rec.fileId);
      app.project.models = app.project.models.filter((x) => x !== rec); save(); updateEmptyState(); return renderPanel();
    }
  }
  const g = t.closest('[data-g]');
  if (g) return g.dataset.g === 'anchor' ? anchorWizard() : startCPCreate();
  const c = t.closest('[data-c]');
  if (c) {
    const cp = app.project.geo.controlPoints.find((x) => x.id === c.closest('[data-cp]').dataset.cp);
    if (c.dataset.c === 'show') return showCPSheet(cp);
    if (await confirmBox('Delete control point', `Delete point ${cp.name}?`, 'Delete', true)) { app.project.geo.controlPoints = app.project.geo.controlPoints.filter((x) => x !== cp); save(); renderBadges(); renderPanel(); }
  }
  const cp = t.closest('[data-copy]'); if (cp) { navigator.clipboard?.writeText(cp.dataset.copy); toast('Copied GUID', 'ok'); }
};

// ================================================================ section / storeys
function storeys() {
  const all = [];
  for (const m of app.project.models) if (m.info && m.info.storeys) for (const s of m.info.storeys) if (!all.some((x) => Math.abs(x.elevation - s.elevation) < 0.05)) all.push(s);
  return all.sort((a, b) => a.elevation - b.elevation);
}
function updateFloorFromStoreys() {
  const st = storeys();
  const z = st.length ? st[0].elevation : null;
  if (z !== null) viewer.floorY = viewer.ifcToWorld({ x: 0, y: 0, z }).y;
}
function setSection(on) {
  if (on) {
    const st = storeys();
    const z = st.length ? st[0].elevation + 1.2 : viewer.worldToIfc(new THREE.Vector3(0, viewer.floorY + 1.2, 0)).z;
    viewer.setClip(true, viewer.ifcToWorld({ x: 0, y: 0, z }).y);
  } else viewer.setClip(false);
  renderClipCtl(); syncToggles();
}
function renderClipCtl() {
  const el = $('#clip-ctl');
  el.hidden = !viewer.clipOn;
  if (!viewer.clipOn) return;
  const box = viewer.modelBox();
  const minZ = viewer.worldToIfc(new THREE.Vector3(0, box.isEmpty() ? -1 : box.min.y, 0)).z;
  const maxZ = viewer.worldToIfc(new THREE.Vector3(0, box.isEmpty() ? 10 : box.max.y, 0)).z;
  const cur = viewer.worldToIfc(new THREE.Vector3(0, viewer.clipY, 0)).z;
  el.innerHTML = `<div class="clip-head">${icon('section')}<span>Cut</span><b class="mono" id="clip-v">${cur.toFixed(2)} m</b></div>
    <input type="range" id="clip-r" min="${minZ.toFixed(2)}" max="${(maxZ + 0.1).toFixed(2)}" step="0.05" value="${cur.toFixed(2)}" orient="vertical">
    <div class="storeys">${storeys().slice().reverse().map((s) => `<button data-z="${s.elevation}" title="${esc(s.name)}">${esc(s.name.length > 10 ? s.name.slice(0, 10) + '…' : s.name)}</button>`).join('')}</div>`;
  el.querySelector('#clip-r').oninput = (e) => {
    const z = +e.target.value; viewer.setClip(true, viewer.ifcToWorld({ x: 0, y: 0, z }).y);
    el.querySelector('#clip-v').textContent = `${z.toFixed(2)} m`;
  };
  el.querySelector('.storeys').onclick = (e) => {
    const b = e.target.closest('[data-z]'); if (!b) return;
    const z = +b.dataset.z;
    viewer.floorY = viewer.ifcToWorld({ x: 0, y: 0, z }).y;
    viewer.setClip(true, viewer.ifcToWorld({ x: 0, y: 0, z: z + 1.2 }).y);
    renderClipCtl();
    if (viewer.mode === 'walk') viewer.persp.position.y = viewer.floorY + viewer.walk.eye;
  };
}

// ================================================================ GPS / location
function getBearing() {
  const a = app.project && app.project.geo.anchor;
  if (a && Number.isFinite(a.bearing)) return a.bearing;
  const m = app.project && app.project.models.find((x) => x.info && Number.isFinite(x.info.trueNorthBearing));
  return m ? m.info.trueNorthBearing : 0;
}
function getRefs() {
  const P = app.project, out = [];
  for (const c of [...P.geo.controlPoints].reverse()) out.push({ id: `cp:${c.id}`, label: `QR ${c.name}`, raw: ifcToRaw(c.position) });
  if (P.geo.anchor) out.push({ id: 'anchor', label: 'Anchor point', raw: ifcToRaw(P.geo.anchor.position) });
  if (app.loc.raw) out.unshift({ id: 'me', label: app.loc.fix && app.loc.fix.id === 'self' && !gps.active ? 'My position (I\'m Here)' : 'My position', raw: app.loc.raw.clone() });
  if (app.loc.fix) out.sort((a, b) => (a.id === `cp:${app.loc.fix.id}` ? -1 : b.id === `cp:${app.loc.fix.id}` ? 1 : 0));
  if (!out.length) out.push({ id: 'origin', label: 'Model origin', raw: ifcToRaw({ x: 0, y: 0, z: 0 }) });
  return out;
}

async function toggleGPS() {
  if (gps.active) {
    gps.stop();
    const tr = app.project.tracks[app.project.tracks.length - 1]; if (tr && !tr.endedAt) tr.endedAt = new Date().toISOString();
    save();
  } else {
    try { await orient.requestPermission(); orient.start(); } catch (e) { /* compass optional */ }
    gps.start();
    app.project.tracks.push({ id: uuid(), startedAt: new Date().toISOString(), endedAt: null, points: [] });
    if (!app.project.geo.anchor && !app.loc.fix) toast('No location yet — use Site → Set Location or Scan QR first', 'warn', 5000);
  }
  syncToggles(); updateStatus();
}
// Link a self-mark / QR fix to GPS on the first good reading, whatever order the user did things in:
// from then on the position = fix + GPS movement since the fix (walking moves you on the plan / in AR).
function linkFixToGps() {
  const f = app.loc.fix, g = gps.last, P = app.project;
  if (!f || f.linked || settings.trackMode === 'steps' || !g || !gps.active || !(g.acc <= GOOD_GPS_M)) return;
  if (Date.now() - f.t > 3 * 60 * 1000) return; // fix too old: user has probably walked away from it
  if (P.geo.anchor) {
    const pg = gpsToModel(P.geo.anchor, g.lat, g.lon);
    app.loc.corr = { x: f.position.x - pg.x, y: f.position.y - pg.y };
  } else {
    P.geo.anchor = { position: { ...f.position }, lat: g.lat, lon: g.lon, alt: g.alt, bearing: getBearing(), method: 'self', accuracy: g.acc, createdAt: new Date().toISOString() };
    app.loc.corr = { x: 0, y: 0 };
    renderBadges(); save();
  }
  f.linked = true; f.t = g.t;
  toast('GPS linked to your I\'m Here point — your position now follows as you walk', 'ok', 3500);
}
// Hybrid tracking: steps move you smoothly; each good GPS reading gently pulls the position back toward GPS,
// so step drift can never grow without limit (and GPS jitter is averaged out instead of shown directly).
function fuseGps() {
  if (settings.trackMode !== 'hybrid' || !app.loc.stepMode || app.loc.tripod) return;
  const a = app.project.geo.anchor, g = gps.last, f = app.loc.fix;
  if (!a || !g || !f || !f.linked || !gps.active || !(g.acc <= 12) || Date.now() - g.t > 5000) return;
  if (g.t === f.lastFuse) return; f.lastFuse = g.t;
  const pg = gpsToModel(a, g.lat, g.lon);
  const ex = pg.x + app.loc.corr.x - f.position.x, ey = pg.y + app.loc.corr.y - f.position.y;
  if (Math.hypot(ex, ey) > Math.max(30, 4 * g.acc)) return; // wild reading: ignore
  const k = g.acc <= 5 ? 0.08 : g.acc <= 8 ? 0.05 : 0.025;
  f.position = { ...f.position, x: f.position.x + ex * k, y: f.position.y + ey * k };
}
gps.addEventListener('update', () => {
  linkFixToGps();
  fuseGps();
  computeLoc();
  recordTrack();
  updateStatus();
  if (gps.error && !gps._errShown) { gps._errShown = true; toast(`GPS: ${gps.error}`, 'error', 5000); }
});

const GOOD_GPS_M = 20;
function computeLoc() {
  const a = app.project && app.project.geo.anchor, g = gps.last;
  let ifc = null, acc = null;
  // GPS only wins when it is genuinely good (phones outdoors ≈ 3–15 m). PC/Wi-Fi/IP locations
  // (hundreds of metres) must never override a self-mark or QR fix.
  const gpsGood = g && gps.active && Number.isFinite(g.acc) && g.acc <= GOOD_GPS_M && Date.now() - g.t < 15000;
  if (a && gpsGood && !app.loc.stepMode && (!app.loc.fix || g.t > app.loc.fix.t)) { // step tracking has priority over GPS
    const p = gpsToModel(a, g.lat, g.lon);
    ifc = { x: p.x + app.loc.corr.x, y: p.y + app.loc.corr.y, z: app.loc.fixZ ?? a.position.z };
    // GPS-only mode: smooth the jitter (blend 35 % toward each new reading)
    const prev = app.loc._gpsSm;
    if (prev && g.t - prev.t < 5000) { ifc.x = prev.x + (ifc.x - prev.x) * 0.35; ifc.y = prev.y + (ifc.y - prev.y) * 0.35; }
    app.loc._gpsSm = { x: ifc.x, y: ifc.y, t: g.t };
    acc = g.acc;
  } else if (app.loc.fix) { ifc = { ...app.loc.fix.position }; acc = 0.05; }
  app.loc.ifc = ifc; app.loc.acc = acc; app.loc.raw = ifc ? ifcToRaw(ifc) : null;
  const hd = orient.ready && orient.hasTrueNorth ? orient.getHeading() : (g && Number.isFinite(g.heading) ? g.heading : null);
  app.loc.heading = hd;
  const hmWM = app.wm ? headingModelNow() : null; // Walk&Mark: arrow = phone heading, or the last heading you set
  viewer.setYou(app.loc.raw, acc, hmWM != null ? hmWM : hd == null ? null : hd - getBearing());
}
function recordTrack() {
  const tr = app.project.tracks[app.project.tracks.length - 1];
  if (!tr || tr.endedAt || !app.loc.ifc || !gps.last) return;
  const last = tr.points[tr.points.length - 1];
  const p = app.loc.ifc;
  if (last && Math.hypot(last.position.x - p.x, last.position.y - p.y) < 1 && Date.now() - last.t < 15000) return;
  tr.points.push({ t: Date.now(), lat: gps.last.lat, lon: gps.last.lon, acc: gps.last.acc, position: { ...p } });
  renderTrack();
  if (tr.points.length % 5 === 0) save();
}
function renderTrack() {
  const P = app.project;
  if (!LOCATION_FEATURES) { // GPS path shelved: draw the ACTIVE GROUP as a line through its captures / marks, in order ("connected")
    const g = activeGroup();
    const pts = g ? P.markups.filter((m) => m.group === g.id).sort((a, b) => a.number - b.number).map((m) => ifcToRaw(m.position)) : [];
    viewer.setTrack(pts, settings.showMarkups);
    return;
  }
  const tr = [...P.tracks].reverse().find((t) => t.points.length > 1);
  viewer.setTrack(tr ? tr.points.map((p) => ifcToRaw(p.position)) : [], settings.showTrack);
}
function renderBadges() {
  const P = app.project, items = [];
  if (P.geo.anchor) items.push({ raw: ifcToRaw(P.geo.anchor.position), label: 'A', color: '#60a5fa', kind: 'anchor' });
  for (const c of P.geo.controlPoints) items.push({ raw: ifcToRaw(c.position), label: 'QR', color: '#7aa7e8', kind: 'cp', id: c.id });
  if (P.geo.face) items.push({ raw: ifcToRaw(P.geo.face), label: 'F', color: '#9cc2f5', kind: 'face' });
  viewer.setBadges(items);
}

function suggestSiteAnchor(info) {
  const s = info.site;
  modal({ title: 'Location found in the IFC file', body: `<p>The IFC file contains a site location: <b class="mono">${fmtLL(s.lat)}, ${fmtLL(s.lon)}</b>${Number.isFinite(info.trueNorthBearing) ? ` and True North <b class="mono">${info.trueNorthBearing.toFixed(2)}°</b>` : ''}.</p>
    <p class="muted">It can be used as the starting location (model origin 0,0,0). Accuracy depends on the Survey Point / Project Base Point setup in Revit — for precision use Set Location or Scan QR on site.</p>`,
  actions: [{ label: 'Later', onClick: (c) => c() }, { label: 'Use IFC location', kind: 'primary', icon: 'anchor', onClick: (c) => {
    app.project.geo.anchor = { position: { x: 0, y: 0, z: s.elevation ? 0 : 0 }, lat: s.lat, lon: s.lon, alt: s.elevation, bearing: info.trueNorthBearing ?? 0, method: 'ifc-site', accuracy: null, createdAt: new Date().toISOString() };
    app.loc.corr = { x: 0, y: 0 }; save(); renderBadges(); computeLoc(); renderPanel(); c(); toast('Location set from IFC site', 'ok');
  } }] });
}

// ---------------- anchor wizard (ONE point)
function anchorWizard() {
  if (!viewer.models.children.length) return toast('Open a model first', 'warn');
  const site = app.project.models.map((m) => m.info && m.info.site).find(Boolean);
  modal({ title: 'Set Location · one point', wide: false, body: `
    <ol class="steps">
      <li><b>Stand on a point you can identify on the drawings</b><span>e.g. a column corner, grid intersection, wall corner or a surveyed point</span></li>
      <li><b>Tap the same point on the model / plan</b><span>Plan view is the most precise</span></li>
      <li><b>Capture GPS</b><span>Readings are averaged over several seconds · refine the heading with “2nd Point” or a QR scan</span></li>
    </ol>`,
  actions: [
    ...(site ? [{ label: 'Use IFC site', icon: 'sample', left: true, onClick: (c) => { c(); suggestSiteAnchor(app.project.models.find((m) => m.info && m.info.site).info); } }] : []),
    { label: 'Cancel', onClick: (c) => c() },
    { label: 'Tap point on model', icon: 'target', kind: 'primary', onClick: (c) => {
      c(); goPlanForPicking();
      setTool('anchor'); hint('Tap where you are standing on the model / plan', cancelTool);
    } }] });
}
function anchorStep2(ifc) {
  const old = app.project.geo.anchor;
  const bearing0 = getBearing();
  const body = h(`<div>
    <div class="kv"><span>Model point (IFC)</span><b class="mono">${fmtM(ifc.x)}, ${fmtM(ifc.y)}, ${fmtM(ifc.z)}</b></div>
    <div class="gps-box"><div class="gps-read" id="aw-read">${icon('gps')}<span>No GPS fix yet</span></div>
      <button class="btn primary" id="aw-cap">${icon('gps')}<span>Capture GPS (${settings.gpsAvg}s)</span></button></div>
    <div class="field-row">
      <label class="field"><span>Latitude</span><input id="aw-lat" inputmode="decimal" value="${old ? old.lat.toFixed(8) : ''}" placeholder="13.7563"></label>
      <label class="field"><span>Longitude</span><input id="aw-lon" inputmode="decimal" value="${old ? old.lon.toFixed(8) : ''}" placeholder="100.5018"></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Project north (° from true north)</span><input id="aw-bear" inputmode="decimal" value="${bearing0.toFixed(2)}"></label>
      <button class="btn" id="aw-compass" style="align-self:end">${icon('compass')}<span>From compass</span></button>
    </div>
    <p class="muted small">From compass: point the top of the device along the model +Y axis (project north / vertical grid lines on the plan) and press · on a PC you can type lat/lon (e.g. from Google Maps)</p>
  </div>`);
  let acc = null;
  body.querySelector('#aw-cap').onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true;
    const read = body.querySelector('#aw-read span');
    try {
      const r = await gps.average(settings.gpsAvg, (n, l) => { read.textContent = `Averaging… ${n} readings · ±${l.acc.toFixed(1)} m`; });
      body.querySelector('#aw-lat').value = r.lat.toFixed(8); body.querySelector('#aw-lon').value = r.lon.toFixed(8);
      acc = r.acc; read.textContent = `${r.n} samples · best ±${r.acc.toFixed(1)} m`;
    } catch (err) { read.textContent = err.message; toast(err.message, 'error'); }
    b.disabled = false;
  };
  body.querySelector('#aw-compass').onclick = async () => {
    try { await orient.requestPermission(); orient.start(); } catch (e) { return toast(e.message, 'error'); }
    setTimeout(() => {
      if (!orient.ready || !orient.hasTrueNorth) return toast('This device has no compass', 'warn');
      body.querySelector('#aw-bear').value = orient.getHeading().toFixed(1);
    }, 400);
  };
  modal({ title: 'Set Location · Step 2', body, actions: [
    { label: 'Cancel', onClick: (c) => c() },
    { label: 'Save location', icon: 'check', kind: 'primary', onClick: (c) => {
      const lat = parseFloat(body.querySelector('#aw-lat').value), lon = parseFloat(body.querySelector('#aw-lon').value);
      const bearing = normDeg(parseFloat(body.querySelector('#aw-bear').value) || 0);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return toast('Latitude and longitude are required', 'warn');
      app.project.geo.anchor = { position: ifc, lat, lon, alt: null, bearing, method: acc != null ? 'gps' : 'manual', accuracy: acc, createdAt: new Date().toISOString() };
      app.loc.corr = { x: 0, y: 0 }; app.loc.fixZ = ifc.z;
      save(); renderBadges(); computeLoc(); renderPanel(); c();
      toast('Location saved — turn on Locate Me to see your position on the plan', 'ok', 4000);
    } }] });
}

// ---------------- 2-point heading refinement
function twoPointWizard() {
  if (!app.project.geo.anchor) return toast('Set Location first', 'warn');
  modal({ title: 'Refine heading · second point', body: `<p>Walk to another identifiable point <b>at least 15–30 m</b> from the first one and tap it on the model. Project north is computed from the two GPS points (more accurate than the phone compass).</p>`,
    actions: [{ label: 'Cancel', onClick: (c) => c() }, { label: 'Tap 2nd point', icon: 'target', kind: 'primary', onClick: (c) => { c(); setTool('second'); hint('Tap the second point where you are standing', cancelTool); } }] });
}
function twoPointStep2(ifc) {
  const a = app.project.geo.anchor;
  const body = h(`<div><div class="gps-box"><div class="gps-read" id="tp-read">${icon('gps')}<span>Stand still on the second point and press Capture</span></div>
    <button class="btn primary" id="tp-cap">${icon('gps')}<span>Capture GPS (${settings.gpsAvg}s)</span></button></div><div id="tp-res"></div></div>`);
  let newB = null;
  body.querySelector('#tp-cap').onclick = async (e) => {
    e.currentTarget.disabled = true;
    const read = body.querySelector('#tp-read span');
    try {
      const r = await gps.average(settings.gpsAvg, (n, l) => { read.textContent = `Averaging… ${n} · ±${l.acc.toFixed(1)} m`; });
      const dM = { x: ifc.x - a.position.x, y: ifc.y - a.position.y };
      const dEN = gpsToEN(r.lat, r.lon, a.lat, a.lon);
      const dist = Math.hypot(dM.x, dM.y), gdist = Math.hypot(dEN.e, dEN.n);
      newB = bearingFromPair(dM, dEN);
      read.textContent = `±${r.acc.toFixed(1)} m`;
      body.querySelector('#tp-res').innerHTML = `<div class="kv"><span>Distance model / GPS</span><b class="mono">${dist.toFixed(1)} m / ${gdist.toFixed(1)} m</b></div>
        <div class="kv"><span>Heading old → new</span><b class="mono">${a.bearing.toFixed(2)}° → ${newB.toFixed(2)}°</b></div>
        ${dist < 10 ? '<p class="warn-text">Less than 10 m apart — the result may be inaccurate</p>' : ''}`;
    } catch (err) { read.textContent = err.message; }
    e.currentTarget.disabled = false;
  };
  modal({ title: 'Refine heading · Step 2', body, actions: [{ label: 'Cancel', onClick: (c) => c() }, { label: 'Apply', kind: 'primary', icon: 'check', onClick: (c) => {
    if (newB == null) return toast('Capture GPS first', 'warn');
    a.bearing = newB; a.method += '+2pt'; save(); computeLoc(); renderPanel(); c(); toast(`Project north = ${newB.toFixed(2)}°`, 'ok');
  } }] });
}

// ---------------- compass
async function compassDialog() {
  try { await orient.requestPermission(); orient.start(); } catch (e) { return toast(e.message, 'error'); }
  const body = h(`<div class="compass-dlg"><div class="cdial"><div class="cneedle" id="cd-n"></div><b id="cd-v">—</b></div>
    <p class="muted small" id="cd-s"></p><p class="muted small">If readings drift, move the device in a figure 8 to calibrate and keep away from steel and vehicles</p></div>`);
  const upd = () => {
    const hd = orient.getHeading();
    body.querySelector('#cd-v').textContent = hd == null ? '—' : `${hd.toFixed(0)}°`;
    body.querySelector('#cd-n').style.transform = `rotate(${-(hd || 0)}deg)`;
    body.querySelector('#cd-s').textContent = !orient.ready ? 'No orientation sensor' : orient.hasTrueNorth ? 'Absolute compass ✓' : 'Relative only (no compass) — use heading trim / 2nd point';
  };
  orient.addEventListener('update', upd); upd();
  modal({ title: 'Compass', body, onClose: () => orient.removeEventListener('update', upd), actions: [{ label: 'Recalibrate', onClick: () => orient.recalibrate() }, { label: 'Close', kind: 'primary', onClick: (c) => c() }] });
}

// ---------------- QR control points
function startCPCreate() {
  if (!viewer.models.children.length) return toast('Open a model first', 'warn');
  goPlanForPicking();
  setTool('cp'); hint('Tap where the surveyor should set out the QR (fine-tune the coordinates next)', cancelTool);
}
function cpDialog(ifc) {
  const n = app.project.geo.controlPoints.length + 1;
  const body = h(`<div>
    <label class="field"><span>Name</span><input id="cp-n" value="CP-${String(n).padStart(2, '0')}"></label>
    <div class="field-row">
      <label class="field"><span>X (m)</span><input id="cp-x" inputmode="decimal" value="${ifc.x.toFixed(3)}"></label>
      <label class="field"><span>Y (m)</span><input id="cp-y" inputmode="decimal" value="${ifc.y.toFixed(3)}"></label>
      <label class="field"><span>Z (m)</span><input id="cp-z" inputmode="decimal" value="${ifc.z.toFixed(3)}"></label>
    </div>
    <p class="muted small">Same coordinate system as the IFC export from Revit · round to what the surveyor will set out · X/Y/Z = <b>centre of the QR</b></p>
    <div class="field-row">
      <label class="field"><span>Mounting</span><select id="cp-m"><option value="floor">On the floor</option><option value="wall">On a wall (upright)</option></select></label>
      <label class="field"><span>Direction (°) 0=+Y · 90=+X</span><input id="cp-h" inputmode="decimal" value="0"></label>
      <label class="field"><span>Printed QR size (cm)</span><input id="cp-s" inputmode="decimal" value="${Math.round(settings.qrSize * 100)}"></label>
    </div>
    <p class="muted small">Lets the app compute the <b>camera position + heading</b> from the QR image: floor → where the top of the QR points · wall → where the QR faces · 20 cm QR recommended, view from ≤ ~2 m · print at 100% and enter the measured size (a wrong size scales the distance)</p></div>`);
  modal({ title: 'Create QR control point', body, actions: [{ label: 'Cancel', onClick: (c) => c() }, { label: 'Create QR', icon: 'qr', kind: 'primary', onClick: (c) => {
    const p = { x: parseFloat(body.querySelector('#cp-x').value), y: parseFloat(body.querySelector('#cp-y').value), z: parseFloat(body.querySelector('#cp-z').value) };
    if (![p.x, p.y, p.z].every(Number.isFinite)) return toast('Invalid coordinates', 'warn');
    const size = Math.min(0.19, Math.max(0.05, (parseFloat(body.querySelector('#cp-s').value) || 15) / 100)); // A4 sheet limits the symbol to 19 cm
    const cp = { id: uuid(), name: body.querySelector('#cp-n').value.trim() || `CP-${n}`, position: p, createdAt: new Date().toISOString(),
      mount: body.querySelector('#cp-m').value, heading: normDeg(parseFloat(body.querySelector('#cp-h').value) || 0), size };
    if (app.project.geo.anchor) { const g = modelToGps(app.project.geo.anchor, p); cp.lat = g.lat; cp.lon = g.lon; }
    app.project.geo.controlPoints.push(cp); save(); renderBadges(); renderPanel(); c(); showCPSheet(cp);
  } }] });
}
async function showCPSheet(cp) {
  if (!cp) return;
  const url = await cpSheet(cp, app.project.name, encodeCP(cp, app.project.id));
  const body = h(`<div class="qr-sheet"><img src="${url}" alt="QR ${esc(cp.name)}"></div>`);
  modal({ title: `QR · ${cp.name}`, body, actions: [
    // A4 at 100 %: the sheet is drawn at real scale, so the QR prints at exactly cp.size (check the 10 cm ruler on the sheet)
    { label: 'Print A4', icon: 'print', left: true, onClick: () => { const w = window.open(''); if (w) { w.document.write(`<title>${esc(cp.name)}</title><style>@page{size:A4;margin:0}html,body{margin:0}img{display:block;width:210mm;height:297mm}</style><img src="${url}" onload="print()">`); w.document.close(); } } },
    { label: 'Download PNG', icon: 'import', kind: 'primary', onClick: () => download(url, `${slug(app.project.name)}_${slug(cp.name)}.png`) }] });
}
async function scanQR() {
  const body = h(`<div class="scan"><video playsinline muted></video><div class="scan-frame"></div>
    <p class="muted small" id="sq-msg">Point the camera at a QR control point — or use the buttons below</p>
    <div class="scan-alt">
      <button class="btn sm" id="sq-img">${icon('image')}<span>Choose QR image</span></button>
      <button class="btn sm" id="sq-list">${icon('qr')}<span>Pick from list</span></button>
    </div>
    <input type="file" id="sq-file" accept="image/*" hidden></div>`);
  let stop = null;
  const md = modal({ title: 'Scan QR', body, cls: 'scan-modal', onClose: () => stop && stop() });
  const done = (cp) => { if (stop) { stop(); stop = null; } md.close(); applyCPFix(cp); };
  const noCamera = (why) => { // camera unavailable → keep the dialog, offer the other two ways
    body.querySelector('video').hidden = true; body.querySelector('.scan-frame').hidden = true;
    body.querySelector('#sq-msg').textContent = `Camera unavailable (${why}) — choose a QR image or pick a point from the list`;
  };
  // 1) pick an image of the QR (gallery / file / screenshot)
  body.querySelector('#sq-img').onclick = () => body.querySelector('#sq-file').click();
  body.querySelector('#sq-file').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    body.querySelector('#sq-msg').textContent = 'Reading the QR image…';
    try {
      const text = await decodeImageFile(f);
      const cp = text && decodeCP(text);
      if (cp) return done(cp);
      body.querySelector('#sq-msg').textContent = text ? 'This QR is not a SiteAR control point' : 'No QR found — use a sharp image with the whole QR visible';
    } catch (err) { body.querySelector('#sq-msg').textContent = 'Cannot open the image'; }
  };
  // 2) choose a control point from the project list (no QR needed)
  body.querySelector('#sq-list').onclick = () => {
    const list = app.project.geo.controlPoints;
    if (!list.length) return toast('No QR points in this project — create one with Site → Create QR', 'warn', 4000);
    if (stop) { stop(); stop = null; }
    md.close();
    const pb = h(`<div class="proj-list">${list.map((c) => `<div class="proj-item" data-id="${c.id}"><div class="proj-icon">${icon('qr')}</div>
      <div class="proj-main"><b>${esc(c.name)}</b><span class="mono">${fmtM(c.position.x, 2)}, ${fmtM(c.position.y, 2)}, ${fmtM(c.position.z, 2)}</span></div></div>`).join('')}</div>`);
    const pm = modal({ title: 'Where are you?', body: pb });
    pb.onclick = (e) => {
      const it = e.target.closest('.proj-item'); if (!it) return;
      const c = list.find((x) => x.id === it.dataset.id); pm.close();
      applyCPFix({ id: c.id, name: c.name, position: c.position, projectId: app.project.id });
    };
  };
  try {
    stop = await startScan(body.querySelector('video'), (text) => { const cp = decodeCP(text); if (cp) done(cp); });
  } catch (e) { noCamera(e.name === 'NotAllowedError' ? 'camera permission denied' : e.message); }
}
// ---------------- self-marking: "I'm here" — tap where you stand (e.g. beside a column). No survey needed.
function startSelfMark() {
  if (!viewer.models.children.length) return toast('Open a model first', 'warn');
  goPlanForPicking();
  setTool('self');
  hint("Tap where you stand on the plan — a column snaps to its centre", cancelTool);
}
// cached world boxes of every IFC column: [{modelId, eid, box}]
function columnBoxes() {
  if (app._cols) return app._cols;
  app._cols = [];
  for (const m of viewer.models.children) {
    for (const eid of ifcColumnIds(m)) {
      const box = viewer.elementBox(m.userData.modelId, eid);
      if (!box.isEmpty()) app._cols.push({ modelId: m.userData.modelId, eid, box });
    }
  }
  return app._cols;
}
async function selfMarkAt(hit, ifc) {
  let pos = { ...ifc }, label = 'tapped point';
  // snap to the nearest column (within 0.75 m on plan) whose height spans the tapped level
  const w = hit.point, SNAP = 0.75;
  let best = null, bestD = SNAP;
  for (const c of columnBoxes()) {
    if (w.y < c.box.min.y - 0.6 || w.y > c.box.max.y + 0.1) continue;
    const dx = Math.max(c.box.min.x - w.x, 0, w.x - c.box.max.x), dz = Math.max(c.box.min.z - w.z, 0, w.z - c.box.max.z);
    const d = Math.hypot(dx, dz);
    if (d < bestD) { bestD = d; best = c; }
  }
  if (best) {
    const b = best.box;
    pos = viewer.worldToIfc(new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2));
    const info = await getIfcElementInfo(viewer.getModel(best.modelId), best.eid).catch(() => null);
    label = `column ${info ? (info.tag || info.name) : ''}`.trim();
    viewer.highlightElement(best.modelId, best.eid);
    setTimeout(() => viewer.clearHighlight(), 1500);
  } else if (viewer.clipOn) {
    // tapped the floor in a cut plan: keep the floor height
    pos.z = Math.min(pos.z, viewer.worldToIfc(new THREE.Vector3(0, viewer.clipY, 0)).z);
  }
  // record in the walked path (self-marks have no GPS)
  const P = app.project;
  let tr = P.tracks[P.tracks.length - 1];
  if (!tr || tr.endedAt) { tr = { id: uuid(), startedAt: new Date().toISOString(), endedAt: null, points: [] }; P.tracks.push(tr); }
  tr.points.push({ t: Date.now(), lat: null, lon: null, acc: null, position: { ...pos }, self: true });
  applyFix({ id: 'self', name: label, position: pos }, 'self');
  renderTrack();
}

// ================================================================ Walk & Mark — the simple mode
// Plan view. 1) tap where you stand  2) tap the point you are facing  3) walk (steps move the dot) and press Mark.
// The marker goes exactly where the dot is (optionally 1–3 m ahead). No camera overlay, no compass dependence:
// the heading comes from tap #2, then the phone's gyro keeps it (or the ⟲ ⟳ buttons / the ▲ walk button).
function headingModelNow() { // model heading (deg clockwise from +Y): phone if available, else the last set value
  const d = deviceModelHeading();
  if (d != null) return d;
  return app.wm ? app.wm.heading : null;
}
async function startWalkMark() {
  if (!viewer.models.children.length) return toast('Open a model first', 'warn');
  if (ar.active) ar.stop();
  try { await orient.requestPermission(); orient.start(); } // inside the button tap: iOS needs the gesture
  catch (e) { toast('Sensor permission denied — use the ⟲ ⟳ buttons to turn', 'warn', 4500); }
  app.wm = { state: 'pos', heading: (app.wm && app.wm.heading) || 0, ahead: 0,
    prev: { mode: viewer.mode, clip: viewer.clipOn, panel: document.body.classList.contains('panel-open') } };
  document.body.classList.add('wm'); document.body.classList.remove('panel-open');
  viewer.headingTrim = 0; viewer.setNavLocked(false);
  setMode('plan'); if (!viewer.clipOn) setSection(true);
  $('#wm').hidden = false;
  $$('#wm-ahead [data-d]').forEach((b) => b.classList.toggle('on', b.dataset.d === '0'));
  setTimeout(() => { viewer.resize(); viewer.ortho.zoom = Math.max(viewer.ortho.zoom, 2.6); viewer.ortho.updateProjectionMatrix(); }, 320);
  wmState(app.loc.fix ? 'face' : 'pos');
  syncModeUI();
}
function wmState(s) {
  const wm = app.wm; if (!wm) return;
  wm.state = s;
  const msg = $('#wm-msg');
  if (s === 'pos') { setTool('wmpos'); msg.innerHTML = '<b>1/2</b> Tap where you are <b>standing</b> on the plan (a column snaps to its centre)'; }
  else if (s === 'face') { setTool('wmface'); msg.innerHTML = '<b>2/2</b> Hold the phone the way you face, then tap the point you are <b>looking at</b> (e.g. the next column)'; }
  else { setTool('select'); msg.innerHTML = 'Walk — the blue dot follows your steps (hold <b>▲ Step</b> if one is missed) · press <b>Mark here</b> to drop a pin · at a column press <b>Reset position</b>'; }
  $('#wm-mark').disabled = s !== 'walk';
  syncModeUI();
}
async function wmSetFacing(ifc) {
  const f = app.loc.fix;
  if (!f) return wmState('pos');
  const dx = ifc.x - f.position.x, dy = ifc.y - f.position.y;
  if (Math.hypot(dx, dy) < 0.5) { toast('Too close — tap a point at least 1 m ahead', 'warn'); return wmState('face'); }
  const hm = normDeg((Math.atan2(dx, dy) * 180) / Math.PI);
  app.wm.heading = hm; viewer.headingTrim = 0;
  if (orient.ready) orient.setHeadingNow(normDeg(hm + getBearing())); // phone heading := this direction (compass not needed)
  await toggleSteps(true);
  wmState('walk');
  computeLoc();
}
function nudgeHeading(d) { // d>0 = clockwise
  if (orient.ready) { orient.yawOffset = (orient.yawOffset || 0) + d; orient.manual = true; }
  else if (app.wm) app.wm.heading = normDeg(app.wm.heading + d);
  computeLoc();
}
async function wmMark() {
  const f = app.loc.fix;
  if (!f || !app.wm) return toast('Set your position first', 'warn');
  const pos = { ...f.position }, d = app.wm.ahead, h = headingModelNow();
  if (d > 0 && h != null) { const r = (h * Math.PI) / 180; pos.x += Math.sin(r) * d; pos.y += Math.cos(r) * d; }
  await createMarkupAt({ type: 'plane' }, pos, { type: 'comment', source: 'walkmark' });
}
function wmExit() {
  const wm = app.wm; if (!wm) return;
  app.wm = null; document.body.classList.remove('wm'); $('#wm').hidden = true;
  setTool('select'); restorePickMode();
  if (wm.prev.mode !== 'plan') setMode(wm.prev.mode);
  if (!wm.prev.clip && viewer.clipOn) setSection(false);
  if (wm.prev.panel && window.innerWidth >= 900) document.body.classList.add('panel-open');
  setTimeout(() => viewer.resize(), 300);
  syncModeUI();
}
$('#wm-exit').onclick = wmExit;
$('#wm-reset').onclick = () => wmState('pos');
$('#wm-mark').onclick = wmMark;
$('#wm-rotl').onclick = () => nudgeHeading(-10);
$('#wm-rotr').onclick = () => nudgeHeading(10);
$('#wm-ahead').onclick = (e) => {
  const b = e.target.closest('[data-d]'); if (!b || !app.wm) return;
  app.wm.ahead = +b.dataset.d;
  $$('#wm-ahead [data-d]').forEach((x) => x.classList.toggle('on', x === b));
};

// ---------------- Face Point: "I'm looking at THIS point of the plan" → locks the view direction without a compass
function startFacePoint() {
  if (!viewer.models.children.length) return toast('Open a model first', 'warn');
  goPlanForPicking();
  setTool('face');
  hint('Tap the point you are facing (e.g. the next column) — in AR press Face when the camera points at it', cancelTool);
}
function facePointAt(ifc) {
  app.project.geo.face = { x: ifc.x, y: ifc.y, z: ifc.z };
  save(); renderBadges(); syncToggles();
  toast('Face Point set — in AR, point the camera at it and press Face', 'ok', 5000);
}
// heading (deg clockwise from model +Y) from where the user stands to the Face Point
function getFaceHeading() {
  const f = app.project.geo.face, me = app.loc.ifc || (app.loc.fix && app.loc.fix.position);
  if (!f || !me) return null;
  const dx = f.x - me.x, dy = f.y - me.y;
  if (Math.hypot(dx, dy) < 0.3) return null;
  return normDeg((Math.atan2(dx, dy) * 180) / Math.PI);
}

// ---------------- Step tracking (dead reckoning): every real step moves "you" along the direction the phone faces
function deviceModelHeading() { // heading of the phone relative to model +Y, deg clockwise
  if (!orient.ready) return null;
  const q = orient.getQuaternion();
  q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(getBearing() + (viewer.headingTrim || 0))));
  let f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  if (Math.abs(f.y) > 0.85) f = new THREE.Vector3(0, 1, 0).applyQuaternion(q); // pointing at floor/sky: use the device top
  return modelHeadingOfRawDir(f);
}
async function toggleSteps(force) {
  if (steps.active && force !== true) {
    steps.stop(); app.loc.stepMode = false; syncModeUI(); updateStatus();
    toast('Step tracking off', 'info'); return false;
  }
  if (steps.active) return true;
  if (app.loc.tripod) { toast('Tripod mode holds the position — release the tripod to count steps', 'info'); return false; }
  // no I'm-Here yet but we know where GPS puts us: start from that
  if (!app.loc.fix && app.loc.ifc) app.loc.fix = { id: 'gps', position: { ...app.loc.ifc }, t: Date.now(), linked: true };
  if (!app.loc.fix) { toast('Set where you stand first: Site → I\'m Here (or Scan QR)', 'warn', 4500); return false; }
  try { await orient.requestPermission(); orient.start(); await steps.requestPermission(); }
  catch (e) { toast(e.message, 'error'); return false; }
  if (!steps.supported) { toast('This device has no motion sensor', 'warn'); return false; }
  steps.start(); app.loc.stepMode = true;
  syncModeUI(); updateStatus();
  toast(`Step tracking on — your position follows your steps (${settings.stepLen} m per step)`, 'ok', 3500);
  return true;
}
// one step forward along the phone's facing direction (called by the step counter AND by the manual ▲ button)
function doStep(auto = true) {
  if (app.loc.tripod) { if (!auto) toast('Tripod mode holds the position — press Tripod to release', 'info'); return; }
  const f = app.loc.fix;
  if (!f) { toast('Set where you stand first: Site → I\'m Here', 'warn'); return; }
  const h = headingModelNow();
  if (h == null) { if (!auto) toast('No heading from the device yet — move it slightly or allow Motion access', 'warn'); return; }
  const r = THREE.MathUtils.degToRad(h), L = settings.stepLen;
  const pos = { x: f.position.x + Math.sin(r) * L, y: f.position.y + Math.cos(r) * L, z: f.position.z };
  app.loc.fix = { ...f, position: pos, t: Date.now() };
  app.loc.stepMode = true;
  app.project.geo.here = { id: f.id, name: 'steps', method: 'steps', position: { ...pos }, t: Date.now() };
  app._stepN = (app._stepN || 0) + 1;
  computeLoc(); updateStatus();
  if (app._stepN % 10 === 0) save();
}
steps.addEventListener('step', () => doStep(true));
steps.threshold = settings.stepSens;
// floating ▲ button (Walk Track): tap = 1 step, hold = keep walking
(() => {
  const b = $('#step-btn'); let tm = null;
  const stop = () => { clearInterval(tm); tm = null; };
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); doStep(false); tm = setInterval(() => doStep(false), 450); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, stop));
})();

// ---------------- Tripod: the most accurate setup for AR on the web.
// Position is LOCKED (no steps, no GPS) at a known point and the camera height is FIXED, so the only unknown
// left is the heading — set it once with drag / Face / QR, then just pan and tilt the phone on the tripod.
async function toggleTripod() {
  if (app.loc.tripod) { app.loc.tripod = false; toast('Tripod released — normal tracking resumed', 'info'); updateStatus(); return false; }
  if (!app.loc.fix && app.loc.ifc) app.loc.fix = { id: 'tripod', position: { ...app.loc.ifc }, t: Date.now() };
  if (!app.loc.fix) { toast('Set the tripod position first: Site → I\'m Here or the QR button in AR', 'warn', 5000); return false; }
  const v = await promptBox('Camera height on the tripod (m)', 'Floor to phone camera — keep it the same every setup', String(settings.eye));
  if (v === null) return false;
  const h = parseFloat(v);
  if (!Number.isFinite(h) || h < 0.3 || h > 3) { toast('Invalid height (0.3–3 m)', 'warn'); return false; }
  settings.eye = h; viewer.walk.eye = h; saveSettings();
  steps.stop(); app.loc.stepMode = true; app.loc.tripod = true;
  computeLoc(); updateStatus(); syncToggles();
  toast(`Tripod locked · ${h.toFixed(2)} m high · position fixed — drag or press Face / QR once to align the heading`, 'ok', 6000);
  return true;
}

// ---------------- tracking mode: Hybrid (steps + GPS pull-back) · Steps only · GPS only
const TRACK_LABEL = { hybrid: 'Hybrid', steps: 'Steps', gps: 'GPS' };
const TRACK_HELP = {
  hybrid: 'Hybrid: steps move you smoothly, GPS slowly pulls back drift',
  steps: 'Steps: step counting only (no GPS) — works indoors but drifts; press I\'m Here at a column to reset',
  gps: 'GPS: GPS only — best outdoors (±3–10 m); needs Set Location / I\'m Here first'
};
async function setTrackMode(m, quiet) {
  settings.trackMode = m; saveSettings();
  if (m === 'gps') {
    steps.stop(); app.loc.stepMode = false;
    try { await orient.requestPermission(); orient.start(); } catch (e) { /* compass optional */ }
    if (!gps.active) await toggleGPS();
  } else {
    const ok = await toggleSteps(true);
    if (!ok) { if (m === 'hybrid' && !gps.active && app.project.geo.anchor) await toggleGPS(); return false; }
    if (m === 'hybrid' && !gps.active) await toggleGPS();
    if (m === 'steps' && gps.active) await toggleGPS();
  }
  syncModeUI(); updateStatus();
  if (!quiet) toast(TRACK_HELP[m], 'ok', 5000);
  return true;
}
async function cycleTrack() {
  const order = ['hybrid', 'steps', 'gps'];
  await setTrackMode(order[(order.indexOf(settings.trackMode) + 1) % order.length]);
  return true;
}

// "Walk Track": virtual walkthrough that follows the real walk (steps) and the phone's direction
async function startWalkTrack() {
  if (!viewer.models.children.length) return toast('Open a model first', 'warn');
  if (!app.loc.fix) return toast('Set where you stand first: Site → I\'m Here', 'warn', 4500);
  try { await orient.requestPermission(); orient.start(); } catch (e) { return toast(e.message, 'error'); }
  if (!(await toggleSteps(true))) return;
  setMode('walk');
  viewer.bearing = getBearing();
  viewer.walk.gyro = true; viewer.walk.follow = true;
  computeLoc();
  viewer.persp.position.copy(viewer.ifcToWorld(app.loc.fix.position)).add(new THREE.Vector3(0, viewer.walk.eye, 0));
  syncToggles();
  toast('Walk Track: walk for real and the model follows · drag left / right to line the model up with reality', 'ok', 5000);
}

function applyCPFix(cp) {
  const P = app.project;
  if (cp.projectId && cp.projectId !== P.id) toast('This QR belongs to another project — using its coordinates', 'warn', 4000);
  let rec = findCP(cp);
  if (!rec) { rec = { id: cp.id || uuid(), name: cp.name, position: cp.position, size: cp.size, mount: cp.mount, heading: cp.heading, createdAt: new Date().toISOString() }; P.geo.controlPoints.push(rec); }
  applyFix(rec, 'qr');
}
// QR payloads carry only the first 8 characters of the id (compact = bigger modules), so match by prefix
function findCP(cp) {
  const id = String(cp.id || '').replace(/-/g, '');
  return app.project.geo.controlPoints.find((c) => c.id === cp.id || (id && c.id.replace(/-/g, '').startsWith(id)));
}

// ---------------- QR pose: camera position + heading from the QR image (called by the AR overlay's QR Lock)
function onQrDetect(det, K) {
  const cp0 = decodeCP(det.text);
  if (!cp0) return { ok: false, msg: 'This QR is not from SiteAR' };
  const rec = findCP(cp0);
  const cp = { name: (rec && rec.name) || cp0.name, position: (rec && rec.position) || cp0.position, size: cp0.size, mount: cp0.mount, heading: cp0.heading };
  // the QR itself carries the size/mount/heading that were printed; use the project's value if it was corrected later
  if (rec) { cp.size = rec.size || cp.size; cp.mount = rec.mount || cp.mount; cp.heading = rec.heading ?? cp.heading; }
  const pose = poseFromDetection(det, cp.size, K.f, K.cx, K.cy);
  if (!pose) return { ok: false, msg: `${cp.name}: cannot compute the pose` };
  if (pose.dist > 4) return { ok: false, msg: `${cp.name} too far (${pose.dist.toFixed(1)} m) — move within 2 m` };
  if (pose.reproj > 8) return { ok: false, msg: `${cp.name}: image unclear or too oblique` };
  const m = poseToModel(pose, cp);
  // trust falls with distance: ≤2 m full, 2–3 m half, beyond a quarter
  const gain = pose.dist <= 2 ? 1 : pose.dist <= 3 ? 0.5 : 0.25;
  const target = { x: m.position.x, y: m.position.y, z: m.position.z - settings.eye };
  const f = app.loc.fix, recent = f && f.src === 'qr' && Date.now() - f.t < 2500;
  const g = recent ? Math.min(gain, 0.5) : gain;
  const cur = (f && f.position) || target;
  const pos = { x: cur.x + (target.x - cur.x) * g, y: cur.y + (target.y - cur.y) * g, z: cur.z + (target.z - cur.z) * g };
  app.loc.fix = { id: (rec && rec.id) || cp0.id, position: pos, t: Date.now(), src: 'qr', linked: f && f.linked };
  if (settings.trackMode !== 'gps') app.loc.stepMode = true; // hold the QR position; steps continue from here
  app.project.geo.here = { id: app.loc.fix.id, name: cp.name, method: 'qr-pose', position: { ...pos }, t: Date.now() };
  computeLoc(); updateStatus();
  return { ok: true, heading: m.heading, gain: g, msg: `${cp.name} ✓ ${pose.dist.toFixed(1)} m` };
}
// Lock "my position" to a known model point (QR scan or self-mark). With GPS on it also corrects GPS drift.
function applyFix(rec, method) {
  const P = app.project;
  app.loc.fix = { id: rec.id, position: { ...rec.position }, t: Date.now() };
  P.geo.here = { id: rec.id, name: rec.name, method, position: { ...rec.position }, t: Date.now() }; // survives reload
  app.loc.fixZ = rec.position.z;
  const g = gps.active && gps.last && Date.now() - gps.last.t < 10000 && gps.last.acc <= GOOD_GPS_M ? gps.last : null;
  if (g) app.loc.fix.linked = true;
  if (g && P.geo.anchor) {
    const pg = gpsToModel(P.geo.anchor, g.lat, g.lon);
    app.loc.corr = { x: rec.position.x - pg.x, y: rec.position.y - pg.y };
    toast(`Position locked to ${rec.name} (GPS corrected by ${Math.hypot(app.loc.corr.x, app.loc.corr.y).toFixed(1)} m)`, 'ok', 4000);
  } else if (g && !P.geo.anchor) {
    P.geo.anchor = { position: { ...rec.position }, lat: g.lat, lon: g.lon, alt: g.alt, bearing: getBearing(), method, accuracy: g.acc, createdAt: new Date().toISOString() };
    app.loc.corr = { x: 0, y: 0 };
    toast(`Location set from ${method === 'self' ? 'self-mark' : 'QR'} ${rec.name} — refine the heading with 2nd Point`, 'ok', 4500);
  } else toast(method === 'self' ? `You are at ${rec.name} (tap I'm Here again at the next point)` : `Position locked to ${rec.name}`, 'ok', 4000);
  save(); renderBadges(); computeLoc(); renderPanel(); updateStatus();
  if (viewer.mode === 'plan') viewer.focusPoint(viewer.ifcToWorld(rec.position), 10);
  else if (viewer.mode === 'orbit') viewer.focusPoint(viewer.ifcToWorld(rec.position), 10);
  if (viewer.mode === 'walk') viewer.persp.position.copy(viewer.ifcToWorld(rec.position)).add(new THREE.Vector3(0, viewer.walk.eye, 0));
}

// ---------------- gyro / AR
// Optional "turn with the phone" in Walk. RELATIVE to the current view (no compass needed): at switch-on the
// heading offset is chosen so the view does not jump sideways; after that the view follows the phone.
function gyroOff() {
  const w = viewer.walk; if (!w.gyro) return;
  w.gyro = false;
  const e = new THREE.Euler().setFromQuaternion(viewer.persp.quaternion, 'YXZ'); // keep looking where we are now
  w.yaw = e.y; w.pitch = THREE.MathUtils.clamp(e.x, -1.45, 1.45);
  syncModeUI();
}
async function toggleGyro() {
  if (viewer.walk.gyro) { gyroOff(); toast('Gyro off — use the look stick', 'info', 1800); return; }
  try { await orient.requestPermission(); orient.start(); } catch (e) { return toast('Motion & Orientation permission denied', 'error', 4000); }
  for (let i = 0; i < 15 && !orient.ready; i++) await new Promise((r) => setTimeout(r, 100)); // wait for the first sensor reading
  if (!orient.ready) return toast('This device has no orientation sensor', 'warn');
  if (viewer.mode !== 'walk') setMode('walk');
  const q = viewer.persp.quaternion;
  let f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  if (Math.abs(f.y) > 0.85) f = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const camH = normDeg((Math.atan2(f.x, -f.z) * 180) / Math.PI);
  viewer.bearing = normDeg(orient.getHeading() - camH); // view heading = phone heading − bearing  → no sideways jump
  viewer.headingTrim = 0;
  viewer.walk.gyro = true;
  syncModeUI();
  toast('Gyro on: turn the device to look around · drag or use the look stick to adjust · press again to turn off', 'ok', 4500);
}
async function startXR() {
  if (!viewer.models.children.length) return toast('Open a model first', 'warn');
  if (!(await xrARSupported())) {
    return modal({ title: 'WebXR AR not available', body: `<p>This device / browser does not support WebXR AR.</p><ul class="muted"><li><b>Android</b>: Chrome + Google Play Services for AR (ARCore) over HTTPS</li><li><b>iPhone / iPad</b>: Safari does not support WebXR AR yet — use <b>Camera AR</b> instead (or the future Unity / ARKit app)</li></ul>`,
      actions: [{ label: 'Close', onClick: (c) => c() }, { label: 'Use Camera AR', kind: 'primary', icon: 'camera', onClick: (c) => { c(); startCamAR(); } }] });
  }
  try {
    try { await orient.requestPermission(); orient.start(); } catch (e) { /* optional */ }
    clearSelection(); setTool('select');
    await ar.startXR();
    syncModeUI();
  } catch (e) { console.error(e); toast(`AR: ${e.message}`, 'error', 5000); }
}
async function startCamAR() {
  if (!viewer.models.children.length) return toast('Open a model first', 'warn');
  try {
    clearSelection(); setTool('select');
    await ar.startCamera();
    if (app.loc.fix || app.project.geo.anchor) setTrackMode(settings.trackMode, true); // follow the user's walking automatically
    syncModeUI();
  } catch (e) { console.error(e); toast(`Camera AR: ${e.message}`, 'error', 5000); }
}

// ================================================================ export
async function cmdExportBCF() {
  if (!app.project.markups.length) return toast('No markups to export yet', 'warn');
  busy('Creating BCF…');
  try { download(await exportBCF(app.project, settings.author || 'SiteAR'), `${slug(app.project.name)}.bcfzip`); toast(`Exported ${app.project.markups.length} topics (BCF 3.0)`, 'ok'); }
  catch (e) { toast(e.message, 'error'); }
  busy(false);
}
function cmdExportCSV() {
  const rows = [['Number', 'Group', 'Type', 'Status', 'Priority', 'Title', 'Description', 'Author', 'Created', 'Modified', 'X', 'Y', 'Z', 'Latitude', 'Longitude', 'IFC GUID', 'Element', 'IFC Type', 'Source', 'Locked', 'Photos', 'Replies']];
  for (const m of app.project.markups) rows.push([m.number, groupName(m.group), m.type, m.status, m.priority, markupTitle(m), m.text, m.author, m.createdAt, m.modifiedAt,
    m.position.x.toFixed(4), m.position.y.toFixed(4), m.position.z.toFixed(4), m.gps ? m.gps.lat.toFixed(8) : '', m.gps ? m.gps.lon.toFixed(8) : '',
    m.element ? m.element.guid : '', m.element ? m.element.name : '', m.element ? m.element.ifcType : '', m.source, m.locked ? 'yes' : '', m.photos.length, m.replies.length]);
  const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${slug(app.project.name)}_markups.csv`);
}
$('#file-project').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    if (/\.(bcf|bcfzip|zip)$/i.test(file.name)) {
      const list = await importBCF(file);
      let added = 0, updated = 0;
      for (const m of list) {
        const ex = app.project.markups.find((x) => x.id === m.id);
        if (m.number == null || (!ex && app.project.markups.some((x) => x.number === m.number))) m.number = app.project.nextNumber++;
        else app.project.nextNumber = Math.max(app.project.nextNumber, m.number + 1);
        if (ex) { Object.assign(ex, m); updated++; } else { app.project.markups.push(m); added++; }
      }
      save(); refreshMarkers(); openPanel('markups');
      toast(`BCF: ${added} added, ${updated} updated`, 'ok');
    } else {
      const p = JSON.parse(await file.text());
      if (!p.schema || !String(p.schema).startsWith('sitear.project')) throw new Error('Not a SiteAR project file');
      const exists = await store.getProject(p.id);
      if (exists && !(await confirmBox('Replace project', `A project "${exists.name}" already exists — replace it with this file?`, 'Replace', true))) return;
      await store.putProject(p); await openProject(p);
      toast('Project imported', 'ok');
    }
  } catch (err) { console.error(err); toast(err.message, 'error', 5000); }
};

function revitGuide() {
  modal({ title: 'Revit ⇄ SiteAR workflow', wide: true, body: `
    <div class="guide">
      <h4>1 · Revit → SiteAR</h4>
      <ol><li>Revit: <b>File → Export → IFC</b> (IFC4 Reference View or IFC2x3 Coordination View 2.0)</li>
        <li>Setup → <b>Coordinate Base: Shared Coordinates</b> (or Survey Point) so coordinates match the surveyor</li>
        <li>Tick <i>Export IFC common property sets</i> and <i>Export base quantities</i> as needed</li>
        <li>Open the .ifc in SiteAR (Open Model)</li></ol>
      <h4>2 · Review</h4>
      <ol><li><b>Walk</b> through the model with the sticks (or W A S D on a PC)</li>
        <li><b>Capture</b> views and <b>Mark</b> points (Comment / Note / Issue + photos)</li>
        <li>Keep related captures and marks together in <b>Groups</b></li></ol>
      <h4>3 · SiteAR → Revit</h4>
      <ol><li><b>Export BCF</b> (.bcfzip, BCF 3.0) — each markup carries the camera view, images, the element IFC GUID and coordinates</li>
        <li>Revit: install a BCF add-in such as <b>BIMcollab Zoom / BCF Manager for Revit</b> or <b>Revizto / BIM Track</b>, import the BCF, click a topic and Revit zooms to the element</li>
        <li>Open source: <b>Bonsai (BlenderBIM)</b>, <b>xBIM / BIMvision</b> and <b>IfcOpenShell</b> read BCF</li>
        <li>To place pins as real Revit elements, use the <b>Project JSON</b> with the Dynamo / pyRevit script (see docs/REVIT.md)</li></ol>
      <p class="muted small">All coordinates are IFC coordinates (metres, Z up) — they match Revit when exported with Shared Coordinates</p>
    </div>`, actions: [{ label: 'Close', kind: 'primary', onClick: (c) => c() }] });
}

function settingsDialog() {
  const body = h(`<div>
    <label class="field"><span>Author</span><input id="st-a" value="${esc(settings.author)}"></label>
    <div class="field-row">
      <label class="field"><span>Eye height (m)</span><input id="st-e" inputmode="decimal" value="${settings.eye}"></label>
      <label class="field"><span>Camera AR vertical FOV (°)</span><input id="st-f" inputmode="decimal" value="${settings.camFov}"></label>
      <label class="field"><span>Step length (m)</span><input id="st-sl" inputmode="decimal" value="${settings.stepLen}"></label>
    </div>
    <label class="field"><span>Step sensitivity (left = more sensitive)</span><input id="st-ss" type="range" min="0.3" max="2" step="0.1" value="${settings.stepSens}"></label>
    <p class="muted small">If steps are missed, move left · if steps count while standing still, move right · the ▲ button is a manual backup</p>
    <div class="field-row">
      <label class="field"><span>AR model opacity</span><input id="st-o" type="range" min="0.1" max="1" step="0.05" value="${settings.arOpacity}"></label>
      <label class="field"><span>GPS averaging (s)</span><input id="st-g" inputmode="numeric" value="${settings.gpsAvg}"></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Scope box: max distance (× model size)</span><input id="st-sc" inputmode="decimal" value="${settings.scopeFactor}"></label>
    </div>
    <p class="muted small">Scope: the camera stays within this many model radii of the centre (default 3) and the model stays on screen</p>
    <p class="muted small">Camera AR FOV: adjust if the model looks bigger / smaller than reality (most phones 40–50° vertical)</p></div>`);
  modal({ title: 'Settings', body, actions: [{ label: 'Cancel', onClick: (c) => c() }, { label: 'Save', kind: 'primary', icon: 'check', onClick: (c) => {
    settings.author = body.querySelector('#st-a').value.trim();
    settings.eye = parseFloat(body.querySelector('#st-e').value) || 1.6;
    settings.camFov = Math.min(75, Math.max(25, parseFloat(body.querySelector('#st-f').value) || 45));
    settings.arOpacity = parseFloat(body.querySelector('#st-o').value);
    settings.gpsAvg = Math.min(60, Math.max(2, parseInt(body.querySelector('#st-g').value, 10) || 8));
    settings.stepLen = Math.min(1.2, Math.max(0.3, parseFloat(body.querySelector('#st-sl').value) || 0.7));
    settings.stepSens = parseFloat(body.querySelector('#st-ss').value) || 0.8; steps.threshold = settings.stepSens;
    settings.scopeFactor = Math.min(20, Math.max(1.5, parseFloat(body.querySelector('#st-sc').value) || 3));
    viewer.scopeFactor = settings.scopeFactor; viewer.invalidateScope();
    viewer.walk.eye = settings.eye; saveSettings(); c(); toast('Settings saved', 'ok');
  } }] });
}

// ================================================================ status bar & compass
function setPickReadout(ifc) {
  $('#st-xyz').innerHTML = ifc ? `<b>X</b> ${fmtM(ifc.x)} <b>Y</b> ${fmtM(ifc.y)} <b>Z</b> ${fmtM(ifc.z)}` : '—';
}
function updateStatus() {
  const g = $('#st-gps');
  if (!gps.active) { g.dataset.s = 'off'; g.innerHTML = `${icon('gps')}<span>GPS off</span>`; }
  else if (!gps.last) { g.dataset.s = 'wait'; g.innerHTML = `${icon('gps')}<span>GPS…</span>`; }
  else { g.dataset.s = gps.last.acc < 5 ? 'good' : gps.last.acc < 15 ? 'mid' : 'bad'; g.innerHTML = `${icon('gps')}<span>±${gps.last.acc.toFixed(1)} m</span>`; }
  const a = app.project && app.project.geo.anchor;
  const an = $('#st-anchor');
  an.dataset.s = a ? 'good' : 'off';
  an.dataset.s = a || app.loc.fix ? 'good' : 'off';
  const fixLabel = app.loc.tripod ? ` · Tripod ${settings.eye.toFixed(2)} m` : app.loc.fix ? (app.loc.stepMode ? (settings.trackMode === 'hybrid' ? ' · Hybrid' : ' · Steps') : app.loc.fix.id === 'self' ? ' · Self' : ' · QR') : '';
  an.innerHTML = `${icon('anchor')}<span>${a ? `N ${getBearing().toFixed(1)}°` : app.loc.fix ? 'Here' : 'No location'}${fixLabel}</span>`;
}
viewer.addEventListener('frame', () => {
  const rot = viewer.screenNorth(getBearing());
  $('#compass-needle').style.transform = `rotate(${rot}deg)`;
  if (gps.active || app.loc.fix || orient.listening) computeLoc();
  if (app.wm && app.wm.state === 'walk' && viewer.youWorld) viewer.followPlan(viewer.youWorld, 0.25);
});
viewer.addEventListener('mode', (e) => { if (e.detail.mode !== 'walk') gyroOff(); syncModeUI(); });
$('#gyro-btn').onclick = () => toggleGyro();
document.body.classList.toggle('touch', isTouch);
viewer.addEventListener('clip', () => syncToggles());
$('#compass').onclick = () => goHome();
$('#home-btn').onclick = () => goHome();
$('#home-btn').oncontextmenu = (e) => { e.preventDefault(); setHome(); };

// mode bar
$('#modebar').onclick = (e) => {
  const b = e.target.closest('[data-mode]'); if (!b) return;
  const m = b.dataset.mode;
  if (m === 'ar') return xrARSupported().then((ok) => (ok ? startXR() : startCamAR()));
  setMode(m);
};

// ---- game-style Walk controls: left stick = move, right stick = look, ▲▼ = fly up / down, speed button
function makeStick(el, onChange) {
  const knob = el.querySelector('.knob');
  let id = null, cx = 0, cy = 0;
  const move = (e) => {
    if (e.pointerId !== id) return;
    const R = Math.max(16, el.clientWidth / 2 - knob.offsetWidth / 2); // travel follows the (CSS) stick size
    let dx = e.clientX - cx, dy = e.clientY - cy; const d = Math.hypot(dx, dy);
    if (d > R) { dx = (dx / d) * R; dy = (dy / d) * R; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`; onChange(dx / R, dy / R);
  };
  const end = (e) => { if (e.pointerId !== id) return; id = null; knob.style.transform = ''; el.classList.remove('active'); onChange(0, 0); };
  el.addEventListener('pointerdown', (e) => { id = e.pointerId; el.classList.add('active'); try { el.setPointerCapture(id); } catch (err) { /* synthetic pointer */ } const r = el.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; move(e); });
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}
makeStick($('#joystick'), (x, y) => { viewer.walk.joy.x = x; viewer.walk.joy.y = y; });
makeStick($('#joystick-look'), (x, y) => { viewer.walk.look.x = x; viewer.walk.look.y = y; });
for (const [id, dir] of [['#fly-up', 1], ['#fly-down', -1]]) {
  const b = $(id);
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); viewer.walk.vert = dir; try { b.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ } });
  for (const ev of ['pointerup', 'pointercancel']) b.addEventListener(ev, () => { viewer.walk.vert = 0; });
}
const SPEEDS = [[1.4, 'WALK'], [3, 'RUN'], [6, 'FAST'], [12, 'FLY']];
let speedIdx = 0;
$('#speed-btn').onclick = () => { speedIdx = (speedIdx + 1) % SPEEDS.length; viewer.walk.speed = SPEEDS[speedIdx][0]; $('#speed-btn').textContent = SPEEDS[speedIdx][1]; toast(`Speed: ${SPEEDS[speedIdx][1]} (${SPEEDS[speedIdx][0]} m/s)`, 'info', 1200); };

$('#st-ver').textContent = `v${APP_VERSION}`;

// shelved UI
if (!LOCATION_FEATURES) { $('#st-anchor').hidden = true; $('#st-gps').hidden = true; const ar = $('#modebar [data-mode=ar]'); if (ar) ar.hidden = true; }

// ================================================================ file inputs, drag & drop, sample
$('#file-model').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; onModelFiles(f); };
const vp = $('#viewport');
vp.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
vp.addEventListener('dragleave', (e) => { if (e.target === vp || !vp.contains(e.relatedTarget)) document.body.classList.remove('dragging'); });
vp.addEventListener('drop', (e) => {
  e.preventDefault(); document.body.classList.remove('dragging');
  const files = [...e.dataTransfer.files];
  const proj = files.find((f) => /\.(json|bcf|bcfzip)$/i.test(f.name));
  if (proj) { const dt = new DataTransfer(); dt.items.add(proj); $('#file-project').files = dt.files; $('#file-project').dispatchEvent(new Event('change')); }
  onModelFiles(files.filter((f) => !/\.(json|bcf|bcfzip)$/i.test(f.name)));
});
$('#empty').onclick = async (e) => {
  const b = e.target.closest('[data-e]'); if (!b) return;
  if (b.dataset.e === 'open') return $('#file-model').click();
  if (b.dataset.e === 'import') { $('#file-project').dataset.kind = 'json-import'; return $('#file-project').click(); }
  if (b.dataset.e === 'sample') {
    busy('Downloading sample…');
    try {
      const r = await fetch('samples/sample-building.ifc');
      if (!r.ok) throw new Error('sample not found');
      const blob = await r.blob();
      await onModelFiles([new File([blob], 'sample-building.ifc')]);
    } catch (err) { busy(false); toast(err.message, 'error'); }
  }
};

// ================================================================ helpers
function slug(s) { return String(s || 'project').replace(/[^\w฀-๿.-]+/g, '_').slice(0, 60); }
function refreshAll() { refreshMarkers(); renderBadges(); renderTrack(); renderPanel(); updateStatus(); syncModeUI(); renderClipCtl(); computeLoc(); }

// ================================================================ boot
// ================================================================ orientation auto-detect
// CSS switches layouts by itself (portrait: bottom-sheet panel · landscape phone: compact ribbon + side panel).
// JS tags <body> so code/CSS can react, and re-fits the 3D canvas + ribbon tab underline after a rotation.
const mqLand = matchMedia('(orientation: landscape)');
function onOrientation() {
  const land = mqLand.matches;
  const phone = Math.min(window.innerWidth, window.innerHeight) < 520;
  document.body.dataset.orient = land ? 'landscape' : 'portrait';
  document.body.dataset.device = phone ? 'phone' : window.innerWidth < 1100 ? 'tablet' : 'desktop';
  setTimeout(() => { viewer.resize(); ribbon._ink(); }, 280);
}
(mqLand.addEventListener ? mqLand.addEventListener('change', onOrientation) : mqLand.addListener(onOrientation));
window.addEventListener('resize', () => { clearTimeout(onOrientation._t); onOrientation._t = setTimeout(onOrientation, 150); });
onOrientation();

window.sitear = { app, viewer, gps, orient, ar, settings, steps }; // handy for debugging in the browser console

(async function boot() {
  $('#brand').innerHTML = `${LOGO}<span>Site<b>AR</b></span>`;
  setSaveState('saved');
  if (window.innerWidth >= 900) document.body.classList.add('panel-open');
  await store.persist();
  let p = null;
  try { const id = localStorage.getItem(LAST_KEY); if (id) p = await store.getProject(id); } catch (e) { /* ignore */ }
  if (!p) { p = newProject('My first project'); await store.putProject(p); }
  await openProject(p);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  xrARSupported().then((ok) => { if (ok) document.body.classList.add('has-xr'); });
})();
