// 3D viewer: scene, cameras, navigation modes, picking, markers, "you are here", track, clipping.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { rawToIfc, ifcToRaw, modelHeadingOfRawDir } from './geo.js';

const UP = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3();

// ---------------------------------------------------------------- sprite textures
const texCache = new Map();
function canvasTex(key, w, h, draw) {
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}
function pinTexture(color, label, selected) {
  return canvasTex(`pin|${color}|${label}|${selected}`, 112, 144, (g, w) => {
    const cx = w / 2, cy = 50, r = 38;
    g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 12; g.shadowOffsetY = 4;
    g.beginPath(); g.arc(cx, cy, r, Math.PI * 0.82, Math.PI * 2.18);
    g.lineTo(cx, 138); g.closePath();
    g.fillStyle = color; g.fill();
    g.shadowColor = 'transparent';
    g.lineWidth = selected ? 7 : 3.5; g.strokeStyle = selected ? '#ffffff' : 'rgba(255,255,255,.85)'; g.stroke();
    g.beginPath(); g.arc(cx, cy, r - 11, 0, Math.PI * 2); g.fillStyle = 'rgba(8,10,14,.86)'; g.fill();
    g.fillStyle = '#fff'; g.font = `700 ${label.length > 2 ? 24 : 32}px Inter, system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, cx, cy + 1);
  });
}
function badgeTexture(label, color) {
  return canvasTex(`badge|${label}|${color}`, 120, 120, (g, w, h) => {
    g.translate(w / 2, h / 2); g.rotate(Math.PI / 4);
    g.shadowColor = 'rgba(0,0,0,.4)'; g.shadowBlur = 10;
    g.fillStyle = 'rgba(8,10,14,.9)'; g.strokeStyle = color; g.lineWidth = 6;
    g.beginPath(); g.roundRect(-34, -34, 68, 68, 10); g.fill(); g.stroke();
    g.rotate(-Math.PI / 4); g.shadowColor = 'transparent';
    g.fillStyle = color; g.font = `700 ${label.length > 2 ? 22 : 30}px Inter, system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, 0, 1);
  });
}
function youTexture() {
  return canvasTex('you', 128, 128, (g, w, h) => {
    const cx = w / 2, cy = h / 2;
    const grd = g.createRadialGradient(cx, cy, 6, cx, cy, 62);
    grd.addColorStop(0, 'rgba(56,225,255,.55)'); grd.addColorStop(1, 'rgba(56,225,255,0)');
    g.fillStyle = grd; g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, 62, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55); g.closePath(); g.fill();
    g.beginPath(); g.arc(cx, cy, 17, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    g.beginPath(); g.arc(cx, cy, 12, 0, Math.PI * 2); g.fillStyle = '#1aa7ff'; g.fill();
  });
}

// ---------------------------------------------------------------- Viewer
export class Viewer extends EventTarget {
  constructor(container, canvas) {
    super();
    this.container = container; this.canvas = canvas;
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setClearColor(0x000000, 0);
    r.localClippingEnabled = true;
    r.xr.enabled = true;

    const s = (this.scene = new THREE.Scene());
    s.add(new THREE.HemisphereLight(0xe6eeff, 0x1b2129, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(40, 80, 25); s.add(sun);
    const fill = new THREE.DirectionalLight(0x9fc4ff, 0.5); fill.position.set(-40, 30, -30); s.add(fill);

    this.grid = new THREE.GridHelper(600, 600, 0x26313d, 0x161c23);
    this.grid.material.transparent = true; this.grid.material.opacity = 0.55; this.grid.material.depthWrite = false;
    s.add(this.grid);

    // root = raw coordinate frame; children use raw (Y-up) metres
    this.root = new THREE.Group(); s.add(this.root);
    this.models = new THREE.Group(); this.markers = new THREE.Group(); this.geo = new THREE.Group(); this.highlights = new THREE.Group();
    this.root.add(this.models, this.highlights, this.markers, this.geo);
    this.offset = new THREE.Vector3(); this.hasOffset = false;

    this.persp = new THREE.PerspectiveCamera(55, 1, 0.05, 20000); this.persp.position.set(30, 25, 30);
    this.ortho = new THREE.OrthographicCamera(-20, 20, 20, -20, -10000, 10000); this.ortho.up.set(0, 0, -1);
    this.ortho.position.set(0, 1000, 0); this.ortho.lookAt(0, 0, 0);
    this.planHalf = 20;
    this.camera = this.persp;

    this.orbit = new OrbitControls(this.persp, canvas);
    this.orbit.enableDamping = true; this.orbit.dampingFactor = 0.12; this.orbit.screenSpacePanning = true;
    this.orbit.minDistance = 0.3; this.orbit.zoomSpeed = 1.4; this.orbit.rotateSpeed = 0.8;
    this.plan = new OrbitControls(this.ortho, canvas);
    Object.assign(this.plan, { enableRotate: false, screenSpacePanning: true, enableDamping: false, zoomToCursor: true, zoomSpeed: 1.6, enabled: false });
    this.plan.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }; // Revit: middle-drag pans
    this._planUser = false; this._planUserT = 0; // remember when the user last touched the plan (auto-follow pauses)
    this.plan.addEventListener('start', () => { this._planUser = true; });
    this.plan.addEventListener('end', () => { this._planUser = false; this._planUserT = performance.now(); });
    this.plan.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };

    this.mode = 'orbit';
    this.navLocked = false;
    this.clipPlanes = [];
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.2);
    this.clipOn = false; this.clipY = 1.2; // world Y of cut
    this.floorY = 0;
    this.xray = false; this.opacityFactor = 1;
    this.hooks = new Set();
    this.walk = { yaw: 0, pitch: 0, keys: new Set(), joy: { x: 0, y: 0 }, look: { x: 0, y: 0 }, vert: 0, speed: 1.4, follow: false, gyro: false, eye: 1.6 };
    this.tween = null;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line.threshold = 0.08;
    this.clock = new THREE.Clock();

