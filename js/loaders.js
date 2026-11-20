// Model loaders. Every loader returns a THREE.Object3D in "raw" coords (Y-up metres, see geo.js).
// Geometry is stored relative to the model's own centre (object.position = centre, kept in double precision)
// so real survey coordinates (e.g. UTM 1,500,000 m) don't lose float32 precision.
import * as THREE from 'three';
import * as WebIFC from 'web-ifc';
import { bearingFromTrueNorth } from './geo.js';

const WEB_IFC_WASM = 'https://cdn.jsdelivr.net/npm/web-ifc@0.0.57/';

// ---------------------------------------------------------------- IFC
let ifcApiPromise = null;
function getIfcApi() {
  if (!ifcApiPromise) {
    ifcApiPromise = (async () => {
      const api = new WebIFC.IfcAPI();
      api.SetWasmPath(WEB_IFC_WASM, true);
      await api.Init(undefined, true); // single-threaded: works without cross-origin isolation (GitHub Pages)
      return api;
    })();
  }
  return ifcApiPromise;
}

const TYPE_NAMES = {};
for (const k in WebIFC) if (/^IFC[A-Z0-9]+$/.test(k) && typeof WebIFC[k] === 'number') TYPE_NAMES[WebIFC[k]] = k;
export const ifcTypeName = (code) => {
  const n = TYPE_NAMES[code];
  if (!n) return 'IfcElement';
  // Pascal-case common IFC words: IFCWALLSTANDARDCASE -> IfcWallStandardCase
  let s = n.slice(3).toLowerCase();
  for (const w of IFC_WORDS) s = s.split(w).join(w.charAt(0).toUpperCase() + w.slice(1));
  return 'Ifc' + s.charAt(0).toUpperCase() + s.slice(1);
};
const IFC_WORDS = ['standard', 'case', 'element', 'proxy', 'building', 'covering', 'opening', 'member', 'column', 'beam', 'slab', 'wall', 'door', 'window', 'stair', 'railing', 'roof', 'space', 'plate', 'footing', 'pile', 'flight', 'segment', 'fitting', 'terminal', 'furnishing', 'storey', 'site', 'system', 'type', 'flow', 'distribution', 'duct', 'pipe', 'cable', 'carrier', 'curtain', 'ramp', 'chimney', 'shading', 'device', 'controller', 'energy', 'conversion', 'storage', 'treatment', 'moving', 'transport', 'reinforcing', 'bar', 'mesh', 'tendon', 'discrete', 'accessory', 'fastener', 'mechanical', 'geographic', 'civil', 'virtual', 'annotation', 'grid'];

const SKIP_TYPES = new Set([WebIFC.IFCSPACE, WebIFC.IFCOPENINGELEMENT].filter((x) => x !== undefined));

function valOf(v) { return v && typeof v === 'object' && 'value' in v ? v.value : v; }
function compoundAngle(arr) {
  if (arr && !Array.isArray(arr) && Array.isArray(arr.value)) arr = arr.value; // web-ifc wraps the list: {value:[d,m,s,µs]}
  if (!arr || !arr.length) return null;
  const a = arr.map(valOf).map(Number);
  return a[0] + (a[1] || 0) / 60 + (a[2] || 0) / 3600 + (a[3] || 0) / 3.6e9;
}

