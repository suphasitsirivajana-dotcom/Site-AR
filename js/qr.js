// QR control points: generate (for the surveyor to set out on site) and scan (to lock your position).
import jsQR from 'jsqr';
import qrcode from 'qrcode-generator';

// Payload is compact JSON so any QR app shows readable coordinates too.
// s = printed QR side in metres, m = 'floor' | 'wall', h = heading in degrees (see pose.js qrAxes) — needed for camera pose
// COMPACT format on purpose: fewer characters → bigger QR modules → readable from further away / at a steeper angle.
//   S2|<id 8>|x|y|z|size cm|F or W|heading°        e.g.  S2|3f9a1c2e|12.345|7.250|0.000|20|F|0
export function encodeCP(cp, projectId) {
  return ['S2', String(cp.id).replace(/-/g, '').slice(0, 8), cp.position.x.toFixed(3), cp.position.y.toFixed(3), cp.position.z.toFixed(3),
    Math.round((cp.size || 0.15) * 100), cp.mount === 'wall' ? 'W' : 'F', Math.round(cp.heading || 0)].join('|');
}
export function decodeCP(text) {
  if (typeof text === 'string' && text.startsWith('S2|')) {
    const p = text.split('|'), x = +p[2], y = +p[3], z = +p[4];
    if (p.length >= 8 && [x, y, z].every(Number.isFinite)) {
      return { id: p[1], shortId: true, name: `CP-${p[1].slice(0, 4)}`, projectId: null, position: { x, y, z },
        size: (+p[5] || 15) / 100, mount: p[6] === 'W' ? 'wall' : 'floor', heading: +p[7] || 0 };
    }
    return null;
  }
  try {
    const o = JSON.parse(text);
    if (o && o.t === 'sitear-cp' && Number.isFinite(o.x)) {
      return { id: o.id, name: o.n || 'CP', projectId: o.pid, position: { x: o.x, y: o.y, z: o.z },
        size: Number.isFinite(o.s) ? o.s : 0.15, mount: o.m === 'wall' ? 'wall' : 'floor', heading: Number.isFinite(o.h) ? o.h : 0 };
    }
  } catch (e) { /* not ours */ }
  return null;
}

// Find a QR in a video/canvas frame and return its 4 corners [TL, TR, BR, BL] in source pixels.
// jsQR orders the corners by the QR's own finder patterns, so they stay correct when the phone is rotated.
let _dc = null;
export function detectQR(src, maxW = 1280) { // full-ish resolution: pose accuracy depends on how many pixels the QR spans
  const vw = src.videoWidth || src.width, vh = src.videoHeight || src.height;
  if (!vw || !vh) return null;
  const k = Math.min(1, maxW / vw), w = Math.round(vw * k), h = Math.round(vh * k);
  if (!_dc) { _dc = document.createElement('canvas'); _dc.ctx = _dc.getContext('2d', { willReadFrequently: true }); }
  _dc.width = w; _dc.height = h; _dc.ctx.drawImage(src, 0, 0, w, h);
  const r = jsQR(_dc.ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
  if (!r || !r.data) return null;
  const L = r.location, s = 1 / k, P = (p) => ({ x: p.x * s, y: p.y * s });
  // Accurate reference points: the three finder-pattern CENTRES + the alignment-pattern centre (versions ≥ 2).
  // Their module coordinates are known exactly, which is far more reliable than jsQR's extrapolated corners.
  const n = 17 + 4 * r.version;
  const mod = [[3.5, 3.5], [n - 3.5, 3.5], [3.5, n - 3.5], [n - 6.5, n - 6.5]];
  const pts = [L.topLeftFinderPattern, L.topRightFinderPattern, L.bottomLeftFinderPattern, L.bottomRightAlignmentPattern].map(P);
  return {
    text: r.data, vw, vh, version: r.version, modules: n,
    corners: [P(L.topLeftCorner), P(L.topRightCorner), P(L.bottomRightCorner), P(L.bottomLeftCorner)],
    pts, modPts: mod, usable: r.version >= 2
  };
}

export function qrDataURL(text, cell = 8, margin = 4) {
  const q = qrcode(0, 'M'); q.addData(unescape(encodeURIComponent(text))); q.make();
  const n = q.getModuleCount(), size = (n + margin * 2) * cell;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (q.isDark(r, col)) g.fillRect((col + margin) * cell, (r + margin) * cell, cell, cell);
  return c.toDataURL('image/png');
}

// Draw a QR whose SYMBOL (without quiet zone) is exactly `size` px wide at (x, y).
function drawQR(g, text, x, y, size) {
  const q = qrcode(0, 'M'); q.addData(unescape(encodeURIComponent(text))); q.make();
  const n = q.getModuleCount(), m = size / n;
  g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!q.isDark(r, c)) continue;
    const x0 = Math.round(x + c * m), x1 = Math.round(x + (c + 1) * m), y0 = Math.round(y + r * m), y1 = Math.round(y + (r + 1) * m);
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
}

