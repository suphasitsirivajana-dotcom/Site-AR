// GPS + device orientation (compass / gyro) wrappers.
import * as THREE from 'three';
import { rad, deg, normDeg } from './geo.js';

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
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const Q_X = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // camera looks out the back
export class DeviceOrient extends EventTarget {
  constructor() {
    super();
    this.alpha = 0; this.beta = 0; this.gamma = 0;
    this.absolute = false; this.compass = null; this.alphaOffset = null; this.ready = false; this.listening = false;
    this._euler = new THREE.Euler(); this._q0 = new THREE.Quaternion();
    this._onAbs = (e) => this._handle(e, true);
    this._onRel = (e) => this._handle(e, false);
  }
  get supported() { return typeof window.DeviceOrientationEvent !== 'undefined'; }

  // iOS needs this inside a user gesture
  async requestPermission() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      const r = await DOE.requestPermission();
      if (r !== 'granted') throw new Error('Motion & orientation permission denied');
    }
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
  recalibrate() { this.alphaOffset = null; }

  _handle(e, isAbs) {
    if (e.alpha == null) return;
    if (!isAbs && this.absolute && !Number.isFinite(e.webkitCompassHeading)) return; // prefer absolute stream
    if (isAbs) this.absolute = true;
    this.alpha = e.alpha; this.beta = e.beta || 0; this.gamma = e.gamma || 0;
    if (Number.isFinite(e.webkitCompassHeading)) {
      // iOS: alpha is relative; calibrate an offset from the compass (smoothed)
      this.compass = e.webkitCompassHeading;
      const target = normDeg(360 - e.webkitCompassHeading - e.alpha);
      if (this.alphaOffset === null) this.alphaOffset = target;
      else {
        let d = target - this.alphaOffset; if (d > 180) d -= 360; if (d < -180) d += 360;
        this.alphaOffset = normDeg(this.alphaOffset + d * 0.02);
      }
    } else if (isAbs || e.absolute) {
      this.alphaOffset = 0;
    } else if (this.alphaOffset === null) {
      this.alphaOffset = 0; // relative only: user must trim heading manually
    }
    this.ready = true;
    this.dispatchEvent(new Event('update'));
  }

  get hasTrueNorth() { return this.absolute || this.compass !== null; }

  // earth-frame quaternion of the device camera
  getQuaternion(out = new THREE.Quaternion()) {
    const a = rad(normDeg(this.alpha + (this.alphaOffset || 0)));
    const b = rad(this.beta), g = rad(this.gamma);
    const orient = rad((screen.orientation && screen.orientation.angle) || window.orientation || 0);
    this._euler.set(b, a, -g, 'YXZ');
    out.setFromEuler(this._euler);
    out.multiply(Q_X);
    out.multiply(this._q0.setFromAxisAngle(Z_AXIS, -orient));
    return out;
  }

  // compass heading (deg, clockwise from north) of where the camera / top of the device points
  getHeading() {
    if (!this.ready) return null;
    const q = this.getQuaternion();
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    if (Math.abs(f.y) > 0.85) f.set(0, 1, 0).applyQuaternion(q); // lying flat: use the device top
    return normDeg(deg(Math.atan2(f.x, -f.z)));
  }
}
