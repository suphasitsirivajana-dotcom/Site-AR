// GPS + device orientation (compass / gyro) + step counter.
import * as THREE from 'three';
import { rad, deg, normDeg, normDeg180 } from './geo.js';

// ---------------------------------------------------------------- GPS
export class GPS extends EventTarget {
  constructor() { super(); this.watchId = null; this.last = null; this.error = null; }
  get active() { return this.watchId !== null; }
  start() {
    if (this.active) return;
    if (!('geolocation' in navigator)) { this.error = 'Geolocation not available'; this._emit(); return; }
    this.watchId = navigator.geolocation.watchPosition(
      (p) => {
        this.error = null;
        this.last = { lat: p.coords.latitude, lon: p.coords.longitude, alt: p.coords.altitude, acc: p.coords.accuracy, heading: p.coords.heading, t: p.timestamp };
        this._emit();
      },
      (e) => { this.error = e.message || 'GPS error'; this._emit(); },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 }
    );
  }
  stop() { if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId); this.watchId = null; this._emit(); }
  _emit() { this.dispatchEvent(new Event('update')); }

  // Average readings for `seconds` (weighted by 1/acc^2). Starts GPS if needed.
  average(seconds, onProgress) {
    const wasActive = this.active;
    this.start();
    return new Promise((resolve, reject) => {
      const samples = [];
      const onUpd = () => { if (this.last && Date.now() - this.last.t < 3000) { samples.push(this.last); onProgress && onProgress(samples.length, this.last); } };
      this.addEventListener('update', onUpd);
      setTimeout(() => {
        this.removeEventListener('update', onUpd);
        if (!wasActive) this.stop();
        if (!samples.length) { reject(new Error(this.error || 'No GPS fix — move to open sky and try again')); return; }
        let w = 0, lat = 0, lon = 0, alt = 0, altW = 0;
        for (const s of samples) {
          const k = 1 / Math.max(1, s.acc) ** 2; w += k; lat += s.lat * k; lon += s.lon * k;
          if (Number.isFinite(s.alt)) { alt += s.alt * k; altW += k; }
        }
        const best = Math.min(...samples.map((s) => s.acc));
        resolve({ lat: lat / w, lon: lon / w, alt: altW ? alt / altW : null, acc: best, n: samples.length });
      }, seconds * 1000);
    });
  }
}

// ---------------------------------------------------------------- Orientation
// Produces a quaternion in an earth frame where -Z = TRUE NORTH, +X = east, +Y = up.
// yawOffset (deg, clockwise) is added to the raw heading: it comes from the iOS compass, from the
// absolute-orientation stream (0), or from a manual alignment (setHeadingNow).
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Q_X = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // camera looks out the back
export class DeviceOrient extends EventTarget {
  constructor() {
    super();
    this.alpha = 0; this.beta = 0; this.gamma = 0;
    this.absolute = false; this.compass = null; this.yawOffset = null; this.manual = false;
    this.ready = false; this.listening = false;
    this._euler = new THREE.Euler(); this._q0 = new THREE.Quaternion(); this._qy = new THREE.Quaternion(); this._tmp = new THREE.Quaternion();
    this._onAbs = (e) => this._handle(e, true);
    this._onRel = (e) => this._handle(e, false);
  }
  get supported() { return typeof window.DeviceOrientationEvent !== 'undefined'; }

  // iOS needs this inside a user gesture. Both permissions are requested in the same tick
  // (one prompt "Motion & Orientation Access" covers orientation + step counting).
  async requestPermission() {
    const DOE = window.DeviceOrientationEvent, DME = window.DeviceMotionEvent;
    const reqs = [];
    if (DOE && typeof DOE.requestPermission === 'function') reqs.push(DOE.requestPermission());
    if (DME && typeof DME.requestPermission === 'function') reqs.push(DME.requestPermission());
    if (!reqs.length) return;
    const res = await Promise.all(reqs.map((p) => p.catch(() => 'denied')));
    if (res.some((r) => r !== 'granted')) throw new Error('Motion & orientation permission denied');
  }
  start() {
    if (this.listening) return;
    this.listening = true;
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', this._onAbs);
    window.addEventListener('deviceorientation', this._onRel);
  }
  stop() {
    this.listening = false;
    window.removeEventListener('deviceorientationabsolute', this._onAbs);
    window.removeEventListener('deviceorientation', this._onRel);
  }
  recalibrate() { this.yawOffset = null; this.manual = false; }