async function loadIFC(buffer, onProgress) {
  const api = await getIfcApi();
  const modelID = api.OpenModel(new Uint8Array(buffer), { COORDINATE_TO_ORIGIN: false });
  const buckets = new Map();
  const m4 = new THREE.Matrix4(), n3 = new THREE.Matrix3(), v = new THREE.Vector3(), n = new THREE.Vector3();
  const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  let count = 0;

  api.StreamAllMeshes(modelID, (mesh) => {
    const eid = mesh.expressID;
    let type = 0; try { type = api.GetLineType(modelID, eid); } catch (e) { /* ignore */ }
    if (SKIP_TYPES.has(type)) return;
    const geoms = mesh.geometries;
    for (let i = 0; i < geoms.size(); i++) {
      const pg = geoms.get(i);
      const c = pg.color;
      const key = `${c.x.toFixed(3)}|${c.y.toFixed(3)}|${c.z.toFixed(3)}|${c.w.toFixed(2)}`;
      let b = buckets.get(key);
      if (!b) { b = { color: c, pos: [], nor: [], eid: [], idx: [], count: 0 }; buckets.set(key, b); }
      const g = api.GetGeometry(modelID, pg.geometryExpressID);
      const verts = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
      const index = api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize());
      m4.fromArray(pg.flatTransformation);
      n3.getNormalMatrix(m4);
      const base = b.count;
      for (let k = 0; k < verts.length; k += 6) {
        v.set(verts[k], verts[k + 1], verts[k + 2]).applyMatrix4(m4);
        n.set(verts[k + 3], verts[k + 4], verts[k + 5]).applyMatrix3(n3).normalize();
        b.pos.push(v.x, v.y, v.z); b.nor.push(n.x, n.y, n.z); b.eid.push(eid);
        min.min(v); max.max(v);
        b.count++;
      }
      for (let k = 0; k < index.length; k++) b.idx.push(base + index[k]);
      if (g.delete) g.delete();
    }
    if (++count % 200 === 0 && onProgress) onProgress(`Building geometry… ${count} elements`);
  });

  const group = new THREE.Group();
  if (!buckets.size) throw new Error('IFC has no 3D geometry');
  const centre = min.clone().add(max).multiplyScalar(0.5);
  group.position.copy(centre);
  for (const b of buckets.values()) {
    const pos = new Float32Array(b.pos.length);
    for (let k = 0; k < b.pos.length; k += 3) {
      pos[k] = b.pos[k] - centre.x; pos[k + 1] = b.pos[k + 1] - centre.y; pos[k + 2] = b.pos[k + 2] - centre.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(b.nor), 3));
    geo.setAttribute('eid', new THREE.BufferAttribute(new Float32Array(b.eid), 1));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(b.idx), 1));
    geo.computeBoundingSphere(); geo.computeBoundingBox();
    const a = b.color.w;
    const mat = new THREE.MeshLambertMaterial({
      color: new THREE.Color().setRGB(b.color.x, b.color.y, b.color.z, THREE.SRGBColorSpace),
      transparent: a < 0.99, opacity: a, depthWrite: a >= 0.99, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
    });
    mat.userData.baseOpacity = a;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.ifc = true;
    group.add(mesh);
  }

  // ---- metadata: units, site location, true north, storeys
  const info = { format: 'ifc', schema: '', elements: count, site: null, trueNorthBearing: null, storeys: [] };
  try { info.schema = api.GetModelSchema(modelID); } catch (e) { /* ignore */ }
  let lenScale = 1;
  try {
    for (const id of iter(api.GetLineIDsWithType(modelID, WebIFC.IFCSIUNIT))) {
      const u = api.GetLine(modelID, id);
      if (valOf(u.UnitType) === 'LENGTHUNIT') {
        const pre = valOf(u.Prefix);
        lenScale = pre === 'MILLI' ? 0.001 : pre === 'CENTI' ? 0.01 : pre === 'DECI' ? 0.1 : pre === 'KILO' ? 1000 : 1;
      }
    }
    for (const id of iter(api.GetLineIDsWithType(modelID, WebIFC.IFCCONVERSIONBASEDUNIT))) {
      const u = api.GetLine(modelID, id);
      if (valOf(u.UnitType) === 'LENGTHUNIT') {
        const nm = String(valOf(u.Name) || '').toUpperCase();
        if (nm.includes('FOOT') || nm.includes('FEET')) lenScale = 0.3048;
        if (nm.includes('INCH')) lenScale = 0.0254;
      }
    }
  } catch (e) { /* ignore */ }
  try {
    for (const id of iter(api.GetLineIDsWithType(modelID, WebIFC.IFCSITE))) {
      const s = api.GetLine(modelID, id);
      const lat = compoundAngle(s.RefLatitude), lon = compoundAngle(s.RefLongitude);
      if (Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)) {
        info.site = { lat, lon, elevation: (Number(valOf(s.RefElevation)) || 0) * lenScale, name: valOf(s.Name) || 'Site' };
        break;
      }
    }
  } catch (e) { /* ignore */ }
  try {
    for (const id of iter(api.GetLineIDsWithType(modelID, WebIFC.IFCGEOMETRICREPRESENTATIONCONTEXT))) {
      const c = api.GetLine(modelID, id, true);
      if (c.TrueNorth && c.TrueNorth.DirectionRatios) {
        const r = c.TrueNorth.DirectionRatios.map(valOf).map(Number);
        info.trueNorthBearing = bearingFromTrueNorth(r[0], r[1]);
        break;
      }
    }
  } catch (e) { /* ignore */ }
  try {
    for (const id of iter(api.GetLineIDsWithType(modelID, WebIFC.IFCBUILDINGSTOREY))) {
      const s = api.GetLine(modelID, id);
      info.storeys.push({ name: valOf(s.Name) || `Storey ${id}`, elevation: (Number(valOf(s.Elevation)) || 0) * lenScale, expressID: id });
    }
    info.storeys.sort((a, b) => a.elevation - b.elevation);
  } catch (e) { /* ignore */ }

  group.userData.ifc = { api, modelID };
  return { object: group, info };
}

