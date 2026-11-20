// BCF 3.0 (buildingSMART BIM Collaboration Format) export / import.
// Opens in: Revit (BCF Manager / BIMcollab Zoom add-in), Navisworks, Solibri, BIMcollab, Bonsai/BlenderBIM, Trimble Connect.
import JSZip from 'jszip';
import { uuid, STATUSES, PRIORITIES, MARKUP_TYPES } from './project.js';

const X = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const f = (n) => (Number.isFinite(n) ? n.toFixed(6) : '0');
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n';
const TAG = '[SiteAR]';

function dataUrlParts(d) {
  const m = /^data:image\/(png|jpe?g);base64,(.*)$/.exec(d || '');
  return m ? { ext: m[1] === 'png' ? 'png' : 'jpg', b64: m[2] } : null;
}

function norm(v) { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; }

// camera looking at the markup position, reusing the saved viewpoint's eye position when we have one
function cameraFor(m) {
  const vp = m.viewpoint;
  let eye = vp && vp.position;
  const tgt = m.position;
  if (!eye || Math.hypot(eye.x - tgt.x, eye.y - tgt.y, eye.z - tgt.z) < 0.2) eye = { x: tgt.x - 6, y: tgt.y - 6, z: tgt.z + 4 };
  const dir = norm({ x: tgt.x - eye.x, y: tgt.y - eye.y, z: tgt.z - eye.z });
  // up vector perpendicular to dir, as close to +Z as possible
  const zx = { x: 0, y: 0, z: 1 };
  const dz = dir.x * zx.x + dir.y * zx.y + dir.z * zx.z;
  let up = norm({ x: zx.x - dir.x * dz, y: zx.y - dir.y * dz, z: zx.z - dir.z * dz });
  if (!Number.isFinite(up.x)) up = { x: 0, y: 1, z: 0 };
  return { eye, dir, up, fov: (vp && vp.fov) || 60, aspect: (vp && vp.aspect) || 1.6, plan: vp && vp.mode === 'plan', orthoHeight: vp && vp.orthoHeight };
}

function viewpointXml(guid, m, snapshotName) {
  const c = cameraFor(m);
  const comps = m.element && m.element.guid
    ? `<Selection><Component IfcGuid="${X(m.element.guid)}"/></Selection>` : '';
  const cam = `<CameraViewPoint><X>${f(c.eye.x)}</X><Y>${f(c.eye.y)}</Y><Z>${f(c.eye.z)}</Z></CameraViewPoint>` +
    `<CameraDirection><X>${f(c.dir.x)}</X><Y>${f(c.dir.y)}</Y><Z>${f(c.dir.z)}</Z></CameraDirection>` +
    `<CameraUpVector><X>${f(c.up.x)}</X><Y>${f(c.up.y)}</Y><Z>${f(c.up.z)}</Z></CameraUpVector>`;
  const camera = c.plan && c.orthoHeight
    ? `<OrthogonalCamera>${cam}<ViewToWorldScale>${f(c.orthoHeight)}</ViewToWorldScale><AspectRatio>${f(c.aspect)}</AspectRatio></OrthogonalCamera>`
    : `<PerspectiveCamera>${cam}<FieldOfView>${f(c.fov)}</FieldOfView><AspectRatio>${f(c.aspect)}</AspectRatio></PerspectiveCamera>`;
  return `${XML}<VisualizationInfo Guid="${guid}"><Components>${comps}<Visibility DefaultVisibility="true"/></Components>${camera}</VisualizationInfo>`;
}

function describe(m) {
  const p = m.position;
  let s = m.text || '';
  s += `\n\n${TAG} position=${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`;
  if (m.element && m.element.guid) s += ` element=${m.element.guid}`;
  if (m.gps) s += ` gps=${m.gps.lat.toFixed(7)},${m.gps.lon.toFixed(7)}`;
  s += ` source=${m.source} number=${m.number}${m.locked ? ' locked=1' : ''}`;
  return s.trim();
}

