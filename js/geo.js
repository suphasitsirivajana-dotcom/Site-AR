// Coordinate + geolocation helpers.
//
// THREE COORDINATE FRAMES are used in SiteAR:
//  1. IFC / project coords  : metres, Z-up, right-handed. This is what we STORE (project JSON, BCF)
//                             and what Revit / Unity / BlenderBIM understand.
//  2. "raw" three.js coords  : metres, Y-up.  raw = (ifc.x, ifc.z, -ifc.y)   (same transform web-ifc applies)
//  3. world (render) coords : raw shifted by a display origin (and rotated in WebXR) to keep floats small.
//
// GEO ANCHOR (one point is enough):
//   anchor = { position:{x,y,z} IFC metres, lat, lon, alt, bearing }
//   bearing = clockwise angle (deg) from TRUE NORTH to the model's +Y axis ("project north").
import * as THREE from 'three';

const R_EARTH = 6378137;
export const rad = (d) => (d * Math.PI) / 180;
export const deg = (r) => (r * 180) / Math.PI;
export const normDeg = (d) => ((d % 360) + 360) % 360;
export const normDeg180 = (d) => { const n = normDeg(d); return n > 180 ? n - 360 : n; };

export const rawToIfc = (v) => ({ x: v.x, y: -v.z, z: v.y });
export const ifcToRaw = (p, out = new THREE.Vector3()) => out.set(p.x, p.z, -p.y);

// lat/lon -> local east/north metres around (lat0, lon0)  (equirectangular, fine for < 2 km)
export function gpsToEN(lat, lon, lat0, lon0) {
  return {
    e: rad(lon - lon0) * R_EARTH * Math.cos(rad(lat0)),
    n: rad(lat - lat0) * R_EARTH
  };
}
export function enToGps(e, n, lat0, lon0) {
  return {
    lat: lat0 + deg(n / R_EARTH),
    lon: lon0 + deg(e / (R_EARTH * Math.cos(rad(lat0))))
  };
}

// GPS -> IFC model coordinates (z = anchor elevation)
export function gpsToModel(anchor, lat, lon) {
  const { e, n } = gpsToEN(lat, lon, anchor.lat, anchor.lon);
  const B = rad(anchor.bearing || 0);
  const mx = e * Math.cos(B) - n * Math.sin(B);
  const my = e * Math.sin(B) + n * Math.cos(B);
  return { x: anchor.position.x + mx, y: anchor.position.y + my, z: anchor.position.z };
}

// IFC model coordinates -> GPS
export function modelToGps(anchor, p) {
  const mx = p.x - anchor.position.x, my = p.y - anchor.position.y;
  const B = rad(anchor.bearing || 0);
  const e = mx * Math.cos(B) + my * Math.sin(B);
  const n = -mx * Math.sin(B) + my * Math.cos(B);
  return enToGps(e, n, anchor.lat, anchor.lon);
}

// Bearing from two points: model vector (dx,dy) observed as GPS vector (e,n)
export function bearingFromPair(dModel, dEN) {
  return normDeg(deg(Math.atan2(dModel.y, dModel.x) - Math.atan2(dEN.n, dEN.e)));
}

// IFC TrueNorth direction ratios (x,y in model coords) -> bearing of model +Y from true north
export function bearingFromTrueNorth(tx, ty) {
  return normDeg(deg(Math.atan2(ty, tx)) - 90);
}

// Heading (deg, clockwise from IFC +Y) of a raw-frame direction vector
export function modelHeadingOfRawDir(v) {
  return normDeg(deg(Math.atan2(v.x, -v.z)));
}

export const fmtM = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');
export const fmtLL = (v) => (Number.isFinite(v) ? v.toFixed(7) : '—');