    this._buildGeoObjects();
    this._bindInput();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    r.setAnimationLoop((t, frame) => this._tick(t, frame));
  }

  // ------------------------------------------------ coordinate helpers
  toRaw(world) { return this.root.worldToLocal(world.clone()); }
  toWorld(raw) { return this.root.localToWorld(raw.clone()); }
  ifcToWorld(p) { return this.toWorld(ifcToRaw(p)); }
  worldToIfc(w) { return rawToIfc(this.toRaw(w)); }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h || this.renderer.xr.isPresenting) return;
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h; this.persp.updateProjectionMatrix();
    const a = w / h;
    Object.assign(this.ortho, { left: -this.planHalf * a, right: this.planHalf * a, top: this.planHalf, bottom: -this.planHalf });
    this.ortho.updateProjectionMatrix();
  }

  // ------------------------------------------------ models
  addModel(obj, id, viewOrigin) {
    obj.userData.modelId = id;
    obj.traverse((o) => {
      o.userData.modelId = id;
      if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        m.clippingPlanes = this.clipPlanes;
        if (m.userData.baseOpacity === undefined) m.userData.baseOpacity = m.opacity ?? 1;
      }
    });
    this.models.add(obj);
    obj.updateMatrixWorld(true);
    this.invalidateScope();
    if (!this.hasOffset) {
      if (viewOrigin) this.setOffset(new THREE.Vector3(viewOrigin[0], viewOrigin[1], viewOrigin[2]));
      else {
        const box = new THREE.Box3().setFromObject(obj); // root is identity before first model
        const c = box.getCenter(new THREE.Vector3());
        this.setOffset(new THREE.Vector3(c.x, box.min.y, c.z));
      }
    }
    this.applyOpacity();
    return obj;
  }
  setOffset(v) {
    this.offset.copy(v); this.hasOffset = true;
    this.root.position.copy(v).negate();
    this.root.updateMatrixWorld(true);
  }
  removeModel(id) {
    const o = this.getModel(id);
    if (!o) return;
    this.models.remove(o);
    this.invalidateScope();
    o.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) [].concat(c.material).forEach((m) => m.dispose()); });
    this.clearHighlight();
  }
  getModel(id) { return this.models.children.find((o) => o.userData.modelId === id); }
  setModelVisible(id, v) { const o = this.getModel(id); if (o) o.visible = v; this.invalidateScope(); }
  modelBox() {
    const box = new THREE.Box3();
    for (const o of this.models.children) if (o.visible) box.expandByObject(o);
    return box;
  }

  setXray(on) { this.xray = on; this.applyOpacity(); }
  setOpacityFactor(f) { this.opacityFactor = f; this.applyOpacity(); }
  applyOpacity() {
    const f = (this.xray ? 0.16 : 1) * this.opacityFactor;
    this.models.traverse((o) => {
      if (!o.material) return;
      for (const m of [].concat(o.material)) {
        const base = m.userData.baseOpacity ?? 1;
        const op = base * f;
        m.opacity = op; m.transparent = op < 0.99; m.depthWrite = op >= 0.99 || (this.xray ? false : base >= 0.99 && f >= 0.99);
        m.needsUpdate = true;
      }
    });
  }

  // ------------------------------------------------ clipping (plan cut)
  setClip(on, worldY = this.clipY) {
    this.clipOn = on; this.clipY = worldY;
    this.clipPlane.constant = worldY;
    this.clipPlanes.length = 0;
    if (on) this.clipPlanes.push(this.clipPlane);
    this.dispatchEvent(new CustomEvent('clip', { detail: { on, y: worldY } }));
  }

  // ------------------------------------------------ modes
  setMode(mode) {
    const prev = this.mode;
    if (prev === mode) return;
    if (prev === 'walk' && (mode === 'orbit')) {
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.persp.quaternion);
      this.orbit.target.copy(this.persp.position).addScaledVector(dir, 6);
    }
    this.mode = mode;
    this.camera = mode === 'plan' ? this.ortho : this.persp;
    if (mode === 'plan') {
      const t = prev === 'walk' ? this.persp.position : this.orbit.target;
      this.plan.target.set(t.x, this.floorY, t.z);
      this.ortho.position.set(t.x, this.floorY + 1000, t.z);
      this.ortho.up.set(0, 0, -1); this.ortho.lookAt(this.plan.target);
      this.plan.update();
    }
    if (mode === 'walk') {
      const p = this.persp.position;
      const t = this.orbit.target;
      if (prev !== 'walk') {
        const floor = this.findFloor(t) ?? this.floorY;
        p.set(t.x, floor + this.walk.eye, t.z);
        if (prev === 'plan') p.set(this.plan.target.x, floor + this.walk.eye, this.plan.target.z);
      }
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.persp.quaternion);
      this.walk.yaw = Math.atan2(-dir.x, -dir.z); this.walk.pitch = 0;
    }
    if (mode === 'orbit' && prev === 'plan') {
      const t = this.plan.target;
      this.orbit.target.copy(t);
      this.persp.position.set(t.x + 25, t.y + 25, t.z + 25);
    }
    this._applyControlState();
    this.grid.visible = !(mode === 'xr' || mode === 'cam-ar') && this._gridOn !== false;
    this.dispatchEvent(new CustomEvent('mode', { detail: { mode, prev } }));
  }
  setGrid(on) { this._gridOn = on; this.grid.visible = on && !(this.mode === 'xr' || this.mode === 'cam-ar'); }
  setNavLocked(on) { this.navLocked = on; this._applyControlState(); }
  _applyControlState() {
    this.orbit.enabled = false; // 3D uses the Revit-style navigation in _bindNav(); OrbitControls only holds .target
    if (this.mode === 'orbit') this._needLook = true;
    this.plan.enabled = this.mode === 'plan' && !this.navLocked;
  }

  findFloor(worldPt) {
    const rc = new THREE.Raycaster(new THREE.Vector3(worldPt.x, worldPt.y + 1.0, worldPt.z), new THREE.Vector3(0, -1, 0), 0, 50);
    const hits = rc.intersectObjects(this.models.children, true).filter((h) => h.object.isMesh);
    return hits.length ? hits[0].point.y : null;
  }

  // ------------------------------------------------ fit & fly
  fitAll(animate = true) {
    const box = this.modelBox();
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    if (this.mode === 'plan') {
      const a = this.persp.aspect;
      this.plan.target.set(c.x, this.floorY, c.z);
      this.ortho.position.set(c.x, this.floorY + 1000, c.z);
      this.ortho.zoom = Math.max(0.01, Math.min((2 * this.planHalf) / (size.z * 1.15), (2 * this.planHalf * a) / (size.x * 1.15)));
      this.ortho.updateProjectionMatrix();
      return;
    }
    if (this.mode !== 'orbit') this.setMode('orbit');
    const r = size.length() / 2;
    const vf = THREE.MathUtils.degToRad(this.persp.fov);
    const hf = 2 * Math.atan(Math.tan(vf / 2) * this.persp.aspect); // portrait phones: horizontal FOV is the limit
    const dist = r / Math.sin(Math.min(vf, hf) / 2) * 0.95;
    const dir = new THREE.Vector3(0.9, 0.75, 1.1).normalize();
    this.flyTo(c.clone().addScaledVector(dir, dist), c, animate);
  }
  flyTo(camPos, target, animate = true) {
    this.nav && this.nav.zoomPending.set(0, 0, 0);
    if (!animate) { this.persp.position.copy(camPos); this.orbit.target.copy(target); this._needLook = true; return; }
    this.tween = { t: 0, dur: 0.55, p0: this.persp.position.clone(), p1: camPos.clone(), t0: this.orbit.target.clone(), t1: target.clone() };
  }
  focusPoint(world, dist = 8) {
    if (this.mode === 'plan') {
      this.plan.target.set(world.x, this.floorY, world.z);
      this.ortho.position.set(world.x, this.floorY + 1000, world.z);
      return;
    }
    if (this.mode === 'walk') this.setMode('orbit');
    const dir = this.persp.position.clone().sub(this.orbit.target).normalize();
    if (dir.lengthSq() < 0.5) dir.set(1, 1, 1).normalize();
    this.flyTo(world.clone().addScaledVector(dir, dist), world);
  }

  // ------------------------------------------------ saved views (stored in IFC coords)
  getViewState() {
    const cam = this.camera;
    let target;
    if (this.mode === 'plan') target = this.plan.target.clone();
    else if (this.mode === 'orbit') target = this.orbit.target.clone();
    else target = cam.position.clone().add(new THREE.Vector3(0, 0, -5).applyQuaternion(cam.quaternion));
    const upW = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const upRaw = upW.clone().applyQuaternion(this.root.getWorldQuaternion(new THREE.Quaternion()).invert());
    return {
      mode: ['orbit', 'plan', 'walk'].includes(this.mode) ? this.mode : 'orbit',
      position: this.worldToIfc(cam.position),
      target: this.worldToIfc(target),
      up: rawToIfc(upRaw),
      fov: this.persp.fov,
      orthoHeight: (this.ortho.top - this.ortho.bottom) / this.ortho.zoom,
      aspect: this.persp.aspect,
      clip: { on: this.clipOn, z: this.worldToIfc(new THREE.Vector3(0, this.clipY, 0)).z },
      xray: this.xray
    };
  }
  setViewState(v) {
    if (!v) return;
    this.setMode(v.mode || 'orbit');
    const pos = this.ifcToWorld(v.position), tgt = this.ifcToWorld(v.target);
    if (v.clip) this.setClip(!!v.clip.on, this.ifcToWorld({ x: 0, y: 0, z: v.clip.z }).y);
    if (typeof v.xray === 'boolean') this.setXray(v.xray);
    if (this.mode === 'plan') {
      this.plan.target.set(tgt.x, this.floorY, tgt.z);
      this.ortho.position.set(tgt.x, this.floorY + 1000, tgt.z);
      if (v.orthoHeight) { this.ortho.zoom = (this.ortho.top - this.ortho.bottom) / v.orthoHeight; this.ortho.updateProjectionMatrix(); }
    } else if (this.mode === 'walk') {
      this.persp.position.copy(pos);
      const d = tgt.clone().sub(pos).normalize();
      this.walk.yaw = Math.atan2(-d.x, -d.z); this.walk.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
    } else this.flyTo(pos, tgt);
  }

  snapshot(width = 480, type = 'image/jpeg', quality = 0.8) {
    this.renderer.render(this.scene, this.camera);
    const src = this.canvas;
    const h = Math.round((width * src.height) / src.width);
    const c = document.createElement('canvas'); c.width = width; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#0d1116'; g.fillRect(0, 0, width, h);
    g.drawImage(src, 0, 0, width, h);
    return c.toDataURL(type, quality);
  }

  // ------------------------------------------------ picking
  ndc(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }
  pick(clientX, clientY, { markers = true } = {}) {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    this.raycaster.camera = this.camera;
    return this.pickRay(this.raycaster, { markers });
  }
  pickRay(rc, { markers = true } = {}) {
    if (markers) {
      const objs = [...(this.markers.visible ? this.markers.children : []), ...this.badges.children.filter((o) => o.userData.pickable)];
      const mh = rc.intersectObjects(objs, false);
      if (mh.length) {
        const o = mh[0].object;
        if (o.userData.markupId) return { type: 'marker', id: o.userData.markupId };
        if (o.userData.cpId) return { type: 'cp', id: o.userData.cpId };
      }
    }
    const scale = this.mode === 'plan' ? 6 / this.ortho.zoom / (this.container.clientHeight / (2 * this.planHalf)) : 0.08;
    rc.params.Line.threshold = Math.max(0.03, scale);
    const hits = rc.intersectObjects(this.models.children, true).filter((h) => {
      let o = h.object; while (o) { if (!o.visible) return false; o = o.parent; }
      return !(this.clipOn && h.point.y > this.clipY + 1e-4);
    });
    if (hits.length) {
      const h = hits[0];
      const eidAttr = h.object.geometry.attributes.eid;
      const eid = eidAttr && h.face ? eidAttr.getX(h.face.a) : null;
      let model = h.object; while (model && model.parent !== this.models) model = model.parent;
      return { type: 'model', point: h.point.clone(), eid, modelId: model && model.userData.modelId, object: h.object };
    }
    // fallback: horizontal plane at the floor level
    const floorY = this.clipOn ? Math.min(this.floorY, this.clipY) : this.floorY;
    const pt = new THREE.Vector3();
    if (rc.ray.intersectPlane(new THREE.Plane(UP, -floorY), pt)) return { type: 'plane', point: pt };
    return null;
  }

  highlightElement(modelId, eid) {
    this.clearHighlight();
    const model = this.getModel(modelId);
    if (!model || eid == null) return;
    const mat = new THREE.MeshBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.45, depthTest: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, clippingPlanes: this.clipPlanes });
    model.traverse((o) => {
      if (!o.isMesh || !o.geometry.attributes.eid) return;
      const ids = o.geometry.attributes.eid.array, idx = o.geometry.index.array;
      const out = [];
      for (let i = 0; i < idx.length; i += 3) if (ids[idx[i]] === eid) out.push(idx[i], idx[i + 1], idx[i + 2]);
      if (!out.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', o.geometry.attributes.position);
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(out), 1));
      const m = new THREE.Mesh(g, mat);
      m.position.copy(model.position); m.quaternion.copy(model.quaternion); m.scale.copy(model.scale);
      m.renderOrder = 5;
      this.highlights.add(m);
    });
  }
  // world-space bounding box of one IFC element (used to snap self-marks to a column centre)
  elementBox(modelId, eid) {
    const model = this.getModel(modelId);
    const box = new THREE.Box3(), v = new THREE.Vector3();
    if (!model || eid == null) return box;
    model.updateMatrixWorld(true);
    model.traverse((o) => {
      if (!o.isMesh || !o.geometry.attributes.eid) return;
      const ids = o.geometry.attributes.eid.array, pos = o.geometry.attributes.position;
      for (let i = 0; i < ids.length; i++) if (ids[i] === eid) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld));
    });
    return box;
  }
  clearHighlight() {
    // position attribute is shared with the model: detach it before dispose so the model's GPU buffer survives
    for (const m of [...this.highlights.children]) { this.highlights.remove(m); m.geometry.deleteAttribute('position'); m.geometry.dispose(); }
  }

  // ------------------------------------------------ markers
  setMarkers(list, selectedId, visible = true) {
    for (const s of [...this.markers.children]) { this.markers.remove(s); s.material.dispose(); }
    this.markers.visible = visible;
    for (const m of list) {
      const sel = m.id === selectedId;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: pinTexture(m.color, String(m.number), sel), depthTest: false, sizeAttenuation: false, transparent: true }));
      s.center.set(0.5, 0.02);
      const k = sel ? 0.074 : 0.06;
      s.scale.set(k * 0.78, k, 1);
      ifcToRaw(m.position, s.position);
      s.renderOrder = sel ? 1001 : 1000;
      s.userData.markupId = m.id;
      this.markers.add(s);
    }
    this._refreshSpriteScale();
  }

  // ------------------------------------------------ geo objects (you, track, anchor, control points)
  _buildGeoObjects() {
    const you = (this.you = new THREE.Group());
    const accMat = new THREE.MeshBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.1, depthTest: false, side: THREE.DoubleSide });
    this.youAcc = new THREE.Mesh(new THREE.CircleGeometry(1, 64), accMat); this.youAcc.rotation.x = -Math.PI / 2;
    this.youRing = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64), new THREE.MeshBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.6, depthTest: false, side: THREE.DoubleSide }));
    this.youRing.rotation.x = -Math.PI / 2;
    this.youDot = new THREE.Sprite(new THREE.SpriteMaterial({ map: youTexture(), depthTest: false, sizeAttenuation: false, transparent: true }));
    this.youDot.scale.set(0.1, 0.1, 1);
    for (const o of [this.youAcc, this.youRing, this.youDot]) o.renderOrder = 990;
    you.add(this.youAcc, this.youRing, this.youDot); you.visible = false;
    this.geo.add(you);

    this.track = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x7c5cff, transparent: true, opacity: 0.95, depthTest: false }));
    this.track.renderOrder = 980; this.track.frustumCulled = false;
    this.geo.add(this.track);
    this.badges = new THREE.Group(); this.geo.add(this.badges);
  }
  // raw position, accuracy (m), heading relative to model +Y (deg) or null
  setYou(raw, acc, headingModel) {
    if (!raw) { this.you.visible = false; return; }
    this.you.visible = true;
    this.you.position.copy(raw).add(new THREE.Vector3(0, 0.05, 0));
    const a = Math.max(0.3, acc || 0.3);
    this.youAcc.scale.setScalar(a); this.youRing.scale.setScalar(a);
    this.youDot.material.rotation = headingModel == null ? 0 : -THREE.MathUtils.degToRad(headingModel);
    this.youWorld = this.toWorld(this.you.position);
  }
  setTrack(rawPoints, visible = true) {
    this.track.visible = visible && rawPoints.length > 1;
    this.track.geometry.dispose();
    this.track.geometry = new THREE.BufferGeometry().setFromPoints(rawPoints.map((p) => p.clone().add(new THREE.Vector3(0, 0.04, 0))));
  }
  setBadges(items) { // [{raw, label, color, id, kind}]
    for (const s of [...this.badges.children]) { this.badges.remove(s); s.material.dispose(); }
    for (const it of items) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeTexture(it.label, it.color), depthTest: false, sizeAttenuation: false, transparent: true }));
      s.scale.set(0.045, 0.045, 1); s.position.copy(it.raw); s.renderOrder = 995;
      if (it.kind === 'cp') { s.userData.cpId = it.id; s.userData.pickable = true; }
      this.badges.add(s);
    }
    this._refreshSpriteScale();
  }

  // Walk & Mark: keep the plan centred on "you" (k = how fast), but never fight the user while they pan/zoom
  followPlan(w, k = 0.25) {
    if (this.mode !== 'plan' || this._planUser || performance.now() - this._planUserT < 2500) return;
    const t = this.plan.target, dx = (w.x - t.x) * k, dz = (w.z - t.z) * k;
    if (Math.hypot(dx, dz) < 1e-4) return;
    t.x += dx; t.z += dz; this.ortho.position.x += dx; this.ortho.position.z += dz;
  }

  // north-arrow rotation for the compass widget (deg, clockwise on screen)
  screenNorth(bearing) {
    const q = this.camera.getWorldQuaternion(new THREE.Quaternion());
    const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion()).invert();
    let f = new THREE.Vector3(0, 0, -1).applyQuaternion(q).applyQuaternion(rootQ);
    if (Math.abs(f.y) > 0.9) f = new THREE.Vector3(0, 1, 0).applyQuaternion(q).applyQuaternion(rootQ);
    const hModel = modelHeadingOfRawDir(f); // camera heading relative to model +Y
    return -((bearing || 0) + hModel);
  }

  // ================================================================ Revit-style 3D navigation
  //  Mouse:  wheel = zoom at cursor · middle-drag = pan · Shift+middle-drag = orbit
  //          left-drag = orbit · right-drag = pan · double-click middle = zoom to fit
  //  Touch:  1 finger = orbit · 2 fingers = pinch-zoom at midpoint + pan
  //  No inertia; orbit pivots around the point under the cursor (green ball, like Revit).
  _initNav() {
    const pm = new THREE.MeshBasicMaterial({ color: 0x3ddc97, transparent: true, opacity: 0.9, depthTest: false });
    this.pivotBall = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), pm);
    this.pivotBall.renderOrder = 999; this.pivotBall.visible = false;
    this.scene.add(this.pivotBall);
    this.nav = { pointers: new Map(), mode: null, pivot: new THREE.Vector3(), depth: 20, zoomPending: new THREE.Vector3(), lastMid: 0 };
  }
  _navActive() { return this.mode === 'orbit' && !this.navLocked; }

  // ---- scope box: the model can never leave the screen, the camera never drifts too far away
  //   scopeFactor = max camera distance from the model centre, in model radii (min 15 m)
  _scope() {
    if (!this._scopeCache) {
      const box = this.modelBox();
      if (box.isEmpty()) return null;
      const centre = box.getCenter(new THREE.Vector3()), radius = box.getSize(new THREE.Vector3()).length() / 2;
      this._scopeCache = { box, centre, radius };
    }
    const s = this._scopeCache;
    // always allow at least 1.6× the "fit all" distance (portrait phones need more room)
    const vf = THREE.MathUtils.degToRad(this.persp.fov), hf = 2 * Math.atan(Math.tan(vf / 2) * this.persp.aspect);
    const fitD = s.radius / Math.sin(Math.min(vf, hf) / 2);
    s.maxDist = Math.max(15, s.radius * (this.scopeFactor || 3), fitD * 1.6);
    return s;
  }
  invalidateScope() { this._scopeCache = null; }
  // true if the camera state is acceptable: model (partly) on screen and within max distance
  _scopeOK() {
    if (this.scopeOn === false) return true;
    const s = this._scope(); if (!s) return true;
    const cam = this.persp;
    if (cam.position.distanceTo(s.centre) > s.maxDist) return false;
    cam.updateMatrixWorld(); cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    // keep at least the core of the model visible (box shrunk to 60%), not just a corner
    const core = s.box.clone().expandByVector(s.box.getSize(new THREE.Vector3()).multiplyScalar(-0.2));
    return fr.intersectsBox(core.isEmpty() ? s.box : core);
  }
  // run a camera change; undo it if it breaks the scope
  _guarded(fn) {
    const cam = this.persp, p = cam.position.clone(), q = cam.quaternion.clone();
    if (!this._scopeOK()) { fn(); return true; } // already outside (e.g. restored view): never trap the user
    fn();
    if (!this._scopeOK()) { cam.position.copy(p); cam.quaternion.copy(q); cam.updateMatrixWorld(); this._syncTarget(); this._bump(); return false; }
    return true;
  }
  // brief visual hint at the edge of the scope
  _bump() {
    const now = performance.now();
    if (now - (this._bumpT || 0) < 600) return;
    this._bumpT = now;
    this.dispatchEvent(new Event('scope-limit'));
  }
  _hitUnder(x, y) {
    this.raycaster.setFromCamera(this.ndc(x, y), this.persp);
    const hits = this.raycaster.intersectObjects(this.models.children, true)
      .filter((h) => { let o = h.object; while (o) { if (!o.visible) return false; o = o.parent; } return !(this.clipOn && h.point.y > this.clipY + 1e-4); });
    return { hit: hits[0] || null, dir: this.raycaster.ray.direction.clone() };
  }
  _fwd() { return new THREE.Vector3(0, 0, -1).applyQuaternion(this.persp.quaternion); }
  // keep orbit.target (used by views/BCF) on the view axis at the current working depth
  _syncTarget() { this.orbit.target.copy(this.persp.position).addScaledVector(this._fwd(), Math.max(this.nav.depth, 0.5)); }
  _pickPivot(x, y) {
    const { hit, dir } = this._hitUnder(x, y);
    if (hit) { this.nav.pivot.copy(hit.point); this.nav.depth = Math.max(0.3, hit.point.clone().sub(this.persp.position).dot(this._fwd())); }
    else {
      // clicked empty space: orbit around the model centre (never swings the model off screen)
      const s = this._scope();
      const c = s ? s.centre.clone() : this.orbit.target.clone();
      this.nav.pivot.copy(c);
      this.nav.depth = Math.max(1, c.clone().sub(this.persp.position).dot(this._fwd()));
    }
  }
  _showPivot(on) {
    this.pivotBall.visible = on;
    if (on) { const d = this.persp.position.distanceTo(this.nav.pivot); this.pivotBall.position.copy(this.nav.pivot); this.pivotBall.scale.setScalar(Math.max(0.02, d * 0.012)); }
  }
  _orbit(dx, dy) {
    const cam = this.persp, P = this.nav.pivot, k = 0.0065;
    const qYaw = new THREE.Quaternion().setFromAxisAngle(UP, -dx * k);
    cam.position.sub(P).applyQuaternion(qYaw).add(P); cam.quaternion.premultiply(qYaw);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const pitch = -dy * k;
    const f = this._fwd();
    const cur = Math.asin(THREE.MathUtils.clamp(f.y, -1, 1));
    const next = THREE.MathUtils.clamp(cur + pitch, -1.53, 1.53); // keep scene upright, no flip
    const qPitch = new THREE.Quaternion().setFromAxisAngle(right, next - cur);
    cam.position.sub(P).applyQuaternion(qPitch).add(P); cam.quaternion.premultiply(qPitch);
    this._syncTarget();
  }
  _pan(dx, dy) {
    const cam = this.persp;
    const h = this.container.clientHeight || 1;
    const wpp = (2 * this.nav.depth * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / h; // metres per pixel at the grabbed depth
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    cam.position.addScaledVector(right, -dx * wpp).addScaledVector(up, dy * wpp);
    this._syncTarget();
  }
  // zoom toward screen point (x,y): the point under the cursor stays under the cursor
  _zoomAt(x, y, notches) {
    // finish any zoom still gliding so fast scrolling compounds from the true position (no overshoot)
    if (this.nav.zoomPending.lengthSq() > 0) { this.persp.position.add(this.nav.zoomPending); this.nav.zoomPending.set(0, 0, 0); this.persp.updateMatrixWorld(); }
    const { hit, dir } = this._hitUnder(x, y);
    let dist = hit ? hit.distance : Math.max(this.nav.depth, 1);
    if (hit) this.nav.depth = Math.max(0.3, hit.point.clone().sub(this.persp.position).dot(this._fwd()));
    const factor = Math.pow(0.82, notches); // like Revit: ~18% per wheel notch
    let move = dist * (1 - factor);
    if (notches > 0 && dist < 0.4) move = 0.12 * notches; // very close: creep forward / through
    this.nav.zoomPending.addScaledVector(dir, move);
    this.nav.depth = Math.max(0.3, this.nav.depth - move * dir.dot(this._fwd()));
  }

  _bindNav() {
    const c = this.canvas, N = this.nav;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      if (!this._navActive()) return;
      e.preventDefault(); e.stopImmediatePropagation();
      this.tween = null;
      let dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
      if (e.ctrlKey) dy *= 4; // trackpad pinch arrives as ctrl+wheel
      this._zoomAt(e.clientX, e.clientY, THREE.MathUtils.clamp(-dy / 100, -4, 4));
    }, { capture: true, passive: false });

    c.addEventListener('pointerdown', (e) => {
      if (!this._navActive()) return;
      this.tween = null;
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
      N.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (e.pointerType === 'mouse') {
        if (e.button === 1) { // middle: double-click = fit
          const now = performance.now();
          if (now - N.lastMid < 350) { this.fitAll(); N.lastMid = 0; return; }
          N.lastMid = now;
        }
        N.mode = (e.button === 1 && !e.shiftKey) || e.button === 2 || (e.button === 0 && e.shiftKey) ? 'pan' : 'orbit';
        this._pickPivot(e.clientX, e.clientY);
        N.moved = 0;
      } else if (N.pointers.size === 1) {
        N.mode = 'orbit'; N.moved = 0; this._pickPivot(e.clientX, e.clientY);
      } else if (N.pointers.size === 2) {
        const [a, b] = [...N.pointers.values()];
        N.mode = 'pinch'; N.pinchD = Math.hypot(a.x - b.x, a.y - b.y); N.mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this._pickPivot(N.mid.x, N.mid.y); this._showPivot(false);
      }
    });
    c.addEventListener('pointermove', (e) => {
      const p = N.pointers.get(e.pointerId);
      if (!p || !this._navActive()) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (N.mode === 'pinch' && N.pointers.size >= 2) {
        const [a, b] = [...N.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (N.pinchD > 0) this._zoomAt(mid.x, mid.y, Math.log(d / N.pinchD) / -Math.log(0.82));
        this._guarded(() => this._pan(mid.x - N.mid.x, mid.y - N.mid.y));
        N.pinchD = d; N.mid = mid;
        return;
      }
      N.moved += Math.abs(dx) + Math.abs(dy);
      if (N.moved < 4) return; // a click, not a drag
      if (N.mode === 'orbit') {
        this._showPivot(true);
        // try the full move, then each axis alone (slides along the scope edge instead of sticking)
        if (!this._guarded(() => this._orbit(dx, dy)) && !this._guarded(() => this._orbit(dx, 0))) this._guarded(() => this._orbit(0, dy));
      } else if (N.mode === 'pan') {
        if (!this._guarded(() => this._pan(dx, dy)) && !this._guarded(() => this._pan(dx, 0))) this._guarded(() => this._pan(0, dy));
      }
    });
    const end = (e) => {
      N.pointers.delete(e.pointerId);
      if (N.pointers.size === 1 && N.mode === 'pinch') { // back to one finger → orbit from here
        const [p] = [...N.pointers.values()]; N.mode = 'orbit'; N.moved = 99; this._pickPivot(p.x, p.y);
      } else if (!N.pointers.size) { N.mode = null; this._showPivot(false); }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  // ------------------------------------------------ input
  _bindInput() {
    const c = this.canvas;
    let down = null;
    this._initNav();
    this._bindNav();
    c.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, lx: e.clientX, ly: e.clientY };
      if (this.mode === 'walk' && !this.navLocked) c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!down || down.id !== e.pointerId) return;
      if (this.mode === 'walk' && !this.navLocked) {
        const dx = e.clientX - down.lx, dy = e.clientY - down.ly;
        if (!this.walk.gyro) { this.walk.yaw -= dx * 0.0045; this.walk.pitch = THREE.MathUtils.clamp(this.walk.pitch - dy * 0.0045, -1.45, 1.45); }
        else { // gyro look: dragging left/right trims the heading so the model lines up with the real world
          this.headingTrim = (this.headingTrim || 0) + dx * 0.12;
          if (this.orientSource) { if (this.orientSource.yawOffset === null) this.orientSource.yawOffset = 0; this.orientSource.manual = true; }
        }
      }
      down.lx = e.clientX; down.ly = e.clientY;
    });
    const up = (e) => {
      if (!down || down.id !== e.pointerId) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const primary = e.pointerType !== 'mouse' || e.button === 0; // middle/right clicks are navigation, not selection
      if (primary && moved < 7 && performance.now() - down.t < 600) this.dispatchEvent(new CustomEvent('tap', { detail: { x: e.clientX, y: e.clientY } }));
      down = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', () => { down = null; });
    c.addEventListener('dblclick', (e) => this.dispatchEvent(new CustomEvent('dbltap', { detail: { x: e.clientX, y: e.clientY } })));

    window.addEventListener('keydown', (e) => {
      if (/input|textarea|select/i.test(e.target.tagName)) return;
      this.walk.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.walk.keys.delete(e.code));
    window.addEventListener('blur', () => this.walk.keys.clear());
  }

  _walkUpdate(dt) {
    const w = this.walk, cam = this.persp, k = w.keys;
    if ((w.look.x || w.look.y) && !this.navLocked) { // right stick: turn / look up-down (rate control, like a game pad)
      w.yaw -= w.look.x * 1.9 * dt;
      w.pitch = THREE.MathUtils.clamp(w.pitch - w.look.y * 1.3 * dt, -1.45, 1.45);
    }
    if (w.gyro && this.orientSource && this.orientSource.ready) {
      const q = this.orientSource.getQuaternion();
      const qy = new THREE.Quaternion().setFromAxisAngle(UP, THREE.MathUtils.degToRad((this.bearing || 0) + (this.headingTrim || 0)));
      cam.quaternion.copy(qy.multiply(q));
      const d = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion); w.yaw = Math.atan2(-d.x, -d.z);
    } else cam.rotation.set(w.pitch, w.yaw, 0, 'YXZ');
    if (this.navLocked) return;
    const fwd = new THREE.Vector3(-Math.sin(w.yaw), 0, -Math.cos(w.yaw));
    const right = new THREE.Vector3(Math.cos(w.yaw), 0, -Math.sin(w.yaw));
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - w.joy.y;
    const r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) + w.joy.x;
    const u = (k.has('KeyE') || k.has('PageUp') ? 1 : 0) - (k.has('KeyQ') || k.has('PageDown') ? 1 : 0) + w.vert; // ▲▼ buttons add to Q/E
    const sp = w.speed * (k.has('ShiftLeft') || k.has('ShiftRight') ? 3 : 1) * dt;
    cam.position.addScaledVector(fwd, f * sp).addScaledVector(right, r * sp).addScaledVector(UP, u * sp);
    if (w.follow && this.you.visible && this.youWorld) {
      tmpV.copy(this.youWorld).add(new THREE.Vector3(0, w.eye - 0.05, 0));
      cam.position.lerp(tmpV, 1 - Math.exp(-dt * 2.5));
    }
  }

  // Screen-constant sprites (sizeAttenuation:false) are sized in world units under an orthographic camera,
  // so rescale them in Plan view to look the same as in perspective views.
  _scaleSprites() {
    const cam = this.camera;
    const f = cam.isOrthographicCamera ? (this.persp.projectionMatrix.elements[5] * (cam.top - cam.bottom)) / cam.zoom / 2 : 1;
    if (f === this._spriteF) return;
    this._spriteF = f;
    const apply = (s) => {
      if (!s.isSprite) return;
      if (!s.userData.baseScale) s.userData.baseScale = s.scale.clone();
      s.scale.copy(s.userData.baseScale).multiplyScalar(f);
    };
    this.markers.children.forEach(apply); this.badges.children.forEach(apply); apply(this.youDot);
  }
  _refreshSpriteScale() { this._spriteF = null; }

  _tick(time, frame) {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.tween) {
      const tw = this.tween; tw.t += dt / tw.dur;
      const e = tw.t >= 1 ? 1 : 1 - Math.pow(1 - tw.t, 3);
      this.persp.position.lerpVectors(tw.p0, tw.p1, e); this.orbit.target.lerpVectors(tw.t0, tw.t1, e);
      if (tw.t >= 1) this.tween = null;
    }
    if (this.mode === 'orbit') {
      if (this.tween || this._needLook) { this.persp.up.set(0, 1, 0); this.persp.lookAt(this.orbit.target); this._needLook = false; this.nav.depth = this.persp.position.distanceTo(this.orbit.target); }
      // wheel/pinch zoom: glide the pending move in over ~100 ms (smooth, no overshoot, no inertia)
      const zp = this.nav.zoomPending;
      if (zp.lengthSq() > 1e-8) {
        const step = zp.clone().multiplyScalar(Math.min(1, dt * 18));
        if (zp.lengthSq() < 1e-4) step.copy(zp);
        zp.sub(step);
        if (!this._guarded(() => { this.persp.position.add(step); this._syncTarget(); })) zp.set(0, 0, 0); // hit the scope: stop zooming out
        this._syncTarget();
      }
    }
    else if (this.mode === 'plan') this.plan.update();
    else if (this.mode === 'walk') this._walkUpdate(dt);
    for (const fn of this.hooks) fn(dt, frame);
    this._scaleSprites();
    this.renderer.render(this.scene, this.camera);
    if ((this._f = (this._f || 0) + 1) % 6 === 0) this.dispatchEvent(new Event('frame'));
  }
}