// Printable A4 sheet at REAL scale (8 px per mm): the QR symbol is exactly cp.size wide when printed at 100 %.
// A 10 cm ruler lets the user check the printed scale; the real printed size can be typed into the control point.
export async function cpSheet(cp, projectName, payload) {
  const PX = 8, W = 210 * PX, H = 297 * PX;
  const S = Math.min(0.19, Math.max(0.05, cp.size || 0.15)) * 1000 * PX; // symbol side in px
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#0b0d10'; g.fillRect(0, 0, W, 22 * PX);
  g.fillStyle = '#3b82f6'; g.font = `700 ${7 * PX}px Inter, sans-serif`; g.fillText('SiteAR', 12 * PX, 15 * PX);
  g.fillStyle = '#fff'; g.font = `500 ${4 * PX}px Inter, sans-serif`; g.textAlign = 'right'; g.fillText('CONTROL POINT', W - 12 * PX, 14.5 * PX); g.textAlign = 'left';
  const qy = 40 * PX; drawQR(g, payload, (W - S) / 2, qy, S);
  // marks outside the symbol: which way is "up" on the printed QR
  g.fillStyle = '#556070'; g.font = `500 ${3.2 * PX}px Inter, sans-serif`; g.textAlign = 'center';
  g.fillText('▲ TOP (the side with two large squares)', W / 2, qy - 6 * PX);
  let y = qy + S + 16 * PX;
  g.fillStyle = '#0b0d10'; g.font = `700 ${9 * PX}px Inter, sans-serif`; g.fillText(cp.name, W / 2, y); y += 10 * PX;
  g.font = `500 ${4 * PX}px "JetBrains Mono", monospace`;
  g.fillText(`X ${cp.position.x.toFixed(3)}   Y ${cp.position.y.toFixed(3)}   Z ${cp.position.z.toFixed(3)} m`, W / 2, y); y += 8 * PX;
  g.fillStyle = '#556070'; g.font = `400 ${3.4 * PX}px Inter, sans-serif`;
  const mount = cp.mount === 'wall'
    ? `Wall mounted, upright · QR faces ${Math.round(cp.heading || 0)}° (0° = +Y, 90° = +X)`
    : `On the floor · top of the QR points to ${Math.round(cp.heading || 0)}° (0° = +Y, 90° = +X)`;
  g.fillText(mount, W / 2, y); y += 6 * PX;
  g.fillText(`QR size ${(S / PX / 10).toFixed(1)} cm · ${projectName.slice(0, 50)}`, W / 2, y);
  // 10 cm ruler
  const rx = (W - 100 * PX) / 2, ry = H - 22 * PX;
  g.fillStyle = '#0b0d10'; g.fillRect(rx, ry, 100 * PX, 0.6 * PX);
  for (let i = 0; i <= 10; i++) g.fillRect(rx + i * 10 * PX - 0.3 * PX, ry - (i % 5 ? 2 : 3.5) * PX, 0.6 * PX, (i % 5 ? 2 : 3.5) * PX + 0.6 * PX);
  g.fillStyle = '#556070'; g.font = `400 ${3 * PX}px Inter, sans-serif`;
  g.fillText('This bar must measure 10 cm — if not, print at 100% (Actual size) or enter the measured QR size in SiteAR', W / 2, ry + 8 * PX);
  return c.toDataURL('image/png');
}

// Decode a QR from an image file (photo / screenshot / the PNG sheet). Tries several scales for blurry photos.
export async function decodeImageFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    for (const maxSide of [1600, 1000, 600, 2400]) {
      const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
      const res = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
      if (res && res.data) return res.data;
    }
    return null;
  } finally { URL.revokeObjectURL(url); }
}

// Camera scanning loop. Returns a stop() function.
export async function startScan(video, onCode) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  video.srcObject = stream; video.setAttribute('playsinline', ''); video.muted = true;
  await video.play();
  const c = document.createElement('canvas'); const g = c.getContext('2d', { willReadFrequently: true });
  let stopped = false, frame = 0;
  const loop = () => {
    if (stopped) return;
    if (video.readyState >= 2 && frame++ % 2 === 0) {
      const w = Math.min(720, video.videoWidth), h = Math.round((w * video.videoHeight) / video.videoWidth);
      if (w && h) {
        c.width = w; c.height = h; g.drawImage(video, 0, 0, w, h);
        const res = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
        if (res && res.data) onCode(res.data);
      }
    }
    requestAnimationFrame(loop);
  };
  loop();
  return () => { stopped = true; stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; };
}