function* iter(vec) {
  if (!vec) return;
  if (typeof vec.size === 'function') { for (let i = 0; i < vec.size(); i++) yield vec.get(i); }
  else for (const x of vec) yield x;
}

// expressIDs of all columns in an IFC model (for self-mark snapping)
export function ifcColumnIds(group) {
  const ifc = group && group.userData.ifc;
  if (!ifc) return [];
  const out = [];
  for (const t of [WebIFC.IFCCOLUMN, WebIFC.IFCCOLUMNSTANDARDCASE].filter((x) => x !== undefined)) {
    try { for (const id of iter(ifc.api.GetLineIDsWithType(ifc.modelID, t))) out.push(id); } catch (e) { /* type not in schema */ }
  }
  return out;
}

// Element properties for the Info panel
export async function getIfcElementInfo(group, eid) {
  const ifc = group && group.userData.ifc;
  if (!ifc) return null;
  const { api, modelID } = ifc;
  const line = api.GetLine(modelID, eid);
  const out = {
    expressID: eid,
    guid: valOf(line.GlobalId) || '',
    name: valOf(line.Name) || '',
    ifcType: ifcTypeName(line.type ?? api.GetLineType(modelID, eid)),
    objectType: valOf(line.ObjectType) || '',
    tag: valOf(line.Tag) || '',
    psets: []
  };
  try {
    if (api.properties && api.properties.getPropertySets) {
      const psets = await api.properties.getPropertySets(modelID, eid, true);
      for (const ps of psets || []) {
        const props = [];
        for (const p of ps.HasProperties || []) {
          const nm = valOf(p.Name); const val = valOf(p.NominalValue);
          if (nm) props.push([nm, val === undefined || val === null ? '' : String(val)]);
        }
        if (props.length) out.psets.push({ name: valOf(ps.Name) || 'Properties', props });
      }
    }
  } catch (e) { /* properties optional */ }
  return out;
}