export async function exportBCF(project, author = 'SiteAR') {
  const zip = new JSZip();
  zip.file('bcf.version', `${XML}<Version VersionId="3.0"/>`);
  const users = [...new Set(project.markups.flatMap((m) => [m.author, m.assignedTo, ...m.replies.map((r) => r.author)]).filter(Boolean))];
  zip.file('extensions.xml', `${XML}<Extensions>` +
    `<TopicTypes>${Object.values(MARKUP_TYPES).map((t) => `<TopicType>${t.label}</TopicType>`).join('')}</TopicTypes>` +
    `<TopicStatuses>${Object.values(STATUSES).map((s) => `<TopicStatus>${s.bcf}</TopicStatus>`).join('')}</TopicStatuses>` +
    `<Priorities>${Object.values(PRIORITIES).map((p) => `<Priority>${p}</Priority>`).join('')}</Priorities>` +
    `<TopicLabels><TopicLabel>SiteAR</TopicLabel><TopicLabel>AR</TopicLabel><TopicLabel>Site</TopicLabel></TopicLabels>` +
    (users.length ? `<Users>${users.map((u) => `<User>${X(u)}</User>`).join('')}</Users>` : '') +
    `</Extensions>`);
  zip.file('project.bcfp', `${XML}<ProjectInfo><Project ProjectId="${project.id}"><Name>${X(project.name)}</Name></Project></ProjectInfo>`);

  for (const m of project.markups) {
    const dir = zip.folder(m.id);
    const vps = [];
    // main viewpoint (+ snapshot of the 3D view)
    const vpGuid = uuid();
    const snap = dataUrlParts(m.snapshot);
    dir.file('viewpoint.bcfv', viewpointXml(vpGuid, m));
    if (snap) dir.file(`snapshot.${snap.ext}`, snap.b64, { base64: true });
    vps.push({ guid: vpGuid, file: 'viewpoint.bcfv', snapshot: snap ? `snapshot.${snap.ext}` : null });
    // site photos as extra viewpoints (same camera, photo as snapshot)
    m.photos.forEach((ph, i) => {
      const p = dataUrlParts(ph); if (!p) return;
      const g = uuid();
      dir.file(`photo_${i + 1}.bcfv`, viewpointXml(g, m));
      dir.file(`photo_${i + 1}.${p.ext}`, p.b64, { base64: true });
      vps.push({ guid: g, file: `photo_${i + 1}.bcfv`, snapshot: `photo_${i + 1}.${p.ext}` });
    });

    const status = (STATUSES[m.status] || STATUSES.open).bcf;
    const type = (MARKUP_TYPES[m.type] || MARKUP_TYPES.comment).label;
    const comments = [{ id: uuid(), author: m.author || author, date: m.createdAt, text: m.text || m.title || type, vp: vpGuid },
      ...m.replies.map((r) => ({ id: r.id, author: r.author, date: r.date, text: r.text }))];
    const xml = `${XML}<Markup><Topic Guid="${m.id}" TopicType="${X(type)}" TopicStatus="${X(status)}">` +
      `<Title>${X(m.title || `${type} #${m.number}`)}</Title>` +
      `<Priority>${X(PRIORITIES[m.priority] || 'Normal')}</Priority>` +
      `<Index>${m.number}</Index>` +
      `<Labels><Label>SiteAR</Label><Label>${X(m.source)}</Label></Labels>` +
      `<CreationDate>${m.createdAt}</CreationDate><CreationAuthor>${X(m.author || author)}</CreationAuthor>` +
      `<ModifiedDate>${m.modifiedAt}</ModifiedDate><ModifiedAuthor>${X(m.author || author)}</ModifiedAuthor>` +
      (m.assignedTo ? `<AssignedTo>${X(m.assignedTo)}</AssignedTo>` : '') +
      `<Description>${X(describe(m))}</Description>` +
      `<Comments>${comments.map((c) => `<Comment Guid="${c.id}"><Date>${c.date}</Date><Author>${X(c.author || author)}</Author><Comment>${X(c.text)}</Comment>${c.vp ? `<Viewpoint Guid="${c.vp}"/>` : ''}</Comment>`).join('')}</Comments>` +
      `<Viewpoints>${vps.map((v) => `<ViewPoint Guid="${v.guid}"><Viewpoint>${v.file}</Viewpoint>${v.snapshot ? `<Snapshot>${v.snapshot}</Snapshot>` : ''}</ViewPoint>`).join('')}</Viewpoints>` +
      `</Topic></Markup>`;
    dir.file('markup.bcf', xml);
  }
  return zip.generateAsync({ type: 'blob', mimeType: 'application/octet-stream', compression: 'DEFLATE' });
}

// ---------------------------------------------------------------- import
const txt = (el, sel) => { const n = el && el.querySelector(sel); return n ? n.textContent.trim() : ''; };
const vec = (el, sel) => { const n = el && el.querySelector(sel); return n ? { x: +txt(n, 'X'), y: +txt(n, 'Y'), z: +txt(n, 'Z') } : null; };

