// AR modes
//  • WebXR immersive-ar (Android Chrome / ARCore): real 6-DoF tracking + floor hit-test.
//    Align once: aim the reticle at the reference point on the floor (QR / anchor / your feet) and tap.
//  • Camera AR (iPhone / iPad Safari, any device): live camera + gyro/compass orientation,
//    position from GPS or the last scanned QR control point.
// Both share the same overlay UI and create markups in IFC coordinates.
import * as THREE from 'three';
import { icon } from './icons.js';
import { normDeg180, modelHeadingOfRawDir } from './geo.js';
import { detectQR } from './qr.js';

const UP = new THREE.Vector3(0, 1, 0);

export async function xrARSupported() {
  try { return !!(navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar'))); } catch (e) { return false; }
}

export class ARController extends EventTarget {
  // host: { viewer, orient, video, overlay, getRefs(): [{id,label,raw}], getPositionRaw(): Vector3|null,
  //         getBearing(): deg, settings, onMark(raw, info), toast(msg,kind) }
  constructor(host) {
    super();
    Object.assign(this, host);
    this.active = null; // 'xr' | 'cam'
    this.trim = 0; this.aligned = false;
    this._camQ = new THREE.Quaternion();
  }

  // ------------------------------------------------ overlay UI
  _buildOverlay(kind) {
    const refs = this.getRefs();
    const o = this.overlay;
    o.innerHTML = `
      <div class="ar-top">
        <div class="ar-title"><span class="live-dot"></span>${kind === 'xr' ? 'WebXR AR' : 'Camera AR'}<span class="ar-status" id="ar-status"></span></div>
        <div class="ar-right">
          ${kind === 'cam' ? `<button class="ar-btn qrb" data-ar="tripod" aria-label="Tripod">${icon('anchor')}<span>ขาตั้ง</span></button><button class="ar-btn qrb" data-ar="qrlock" aria-label="QR Lock">${icon('qr')}<span>QR</span></button><button class="ar-btn fwd" data-ar="fwd" aria-label="Step forward">${icon('follow')}<span>เดิน</span></button>` : ''}
          <button class="ar-btn icon-only" data-ar="exit" aria-label="Exit AR">${icon('x')}</button>
        </div>
      </div>
      <div class="ar-reticle-hint" id="ar-hint"></div>
      <div class="ar-bottom">
        <div class="ar-row">
          <label class="ar-field"><span>Reference</span>
            <select id="ar-ref">${refs.map((r) => `<option value="${r.id}">${r.label}</option>`).join('')}</select></label>
          <label class="ar-field grow"><span>Heading trim <b id="ar-trim-v">0°</b></span>
            <input type="range" id="ar-trim" min="-180" max="180" step="0.5" value="0"></label>
          <label class="ar-field"><span>Model</span><input type="range" id="ar-op" min="0.1" max="1" step="0.05" value="${this.settings.arOpacity}"></label>
          ${kind === 'cam' ? `<label class="ar-field"><span>FOV <b id="ar-fov-v">${Math.round(this.settings.camFov)}°</b></span><input type="range" id="ar-fov" min="28" max="75" step="1" value="${this.settings.camFov}"></label>` : ''}
        </div>
        <div class="ar-row actions">
          <button class="ar-btn" data-ar="rotl">${icon('rotL')}<span>-1°</span></button>
          ${kind === 'xr' ? `<button class="ar-btn primary" data-ar="align">${icon('target')}<span>Align here</span></button>` : `<button class="ar-btn primary" data-ar="face">${icon('target')}<span>Face</span></button><button class="ar-btn" data-ar="steps">${icon('walk')}<span>Steps</span></button>`}
          <button class="ar-btn accent" data-ar="mark">${icon('pin')}<span>Mark</span></button>
          ${kind === 'cam' ? `<button class="ar-btn" data-ar="recal">${icon('compass')}<span>Compass</span></button><button class="ar-btn" data-ar="shot">${icon('photo')}<span>Photo</span></button>` : ''}
          <button class="ar-btn" data-ar="rotr">${icon('rotR')}<span>+1°</span></button>
        </div>
      </div>
      <form class="ar-quick" id="ar-quick" hidden>
        <div class="seg" id="ar-qtype">
          <button type="button" data-t="comment" class="on">Comment</button><button type="button" data-t="note">Note</button><button type="button" data-t="issue">Issue</button>
        </div>
        <textarea id="ar-qtext" rows="3" placeholder="Write a comment / note…"></textarea>
        <div class="ar-qphoto" id="ar-qphoto" hidden></div>
        <div class="ar-row actions">
          <button type="button" class="ar-btn" data-ar="qcancel">Cancel</button>
          <button type="submit" class="ar-btn primary">${icon('check')}<span>Save markup</span></button>
        </div>
      </form>`;
    o.hidden = false;
    o.addEventListener('beforexrselect', (e) => e.preventDefault()); // taps on UI must not trigger XR select
    o.onclick = (e) => {
      const b = e.target.closest('[data-ar]'); if (!b) return;
      const a = b.dataset.ar;
      if (a === 'exit') this.stop();
      if (a === 'rotl') this._setTrim(this.trim - 1);
      if (a === 'rotr') this._setTrim(this.trim + 1);
      if (a === 'align') this.alignXR();
      if (a === 'recal') { this.orient.recalibrate(); this._setTrim(0); this.toast('กลับไปใช้เข็มทิศ — ถือเครื่องตั้งตรงและนิ่ง ๆ', 'info'); }
      if (a === 'face') this.alignToFace();
      if (a === 'qrlock') this._toggleQrLock();
      if (a === 'tripod') this.toggleTripod().then(() => this._syncTripod());
      if (a === 'steps') this.toggleSteps().then(() => this._syncSteps());
      if (a === 'mark') this._beginMark();
      if (a === 'shot') this._beginMark(true);
      if (a === 'qcancel') this._endMark();
    };
    // ▲ walk button: tap = one step, hold = keep walking (backup for when the step counter misses steps)
    const fb = o.querySelector('[data-ar=fwd]');
    if (fb) {
      let tm = null; const go = () => this.manualStep && this.manualStep();
      const stop = () => { clearInterval(tm); tm = null; };
      fb.addEventListener('pointerdown', (e) => { e.preventDefault(); go(); tm = setInterval(go, 450); });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => fb.addEventListener(ev, stop));
    }
    o.querySelector('#ar-trim').oninput = (e) => this._setTrim(+e.target.value, false);
    const fv = o.querySelector('#ar-fov');
    if (fv) fv.oninput = (e) => { // make the virtual lens match the phone camera: the model's size follows this slider
      this.settings.camFov = +e.target.value; this.viewer.persp.fov = +e.target.value; this.viewer.persp.updateProjectionMatrix();
      o.querySelector('#ar-fov-v').textContent = `${Math.round(+e.target.value)}°`;
    };
    o.querySelector('#ar-op').oninput =(e) => { this.settings.arOpacity = +e.target.value; this.viewer.setOpacityFactor(+e.target.value); };
    o.querySelector('#ar-qtype').onclick = (e) => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      o.querySelectorAll('#ar-qtype button').forEach((x) => x.classList.toggle('on', x === b));
    };
    o.querySelector('#ar-quick').onsubmit = (e) => { e.preventDefault(); this._saveMark(); };
    o.querySelector('#ar-ref').onchange = () => { if (this.active === 'xr' && this.aligned) this.alignXR(this._lastW); };
  }
  _syncTripod() { const b = this.overlay.querySelector('[data-ar=tripod]'); if (b) b.classList.toggle('on', !!(this.tripodActive && this.tripodActive())); }
  _syncSteps() {
    const b = this.overlay.querySelector('[data-ar=steps]'); if (!b) return;
    b.classList.add('on');
    const l = b.querySelector('span'); if (l && this.trackLabel) l.textContent = this.trackLabel();
  }

  // Freeze the compass: after the user aligned the view, only the gyro (smooth, drift-free over minutes)
  // drives rotation. A wobbling compass is what makes the model "lose its direction" when you turn.
  _freezeCompass() {
    if (this.orient.yawOffset === null) this.orient.yawOffset = 0;
    this.orient.manual = true;
  }
  // rotate the overlay so the camera's current model-heading equals `target` (deg clockwise from model +Y)
  // useTop: when the camera looks steeply up/down, use the top of the screen as the heading reference (same rule as pose.js)
  alignToHeading(target, useTop = false, gain = 1) {
    const q = this.active === 'cam' && this._camQ ? this._camQ : this.viewer.persp.quaternion; // the TARGET orientation, not the smoothed one
    let f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    if (Math.abs(f.y) > 0.85) {
      if (!useTop) { this.toast('เงยหน้าเครื่องให้มองระดับสายตาก่อน แล้วกดอีกครั้ง', 'warn'); return false; }
      f = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    }
    const hm = modelHeadingOfRawDir(f);
    this._freezeCompass();
    this._setTrim(this.trim + gain * normDeg180(hm - target)); // +trim turns the camera CCW → heading decreases
    return true;
  }

  // ---- QR Lock: find the QR in the live video, compute the camera pose from it, snap position + heading
  _toggleQrLock() {
    this.qrLock = !this.qrLock;
    const b = this.overlay.querySelector('[data-ar=qrlock]'); if (b) b.classList.toggle('on', this.qrLock);
    this._qrLabel(this.qrLock ? 'เล็งกล้องไปที่ QR (ห่าง ≤ 2 m)' : '');
    this._qt = 0;
  }
  _qrLabel(t) { const el = this.overlay.querySelector('#ar-hint'); if (el) { el.textContent = t; el.hidden = !t; } }
  _qrTick(dt) {
    if (!this.qrLock || !this.onQrDetect) return;
    this._qt = (this._qt || 0) + dt;
    if (this._qt < 0.3) return; // ≥ 300 ms: the smoothed camera has time to settle between corrections
    this._qt = 0;
    const v = this.video;
    if (!v.videoWidth) return;
    let det = null;
    try { det = detectQR(v); } catch (e) { det = null; }
    if (!det) { if (performance.now() - (this._qrSeen || 0) > 2000) this._qrLabel('ไม่เจอ QR — เล็งให้เห็นเต็มกรอบ ห่าง ≤ 2 m'); return; }
    const cv = this.viewer.canvas, cw = cv.clientWidth, ch = cv.clientHeight;
    const s = Math.max(cw / det.vw, ch / det.vh); // object-fit: cover
    const f = (ch / 2) / Math.tan(THREE.MathUtils.degToRad(this.viewer.persp.fov) / 2) / s; // focal length in VIDEO pixels
    const res = this.onQrDetect(det, { f, cx: det.vw / 2, cy: det.vh / 2 });
    if (!res) return;
    if (res.ok) {
      this._qrSeen = performance.now();
      this.alignToHeading(res.heading, true, res.gain * 0.6);
      this._qrLabel(res.msg);
    } else this._qrLabel(res.msg);
  }
  alignToFace() {
    const h = this.getFaceHeading && this.getFaceHeading();
    if (h == null) return this.toast('ยังไม่มี Face Point — ออกจาก AR แล้วไป Site → Face Point (ต้องตั้งจุดที่ยืนด้วย)', 'warn', 5000);
    if (this.alignToHeading(h)) this.toast('ล็อกทิศแล้ว — หมุนตัวได้เลย', 'ok', 2500);
    // (the QR Lock path passes useTop + a smoothing gain)
  }
  // one-finger drag left/right turns the model overlay to match the real world (the drag direction = the way the model moves)
  _bindDrag() {
    const c = this.viewer.canvas; let d = null;
    this._pd = (e) => { if (this.active === 'cam' && !this._pending) d = { id: e.pointerId, x: e.clientX }; };
    this._pm = (e) => {
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x; d.x = e.clientX;
      this._freezeCompass();
      this._setTrim(this.trim + dx * 0.12);
    };
    this._pu = () => { d = null; };
    c.addEventListener('pointerdown', this._pd); c.addEventListener('pointermove', this._pm);
    c.addEventListener('pointerup', this._pu); c.addEventListener('pointercancel', this._pu);
  }
  _unbindDrag() {
    const c = this.viewer.canvas;
    c.removeEventListener('pointerdown', this._pd); c.removeEventListener('pointermove', this._pm);
    c.removeEventListener('pointerup', this._pu); c.removeEventListener('pointercancel', this._pu);
  }

  _status(t) { const s = this.overlay.querySelector('#ar-status'); if (s) s.textContent = t; }
  _hint(t) { const s = this.overlay.querySelector('#ar-hint'); if (s) { s.textContent = t; s.hidden = !t; } }
  _setTrim(v, syncSlider = true) {
    this.trim = normDeg180(v);
    const s = this.overlay.querySelector('#ar-trim'); if (s && syncSlider) s.value = this.trim;
    const l = this.overlay.querySelector('#ar-trim-v'); if (l) l.textContent = `${this.trim.toFixed(1)}°`;
    if (this.active === 'xr' && this.aligned) this.alignXR(this._lastW);
    this.viewer.headingTrim = this.trim;
  }
  _refRaw() {
    const id = this.overlay.querySelector('#ar-ref')?.value;
    const r = this.getRefs().find((x) => x.id === id) || this.getRefs()[0];
    return r ? r.raw.clone() : new THREE.Vector3();
  }

  // ------------------------------------------------ marking (both modes)
  _beginMark(withPhoto = false) {
    let raw = null, info = {};
    if (this.active === 'xr') {
      if (!this.reticle.visible) { this.toast('Point at a surface first', 'warn'); return; }
      const w = new THREE.Vector3().setFromMatrixPosition(this.reticle.matrix);
      raw = this.viewer.toRaw(w);
      // try to snap to a model element under the reticle
      const cam = this.viewer.renderer.xr.getCamera();
      const rc = new THREE.Raycaster(cam.getWorldPosition(new THREE.Vector3()), w.clone().sub(cam.getWorldPosition(new THREE.Vector3())).normalize());
      const hit = this.viewer.pickRay(rc, { markers: false });
      if (hit && hit.type === 'model' && hit.point.distanceTo(w) < 0.6) info = { eid: hit.eid, modelId: hit.modelId };
    } else {
      // camera AR: centre of the screen
      const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(0, 0), this.viewer.persp);
      const hit = this.viewer.pickRay(rc, { markers: false });
      if (!hit) { this.toast('Nothing under the crosshair', 'warn'); return; }
      raw = this.viewer.toRaw(hit.point);
      if (hit.type === 'model') info = { eid: hit.eid, modelId: hit.modelId };
    }
    this._pending = { raw, info, photo: withPhoto ? this._captureComposite() : null };
    const q = this.overlay.querySelector('#ar-quick');
    const ph = this.overlay.querySelector('#ar-qphoto');
    ph.hidden = !this._pending.photo; ph.innerHTML = this._pending.photo ? `<img src="${this._pending.photo}" alt="">` : '';
    q.hidden = false;
    this.overlay.querySelector('.ar-bottom').hidden = true;
    setTimeout(() => this.overlay.querySelector('#ar-qtext').focus(), 50);
  }
  _endMark() {
    this._pending = null;
    this.overlay.querySelector('#ar-quick').hidden = true;
    this.overlay.querySelector('.ar-bottom').hidden = false;
    this.overlay.querySelector('#ar-qtext').value = '';
  }
  _saveMark() {
    if (!this._pending) return;
    const type = this.overlay.querySelector('#ar-qtype .on')?.dataset.t || 'comment';
    const text = this.overlay.querySelector('#ar-qtext').value.trim();
    this.onMark(this._pending.raw, { ...this._pending.info, type, text, photo: this._pending.photo, source: this.active === 'xr' ? 'ar-xr' : 'ar-camera' });
    this._endMark();
    this.toast('Markup saved', 'ok');
  }
  _captureComposite() {
    try {
      const v = this.video, cv = this.viewer.canvas;
      const W = cv.width, H = cv.height; const c = document.createElement('canvas');
      const k = Math.min(1, 1600 / Math.max(W, H)); c.width = Math.round(W * k); c.height = Math.round(H * k);
      const g = c.getContext('2d');
      if (v && v.videoWidth) { // object-fit: cover
        const s = Math.max(c.width / v.videoWidth, c.height / v.videoHeight);
        const dw = v.videoWidth * s, dh = v.videoHeight * s;
        g.drawImage(v, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
      }
      this.viewer.renderer.render(this.viewer.scene, this.viewer.camera);
      g.drawImage(cv, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.82);
    } catch (e) { return null; }
  }

  // ------------------------------------------------ WebXR
  async startXR() {
    const v = this.viewer;
    this.heading0 = this.orient.ready && this.orient.hasTrueNorth ? this.orient.getHeading() : null;
    this._buildOverlay('xr');
    let session;
    try {
      session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay', 'local-floor'], domOverlay: { root: this.overlay }
      });
    } catch (e) { this.overlay.hidden = true; throw e; }
    this.session = session; this.active = 'xr'; this.aligned = false;
    v.renderer.xr.setReferenceSpaceType('local');
    await v.renderer.xr.setSession(session);
    const viewerSpace = await session.requestReferenceSpace('viewer');
    this.hitSource = await session.requestHitTestSource({ space: viewerSpace });

    this._saved = { pos: v.root.position.clone(), quat: v.root.quaternion.clone(), mode: v.mode };
    v.setMode('xr');
    v.root.visible = false;
    v.setOpacityFactor(this.settings.arOpacity);
    this.reticle = new THREE.Mesh(new THREE.RingGeometry(0.09, 0.12, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x38e1ff }));
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.02, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.reticle.add(dot);
    this.reticle.matrixAutoUpdate = false; this.reticle.visible = false;
    v.scene.add(this.reticle);
    this._xrHook = (dt, frame) => this._xrFrame(frame);
    v.hooks.add(this._xrHook);
    session.addEventListener('select', () => { if (!this._pending) { if (!this.aligned) this.alignXR(); else this._beginMark(); } });
    session.addEventListener('end', () => this._cleanupXR());
    this._hint('Move the phone slowly to find the floor, aim the ring at the reference point, then tap “Align here”.');
    this._status(this.heading0 == null ? 'no compass — use heading trim' : `compass ${this.heading0.toFixed(0)}°`);
  }
  _xrFrame(frame) {
    if (!frame || !this.hitSource) return;
    const ref = this.viewer.renderer.xr.getReferenceSpace();
    const hits = frame.getHitTestResults(this.hitSource);
    if (hits.length) {
      const pose = hits[0].getPose(ref);
      this.reticle.visible = true; this.reticle.matrix.fromArray(pose.transform.matrix);
    } else this.reticle.visible = false;
  }
  alignXR(W) {
    const v = this.viewer;
    if (!W) {
      if (!this.reticle || !this.reticle.visible) { this.toast('No surface found yet — move the phone slowly', 'warn'); return; }
      W = new THREE.Vector3().setFromMatrixPosition(this.reticle.matrix);
    }
    this._lastW = W.clone();
    const P = this._refRaw();
    // XR -Z = device forward at session start (heading0). Model +Y (raw -Z) must point at `bearing`.
    const theta = THREE.MathUtils.degToRad((this.heading0 ?? 0) - this.getBearing() + this.trim);
    v.root.quaternion.setFromAxisAngle(UP, theta);
    v.root.position.copy(W).sub(P.applyAxisAngle(UP, theta));
    v.root.updateMatrixWorld(true);
    v.root.visible = true;
    this.aligned = true;
    this._hint('');
    this._status(`aligned · trim ${normDeg180(this.trim).toFixed(1)}°`);
  }
  _cleanupXR() {
    const v = this.viewer;
    v.hooks.delete(this._xrHook);
    if (this.reticle) { v.scene.remove(this.reticle); this.reticle = null; }
    if (this.hitSource) { try { this.hitSource.cancel(); } catch (e) { /* ignore */ } this.hitSource = null; }
    v.root.visible = true;
    if (this._saved) { v.root.position.copy(this._saved.pos); v.root.quaternion.copy(this._saved.quat); v.root.updateMatrixWorld(true); }
    v.setOpacityFactor(1);
    v.setMode(this._saved && this._saved.mode !== 'xr' ? this._saved.mode : 'orbit');
    this.overlay.hidden = true; this.active = null; this.session = null;
    setTimeout(() => v.resize(), 50);
    this.dispatchEvent(new Event('end'));
  }

  // ------------------------------------------------ Camera AR (iOS / fallback)
  async startCamera() {
    const v = this.viewer;
    try { await this.orient.requestPermission(); this.orient.start(); } // must run inside the click handler on iOS
    catch (e) { this.toast('No motion sensor access — view will not follow the device (use heading trim)', 'warn', 4500); }
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    this.stream = stream;
    this.video.srcObject = stream; this.video.hidden = false;
    await this.video.play();
    this._buildOverlay('cam');
    this.active = 'cam';
    this._saved = { mode: v.mode, fov: v.persp.fov };
    v.setMode('cam-ar');
    v.persp.fov = this.settings.camFov; v.persp.updateProjectionMatrix();
    v.setOpacityFactor(this.settings.arOpacity);
    document.body.classList.add('cam-ar');
    this._camHook = (dt) => this._camFrame(dt);
    v.hooks.add(this._camHook);
    this._bindDrag();
    v.headingTrim = this.trim; // keep the walking direction (step counter) in sync with the overlay trim
    this._status(this.orient.hasTrueNorth ? 'compass OK' : 'waiting for compass…');
    this._hint(this.getPositionRaw()
      ? 'โมเดลไม่ตรงกับของจริง? ลากนิ้วซ้าย/ขวาเพื่อหมุนให้ตรง · หรือหันไปที่ Face Point แล้วกด Face'
      : 'ยังไม่มีตำแหน่ง — ตั้งจุดที่ยืน (Site → I\'m Here), Scan QR หรือเปิด GPS');
    setTimeout(() => this._hint(''), 8000);
    this._syncSteps(); this._syncTripod();
  }
  _camFrame(dt) {
    const v = this.viewer, cam = v.persp;
    const raw = this.getPositionRaw() || this._refRaw();
    const target = v.toWorld(raw).add(new THREE.Vector3(0, this.settings.eye, 0));
    cam.position.lerp(target, 1 - Math.exp(-dt * 4));
    if (this.orient.ready) {
      const q = this.orient.getQuaternion();
      const qy = new THREE.Quaternion().setFromAxisAngle(UP, THREE.MathUtils.degToRad(this.getBearing() + this.trim));
      this._camQ.copy(qy.multiply(q));
      cam.quaternion.slerp(this._camQ, 1 - Math.exp(-dt * 12));
    }
    this._qrTick(dt);
    if ((this._st = (this._st || 0) + dt) > 0.3) {
      this._st = 0;
      const hd = this.orient.hasTrueNorth ? `${this.orient.getHeading()?.toFixed(0)}°` : 'ไม่มีเข็มทิศ';
      const stp = this.stepsActive && this.stepsActive() ? ` · ${this.stepCount()} ก้าว` : ' · Steps ปิด';
      this._status(`${hd}${stp}`);
      this._syncSteps();
    }
  }
  _cleanupCam() {
    const v = this.viewer;
    this.qrLock = false;
    this._unbindDrag();
    v.hooks.delete(this._camHook);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null; this.video.srcObject = null; this.video.hidden = true;
    document.body.classList.remove('cam-ar');
    v.persp.fov = this._saved ? this._saved.fov : 55; v.persp.updateProjectionMatrix();
    v.setOpacityFactor(1);
    v.setMode('walk');
    this.overlay.hidden = true; this.active = null;
    this.dispatchEvent(new Event('end'));
  }

  stop() {
    if (this.active === 'xr' && this.session) this.session.end();
    else if (this.active === 'cam') this._cleanupCam();
  }
}
