// QR control points: generate (for the surveyor to set out on site) and scan (to lock your position).
import jsQR from 'jsqr';
import qrcode from 'qrcode-generator';

// Payload is compact JSON so any QR app shows readable coordinates too.
export function encodeCP(cp, projectId) {
  return JSON.stringify({ t: 'sitear-cp', v: 1, pid: projectId, id: cp.id, n: cp.name,
    x: +cp.position.x.toFixed(4), y: +cp.position.y.toFixed(4), z: +cp.position.z.toFixed(4) });
}
export function decodeCP(text) {
  try {
    const o = JSON.parse(text);
    if (o && o.t === 'sitear-cp' && Number.isFinite(o.x)) return { id: o.id, name: o.n || 'CP', projectId: o.pid, position: { x: o.x, y: o.y, z: o.z } };
  } catch (e) { /* not ours */ }
  return null;
}

export function qrDataURL(text, cell = 8, margin = 4) {
  const q = qrcode(0, 'M'); q.addData(unescape(encodeURIComponent(text))); q.make();
  const n = q.getModuleCount(), size = (n + margin * 2) * cell;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (q.isDark(r, col)) g.fillRect((col + margin) * cell, (r + margin) * cell, cell, cell);
  return c.toDataURL('image/png');
}

// Printable label: QR + name + coordinates + instructions
export async function cpSheet(cp, projectName, payload) {
  const qr = new Image(); qr.src = qrDataURL(payload, 10, 3); await qr.decode();
  const W = 900, H = 1180; const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#0b0d10'; g.fillRect(0, 0, W, 120);
  g.fillStyle = '#38e1ff'; g.font = '700 44px Inter, sans-serif'; g.fillText('SiteAR', 48, 76);
  g.fillStyle = '#fff'; g.font = '500 28px Inter, sans-serif'; g.textAlign = 'right'; g.fillText('CONTROL POINT', W - 48, 74); g.textAlign = 'left';
  const qs = 680; g.drawImage(qr, (W - qs) / 2, 160, qs, qs);
  g.fillStyle = '#0b0d10'; g.font = '700 56px Inter, sans-serif'; g.textAlign = 'center'; g.fillText(cp.name, W / 2, 920);
  g.font = '500 30px "JetBrains Mono", monospace';
  g.fillText(`X ${cp.position.x.toFixed(3)}   Y ${cp.position.y.toFixed(3)}   Z ${cp.position.z.toFixed(3)} m`, W / 2, 975);
  g.fillStyle = '#556070'; g.font = '400 24px Inter, sans-serif';
  g.fillText(projectName.slice(0, 60), W / 2, 1025);
  g.fillText('Fix this label exactly on the surveyed point. Scan in SiteAR → Site → Scan QR.', W / 2, 1090);
  return c.toDataURL('image/png');
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
