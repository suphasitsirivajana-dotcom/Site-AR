# Preparing the move to Unity (native AR: ARKit / ARCore)

The PWA was designed so its data and logic carry over to Unity directly. **The data format stays the same**, so the Unity app opens files from the PWA and vice versa.

## Shared contract (do not change)
| What | File / format |
|---|---|
| Project | `*.sitear.json` → `schema/sitear-project.schema.json` (`sitear.project/1.0`) |
| Comments / issues for BIM | BCF 3.0 `.bcfzip` (`js/bcf.js`) |
| QR control point | JSON `{"t":"sitear-cp","v":1,"pid","id","n","x","y","z"}` (`js/qr.js`) |
| Coordinates | IFC metres, Z-up. Unity is Y-up, left-handed → `unity = (x, z, y)` |
| Geo anchor | 1 point + bearing (`js/geo.js`: `gpsToModel`, `modelToGps`, `bearingFromPair`) |

> Note: three.js uses `(x, z, -y)` (right-handed), but Unity is left-handed, so use `(x, z, y)`.

## Module mapping PWA → Unity
| PWA (`js/`) | Unity |
|---|---|
| `loaders.js` (web-ifc) | Convert IFC → GLB beforehand with **IfcOpenShell `IfcConvert`** (keeps GUIDs as node names) or use the **web-ifc** WASM via a Unity WebGL bridge. On mobile use **glTFast** + a GUID→metadata JSON |
| `viewer.js` 3D / Plan / Walk | Cinemachine + orthographic camera for Plan, CharacterController for Walk |
| `ar.js` WebXR | **AR Foundation** (ARKit/ARCore): `ARRaycastManager` (hit-test), `ARAnchorManager` |
| `ar.js` Camera AR | Not needed — AR Foundation tracks 6DoF on iPhone/iPad too |
| QR scan (`qr.js`) | **AR Foundation Image Tracking** or ZXing.Net → also gives the QR **orientation** (more accurate than a compass) |
| `sensors.js` GPS/compass | `Input.location`, `Input.compass` (or ARCore Geospatial API for much higher accuracy) |
| `bcf.js` | Port the same XML (System.Xml + System.IO.Compression) |
| `store.js` IndexedDB | `Application.persistentDataPath` + JSON |
| `ui.js` ribbon | UI Toolkit (USS mirrors `css/app.css`: same colours, dark minimal) |

## Recommended order
1. Unity 2022 LTS + AR Foundation 5 + glTFast
2. Read `*.sitear.json` → show markups/views (read-only) → verify coordinates match the PWA
3. AR alignment with QR image tracking (1 QR = position + orientation)
4. Create markups → write the same JSON / BCF
5. Build: Android (.apk/.aab), iOS (needs a Mac + Xcode), Windows (.exe)