  _handle(e, isAbs) {
    if (e.alpha == null) return;
    if (!isAbs && this.absolute && !Number.isFinite(e.webkitCompassHeading)) return; // prefer absolute stream
    if (isAbs) this.absolute = true;
    this.alpha = e.alpha; this.beta = e.beta || 0; this.gamma = e.gamma || 0;
    if (Number.isFinite(e.webkitCompassHeading)) {
      this.compass = e.webkitCompassHeading;
      if (!this.manual) this._calibrate(this.compass);
    } else if (!this.manual) {
      if (isAbs || e.absolute) this.yawOffset = 0;
      else if (this.yawOffset === null) this.yawOffset = 0; // relative only: use heading trim / Face Point
    }
    this.ready = true;
    this.dispatchEvent(new Event('update'));
  }

  // raw device rotation (no yaw correction)
  _rawQuaternion(out) {
    const a = rad(this.alpha), b = rad(this.beta), g = rad(this.gamma);
    const orient = rad((screen.orientation && screen.orientation.angle) || window.orientation || 0);
    this._euler.set(b, a, -g, 'YXZ');
    out.setFromEuler(this._euler);
    out.multiply(Q_X);
    out.multiply(this._q0.setFromAxisAngle(Z_AXIS, -orient));
    return out;
  }
  // heading (deg clockwise from north) of where the camera points; if it points at the floor/sky, of the device top
  _headingOf(q) {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    if (Math.abs(f.y) > 0.85) f.set(0, 1, 0).applyQuaternion(q);
    return normDeg(deg(Math.atan2(f.x, -f.z)));
  }
  // iOS: alpha is relative, so derive the yaw offset from webkitCompassHeading using the FULL rotation
  // (alpha alone is wrong when the phone is held upright — that is the usual AR pose).
  _calibrate(compass) {
    const raw = this._headingOf(this._rawQuaternion(this._tmp));
    const d = normDeg180(compass - raw);
    if (this.yawOffset === null) this.yawOffset = d;
    else this.yawOffset = normDeg180(this.yawOffset + normDeg180(d - this.yawOffset) * 0.05);
  }
  // make the camera heading right now equal `heading` (deg clockwise from TRUE NORTH)
  setHeadingNow(heading) {
    const raw = this._headingOf(this._rawQuaternion(this._tmp));
    this.yawOffset = normDeg180(heading - raw);
    this.manual = true;
  }

  get hasTrueNorth() { return this.manual || this.absolute || this.compass !== null; }

  // earth-frame quaternion of the device camera
  getQuaternion(out = new THREE.Quaternion()) {
    this._rawQuaternion(out);
    const off = this.yawOffset || 0;
    if (off) out.premultiply(this._qy.setFromAxisAngle(Y_AXIS, -rad(off))); // clockwise = negative rotation about +Y
    return out;
  }

  // compass heading (deg, clockwise from north) of where the camera / top of the device points
  getHeading() {
    if (!this.ready) return null;
    return this._headingOf(this.getQuaternion(this._tmp));
  }
}

// ---------------------------------------------------------------- Step counter (dead reckoning)
// Detects steps from the accelerometer: high-pass the acceleration magnitude, count upward threshold crossings
// at most every 300 ms. Typical walking with a phone in hand gives peaks of 2–4 m/s².
export class StepTracker extends EventTarget {
  constructor() {
    super();
    this.active = false; this.count = 0; this.threshold = 1.3;
    this._ema = 9.81; this._sm = 0; this._prev = 0; this._last = 0;
    this._on = (e) => this._motion(e);
  }
  get supported() { return typeof window.DeviceMotionEvent !== 'undefined'; }
  async requestPermission() {
    const DME = window.DeviceMotionEvent;
    if (DME && typeof DME.requestPermission === 'function') {
      const r = await DME.requestPermission();
      if (r !== 'granted') throw new Error('Motion permission denied');
    }
  }
  start() { if (this.active) return; this.active = true; this.count = 0; window.addEventListener('devicemotion', this._on); }
  stop() { this.active = false; window.removeEventListener('devicemotion', this._on); }
  _motion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a) return;
    const m = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
    this._ema += (m - this._ema) * 0.02;       // slow mean ≈ gravity
    this._sm = this._sm * 0.6 + (m - this._ema) * 0.4; // smoothed high-pass
    const t = e.timeStamp || performance.now();
    if (this._sm > this.threshold && this._prev <= this.threshold && t - this._last > 300) {
      this._last = t; this.count++;
      this.dispatchEvent(new Event('step'));
    }
    this._prev = this._sm;
  }
}
