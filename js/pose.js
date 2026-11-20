// Camera pose from a square marker (QR) of known size at known model coordinates.
//
//  QR frame:  X = to the right as you read the QR, Y = down (towards the bottom of the QR), Z = X × Y = into the surface.
//  Camera frame (OpenCV): x right, y down, z forward.  A point Xq in the QR frame is  Xc = R·Xq + t.
//
//  Steps: 4 corners (px) → normalised camera coordinates → homography (DLT, 8×8) → [r1 r2 t] → orthonormalise
//         → camera position / axes in the QR frame → rotate into model (IFC) coordinates using how the QR is mounted.
import { normDeg, deg, rad } from './geo.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => mul(a, 1 / (norm(a) || 1));

function solve8(A, b) {
  const n = 8;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    const d = A[i][i];
    if (Math.abs(d) < 1e-12) return null;
    for (let r = i + 1; r < n; r++) {
      const k = A[r][i] / d;
      for (let c = i; c < n; c++) A[r][c] -= k * A[i][c];
      b[r] -= k * b[i];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = s / A[i][i];
  }
  return x;
}

// corners: [TL, TR, BR, BL] in image pixels (as seen by the QR itself, so rotation-invariant);
// S = side length of the QR symbol in metres; f = focal length in px; (cx, cy) = principal point in px.
export function solveSquarePose(corners, S, f, cx, cy) {
  const h = S / 2;
  return solvePlanarPose([[-h, -h], [h, -h], [h, h], [-h, h]], corners, f, cx, cy);
}

// General planar pose: 4 points on the QR plane (obj: [X,Y] in metres from the QR centre, X right, Y down)
// and where they appear in the image (img: [{x,y}] px). Exactly 4 correspondences are used (DLT).
export function solvePlanarPose(obj, corners, f, cx, cy) {
  const nrm = corners.map((p) => [(p.x - cx) / f, (p.y - cy) / f]);
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [X, Y] = obj[i], [x, y] = nrm[i];
    A.push([X, Y, 1, 0, 0, 0, -x * X, -x * Y]); b.push(x);
    A.push([0, 0, 0, X, Y, 1, -y * X, -y * Y]); b.push(y);
  }
  const H = solve8(A, b);
  if (!H) return null;
  const c1 = [H[0], H[3], H[6]], c2 = [H[1], H[4], H[7]], c3 = [H[2], H[5], 1];
  const lam = 2 / (norm(c1) + norm(c2));
  let r1 = mul(c1, lam), r2 = mul(c2, lam), t = mul(c3, lam);
  if (t[2] < 0) { r1 = mul(r1, -1); r2 = mul(r2, -1); t = mul(t, -1); }
  r1 = unit(r1);
  r2 = unit(sub(r2, mul(r1, dot(r1, r2))));
  const r3 = cross(r1, r2);
  // reprojection error (px) — quality check
  let e2 = 0;
  for (let i = 0; i < 4; i++) {
    const p = add(add(mul(r1, obj[i][0]), mul(r2, obj[i][1])), t);
    const dx = cx + (f * p[0]) / p[2] - corners[i].x, dy = cy + (f * p[1]) / p[2] - corners[i].y;
    e2 += dx * dx + dy * dy;
  }
  return {
    r1, r2, r3, t,
    dist: norm(t),
    reproj: Math.sqrt(e2 / 4),
    camPosQR: [-dot(r1, t), -dot(r2, t), -dot(r3, t)],
    camAxesQR: { x: [r1[0], r2[0], r3[0]], y: [r1[1], r2[1], r3[1]], z: [r1[2], r2[2], r3[2]] }
  };
}

// Pose from a detectQR() result: uses the finder/alignment pattern centres (accurate) and falls back to the corners.
export function poseFromDetection(det, S, f, cx, cy) {
  if (det.usable && det.pts.every((p) => p && Number.isFinite(p.x))) {
    const n = det.modules, k = S / n;
    const obj = det.modPts.map(([mx, my]) => [(mx - n / 2) * k, (my - n / 2) * k]);
    const pose = solvePlanarPose(obj, det.pts, f, cx, cy);
    if (pose) return pose;
  }
  return solveSquarePose(det.corners, S, f, cx, cy);
}

// QR axes expressed in model coordinates.
//  floor: QR lies on the floor, its TOP points to model heading ψ (deg clockwise from +Y).
//  wall : QR is on a vertical wall, upright, and its face points to model heading ψ (outward normal).
export function qrAxes(mount, headingDeg) {
  const psi = rad(headingDeg || 0), s = Math.sin(psi), c = Math.cos(psi);
  if (mount === 'wall') return { X: [-c, s, 0], Y: [0, 0, -1], Z: [-s, -c, 0] };
  return { X: [c, -s, 0], Y: [-s, -c, 0], Z: [0, 0, -1] };
}

// cp = { position:{x,y,z} of the QR centre in model coords, mount, heading }
export function poseToModel(pose, cp) {
  const A = qrAxes(cp.mount, cp.heading);
  const m = (v) => [
    A.X[0] * v[0] + A.Y[0] * v[1] + A.Z[0] * v[2],
    A.X[1] * v[0] + A.Y[1] * v[1] + A.Z[1] * v[2],
    A.X[2] * v[0] + A.Y[2] * v[1] + A.Z[2] * v[2]
  ];
  const C = m(pose.camPosQR);
  const fwd = m(pose.camAxesQR.z), top = mul(m(pose.camAxesQR.y), -1);
  const hv = Math.hypot(fwd[0], fwd[1]) < 0.53 ? top : fwd; // looking steeply down/up: use the top of the screen (same rule as AR)
  return {
    position: { x: cp.position.x + C[0], y: cp.position.y + C[1], z: cp.position.z + C[2] },
    forward: fwd,
    heading: normDeg(deg(Math.atan2(hv[0], hv[1])))
  };
}