export async function importBCF(file) {
  const zip = await JSZip.loadAsync(file);
  const parser = new DOMParser();
  const out = [];
  const folders = new Set(Object.keys(zip.files).filter((p) => /\/markup\.bcf$/i.test(p)).map((p) => p.replace(/markup\.bcf$/i, '')));
  for (const folder of folders) {
    const doc = parser.parseFromString(await zip.file(`${folder}markup.bcf`).async('text'), 'application/xml');
    const topic = doc.querySelector('Topic');
    if (!topic) continue;
    const typeLabel = topic.getAttribute('TopicType') || 'Comment';
    const statusLabel = topic.getAttribute('TopicStatus') || 'Open';
    const type = Object.keys(MARKUP_TYPES).find((k) => MARKUP_TYPES[k].label.toLowerCase() === typeLabel.toLowerCase()) || (/issue|clash|error|defect/i.test(typeLabel) ? 'issue' : 'comment');
    const status = Object.keys(STATUSES).find((k) => STATUSES[k].bcf.toLowerCase() === statusLabel.toLowerCase()) || (/close/i.test(statusLabel) ? 'closed' : /resol|done|fix/i.test(statusLabel) ? 'resolved' : 'open');
    const prioLabel = txt(topic, 'Priority');
    const priority = Object.keys(PRIORITIES).find((k) => PRIORITIES[k].toLowerCase() === prioLabel.toLowerCase()) || 'normal';
    let desc = txt(topic, 'Description');
    let position = null, elementGuid = null, gps = null, number = null, source = 'bcf', locked = false;
    const tagIdx = desc.indexOf(TAG);
    if (tagIdx >= 0) {
      const meta = desc.slice(tagIdx);
      desc = desc.slice(0, tagIdx).trim();
      const pm = /position=([-\d.]+),([-\d.]+),([-\d.]+)/.exec(meta); if (pm) position = { x: +pm[1], y: +pm[2], z: +pm[3] };
      const em = /element=(\S+)/.exec(meta); if (em) elementGuid = em[1];
      const gm = /gps=([-\d.]+),([-\d.]+)/.exec(meta); if (gm) gps = { lat: +gm[1], lon: +gm[2], acc: null };
      const nm = /number=(\d+)/.exec(meta); if (nm) number = +nm[1];
      const sm = /source=(\S+)/.exec(meta); if (sm) source = sm[1];
      locked = /locked=1/.test(meta);
    }
    // viewpoints
    const vpEls = [...topic.querySelectorAll('Viewpoints > ViewPoint, Viewpoints > Viewpoints')];
    let viewpoint = null, snapshot = null; const photos = [];
    for (let i = 0; i < vpEls.length; i++) {
      const v = vpEls[i];
      const vf = txt(v, 'Viewpoint'), sf = txt(v, 'Snapshot');
      if (sf && zip.file(folder + sf)) {
        const b64 = await zip.file(folder + sf).async('base64');
        const url = `data:image/${/png$/i.test(sf) ? 'png' : 'jpeg'};base64,${b64}`;
        if (i === 0) snapshot = url; else photos.push(url);
      }
      if (i === 0 && vf && zip.file(folder + vf)) {
        const vd = parser.parseFromString(await zip.file(folder + vf).async('text'), 'application/xml');
        const camEl = vd.querySelector('PerspectiveCamera, OrthogonalCamera');
        const eye = vec(camEl, 'CameraViewPoint'), dir = vec(camEl, 'CameraDirection'), up = vec(camEl, 'CameraUpVector');
        if (eye && dir) {
          const ortho = camEl.tagName === 'OrthogonalCamera';
          viewpoint = {
            mode: ortho ? 'plan' : 'orbit', position: eye,
            target: { x: eye.x + dir.x * 6, y: eye.y + dir.y * 6, z: eye.z + dir.z * 6 }, up: up || { x: 0, y: 0, z: 1 },
            fov: +txt(camEl, 'FieldOfView') || 60, orthoHeight: +txt(camEl, 'ViewToWorldScale') || null, aspect: +txt(camEl, 'AspectRatio') || 1.6
          };
          if (!position) position = viewpoint.target;
        }
        const comp = vd.querySelector('Selection Component');
        if (comp && !elementGuid) elementGuid = comp.getAttribute('IfcGuid');
      }
    }
    const comments = [...topic.querySelectorAll('Comments > Comment'), ...doc.querySelectorAll('Markup > Comment')];
    const replies = comments.map((c) => ({ id: c.getAttribute('Guid') || uuid(), author: txt(c, 'Author'), date: txt(c, 'Date'), text: txt(c, 'Comment') }));
    if (replies.length && replies[0].text === desc) replies.shift();
    if (replies.length && tagIdx >= 0 && replies[0].text === (desc || txt(topic, 'Title'))) replies.shift();
    out.push({
      id: topic.getAttribute('Guid') || uuid(), number, type, title: txt(topic, 'Title'), text: desc, status, priority,
      assignedTo: txt(topic, 'AssignedTo'), author: txt(topic, 'CreationAuthor'),
      createdAt: txt(topic, 'CreationDate') || new Date().toISOString(), modifiedAt: txt(topic, 'ModifiedDate') || new Date().toISOString(),
      position: position || { x: 0, y: 0, z: 0 }, element: elementGuid ? { guid: elementGuid, name: '', ifcType: '' } : null,
      gps, source, viewpoint, snapshot, photos, replies, locked
    });
  }
  return out;
}