// ---------------------------------------------------------------- DXF
const DXF_UNITS = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1, 14: 0.1 };
async function loadDXF(text, opts = {}) {
  const { default: DxfParser } = await import('dxf-parser');
  const dxf = new DxfParser().parseSync(text);
  const insUnits = dxf.header && dxf.header.$INSUNITS;
  const scale = opts.unitScale || DXF_UNITS[insUnits] || 0.001;
  const segs = []; // ifc-style x,y,z pairs (drawing units)
  const add = (a, b) => segs.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  const ident = (p) => [p.x || 0, p.y || 0, p.z || 0];

  function emit(entities, T, depth) {
    for (const e of entities || []) {
      try {
        switch (e.type) {
          case 'LINE': add(T(ident(e.vertices[0])), T(ident(e.vertices[1]))); break;
          case 'LWPOLYLINE': case 'POLYLINE': {
            const vs = (e.vertices || []).map((p) => T(ident(p)));
            for (let i = 0; i < vs.length - 1; i++) add(vs[i], vs[i + 1]);
            if ((e.shape || e.closed) && vs.length > 2) add(vs[vs.length - 1], vs[0]);
            break;
          }
          case 'CIRCLE': case 'ARC': {
            const c = e.center; const r = e.radius;
            let a0 = e.type === 'ARC' ? e.startAngle : 0, a1 = e.type === 'ARC' ? e.endAngle : Math.PI * 2;
            if (a1 < a0) a1 += Math.PI * 2;
            const steps = Math.max(8, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 64));
            let prev = null;
            for (let i = 0; i <= steps; i++) {
              const a = a0 + ((a1 - a0) * i) / steps;
              const p = T([c.x + r * Math.cos(a), c.y + r * Math.sin(a), c.z || 0]);
              if (prev) add(prev, p); prev = p;
            }
            break;
          }
          case '3DFACE': case 'SOLID': {
            const vs = (e.vertices || []).map((p) => T(ident(p)));
            for (let i = 0; i < vs.length; i++) add(vs[i], vs[(i + 1) % vs.length]);
            break;
          }
          case 'SPLINE': {
            const vs = (e.fitPoints && e.fitPoints.length ? e.fitPoints : e.controlPoints || []).map((p) => T(ident(p)));
            for (let i = 0; i < vs.length - 1; i++) add(vs[i], vs[i + 1]);
            break;
          }
          case 'INSERT': {
            if (depth > 4) break;
            const blk = dxf.blocks && dxf.blocks[e.name];
            if (!blk) break;
            const bp = blk.position || { x: 0, y: 0, z: 0 };
            const sx = e.xScale || 1, sy = e.yScale || 1, sz = e.zScale || 1;
            const rot = ((e.rotation || 0) * Math.PI) / 180, cr = Math.cos(rot), sr = Math.sin(rot);
            const ip = e.position || { x: 0, y: 0, z: 0 };
            const T2 = (p) => {
              const x = (p[0] - bp.x) * sx, y = (p[1] - bp.y) * sy, z = (p[2] - (bp.z || 0)) * sz;
              return T([ip.x + x * cr - y * sr, ip.y + x * sr + y * cr, (ip.z || 0) + z]);
            };
            emit(blk.entities, T2, depth + 1);
            break;
          }
          default: break;
        }
      } catch (err) { /* skip broken entity */ }
    }
  }
  emit(dxf.entities, (p) => p, 0);
  if (!segs.length) throw new Error('DXF has no supported entities (LINE, POLYLINE, ARC, CIRCLE, INSERT…)');

  // convert to raw (Y-up) metres, centred
  const raw = new Float64Array(segs.length);
  const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < segs.length; i += 3) {
    const x = segs[i] * scale, y = segs[i + 2] * scale, z = -segs[i + 1] * scale;
    raw[i] = x; raw[i + 1] = y; raw[i + 2] = z;
    min.x = Math.min(min.x, x); min.y = Math.min(min.y, y); min.z = Math.min(min.z, z);
    max.x = Math.max(max.x, x); max.y = Math.max(max.y, y); max.z = Math.max(max.z, z);
  }
  const centre = min.clone().add(max).multiplyScalar(0.5);
  const pos = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 3) { pos[i] = raw[i] - centre.x; pos[i + 1] = raw[i + 1] - centre.y; pos[i + 2] = raw[i + 2] - centre.z; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeBoundingSphere();
  const mat = new THREE.LineBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.9 });
  mat.userData.baseOpacity = 0.9;
  const lines = new THREE.LineSegments(geo, mat);
  const group = new THREE.Group();
  group.position.copy(centre);
  group.add(lines);
  return { object: group, info: { format: 'dxf', unitScale: scale, entities: (dxf.entities || []).length, storeys: [] } };
}

// ---------------------------------------------------------------- GLTF / OBJ
async function loadGLTF(buffer) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buffer, '', res, rej));
  prepareGeneric(gltf.scene);
  return { object: gltf.scene, info: { format: 'gltf', storeys: [] } };
}
async function loadOBJ(text) {
  const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
  const obj = new OBJLoader().parse(text);
  obj.traverse((o) => { if (o.isMesh) o.material = new THREE.MeshLambertMaterial({ color: 0xc9d3de, side: THREE.DoubleSide }); });
  prepareGeneric(obj);
  return { object: obj, info: { format: 'obj', storeys: [] } };
}
function prepareGeneric(root) {
  root.traverse((o) => {
    if (!o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      m.side = THREE.DoubleSide;
      m.userData.baseOpacity = m.opacity ?? 1;
    }
  });
}

// ---------------------------------------------------------------- entry point
export const MODEL_EXT = ['ifc', 'dxf', 'glb', 'gltf', 'obj'];
export function extOf(name) { return (name.split('.').pop() || '').toLowerCase(); }

export async function loadModelFile(name, data, opts = {}, onProgress) {
  const ext = extOf(name);
  const text = () => new TextDecoder().decode(data);
  switch (ext) {
    case 'ifc': return loadIFC(data, onProgress);
    case 'dxf': return loadDXF(text(), opts);
    case 'glb': case 'gltf': return loadGLTF(data);
    case 'obj': return loadOBJ(text());
    case 'dwg': throw new Error('DWG is a closed format — please save as DXF (AutoCAD: Save As → DXF) or export IFC from Revit');
    case 'rvt': throw new Error('RVT cannot be read outside Revit — in Revit use File → Export → IFC');
    default: throw new Error(`Unsupported file type .${ext}`);
  }
}
