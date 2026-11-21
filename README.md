# SiteAR — BIM on site (PWA + WebXR)

An app for viewing BIM models on site, marking comments, notes and issues in 3D / Plan / Walk / AR, and sending them back to Revit via BCF.
It installs on iPad, phones and PCs (PWA) and works offline after the first visit.

## Current mode: manual, game-style (location features shelved)
GPS, step tracking, QR control points, tripod, Walk&Mark and the AR overlay are **switched off** (hidden, code kept): set `LOCATION_FEATURES = true` in `js/main.js` to bring them all back. Everything is controlled by hand:
- **Walk** (bottom bar): left stick = move, right stick = look, **▲ ▼** = fly up / down, speed button (เดิน / วิ่ง / เร็ว / บิน). On PC: W A S D + mouse drag, Q / E = down / up.
- **แคป (Capture, key C)**: saves a screenshot of the current view straight into the active group. **มาร์ค (Mark, key M)**: puts a pin where the crosshair points, then add a comment / photo.
- **Groups** (chip under the buttons): captures and marks that belong together; each group is drawn as a line through its items in order, filtered in the list, and exported to BCF (as a label), CSV and Project JSON.

## Features
| | |
|---|---|
| **Ribbon UI** | Home · Markup · View · Site · AR · Export (switches layout automatically for portrait/landscape) |
| **Models** | IFC 2x3/4 (from Revit), DXF (CAD), GLB/GLTF, OBJ — multiple models in one project |
| **Markup** | Comment / Note / Issue + photos + replies, tied to the IFC GUID of the element, **Lock** against edits |
| **Views** | Save View (with thumbnail), Lock View (freeze navigation), Section cut by storey, X-Ray |
| **Self-mark** | **I'm Here**: tap where you stand on the plan (tapping a column snaps to its centre). The simplest option, no survey needed — tap again at each point you walk to, and the path is recorded |
| **Location** | **Set Location by marking one point** + GPS · refine heading with a 2nd point · reads IfcSite / True North |
| **QR** | Create QR at model coordinates for the surveyor to set out → **Scan QR** on site to lock your position |
| **Navigation** | 3D orbit · Plan (shows your position + walked path) · Walk (WASD/joystick, Follow GPS, Gyro look) |
| **AR** | WebXR AR (Android Chrome/ARCore) · Camera AR (iPhone/iPad/any device: camera + gyro + GPS/QR) |
| **Export** | BCF 3.0 (Revit, Navisworks, Solibri, BIMcollab, Bonsai) · Project JSON · CSV |

## Simplest: Walk & Mark (Home → Walk&Mark)
Plan view only, no camera overlay. 1) tap where you stand (a column snaps to its centre) 2) tap the point you are facing 3) walk — the blue dot follows your steps (hold **▲ เดิน** if a step is missed) — and press **มาร์คตรงนี้**: the pin goes exactly where the dot is (or 1–3 m ahead). At each column press **ตั้งตำแหน่งใหม่** to reset drift. ⟲ ⟳ turn the heading by 10°.

## Best accuracy for AR overlay: Tripod mode (AR → Camera AR → ขาตั้ง)
Put the phone on a tripod at a known point (I'm Here or the QR button), enter the fixed camera height, and the position is locked (no steps/GPS). Align the heading once (drag / Face / QR), then only pan and tilt. Use the **FOV** slider so the virtual lens matches the phone camera (about 40–50° vertical, default 45°).

## Most accurate on iPad/iPhone (web): QR pose lock
Aim the camera at a printed QR and the app computes the camera's **position and heading** from the image (planar pose from the QR's finder/alignment patterns), then snaps the overlay to it.
1. **Site → Create QR**: tap the point, choose *floor* or *wall*, the direction and the real QR size (20 cm recommended, max 19 cm on A4)
2. **Print A4 at 100 %** (the sheet is drawn at real scale; check the 10 cm ruler on the sheet) and fix it exactly on the surveyed point (centre of the QR = the X/Y/Z you entered)
3. **AR → Camera AR → QR button**: point at the QR from **≤ 2 m**. Simulated accuracy: ~3–12 cm and ≤ 5° at ≤ 2 m; worse beyond 3 m
4. Between QRs the app follows your steps (Hybrid). Put a QR in every room or about every 5–10 m so errors reset

## Walkthrough on site (Camera AR / Walk Track)
1. **Site → I'm Here**: tap where you stand (tap a column to snap to its centre)
2. *(optional but best)* **Site → Face Point**: tap the point on the plan you are facing (e.g. the next column)
3. **AR → Camera AR** (see the real world with the model) or **AR → Walk Track** (model only, follows you)
4. Face the Face Point and press **Face**, or just **drag a finger left/right** until the model lines up with reality — the compass is then frozen and only the gyro turns the view, so it no longer loses direction
5. **Steps** (on automatically): every real step moves you 0.7 m (AR → Settings → step length) in the direction the phone faces. Works indoors, no GPS needed. Step counting drifts over distance — press **I'm Here** again at the next column to reset

## 3D controls (Revit-like)
| Action | Mouse | Touch screen / iPad |
|---|---|---|
| Zoom (toward the cursor) | Scroll wheel | Pinch with 2 fingers |
| Pan | Hold middle button and drag (or right button / Shift + left) | Drag with 2 fingers |
| Orbit around the clicked point (green ball) | Shift + middle button, or left-drag | Drag with 1 finger |
| Fit whole building | Double-click middle button or press F | Fit button |
| Fly to a point | Double-click left button | — |

No inertia: the model stops as soon as you let go.

- **Home** (button under the compass / press H) = back to the Home view · **Set Home** (View tab or right-click the Home button) = save the current view as Home
- **Scope box** (View → Scope, on by default) = the model can't leave the screen and the camera can't move further than 3× the model's size (adjust in AR → Settings)

## Run on a PC (development)
```
python -m http.server 5173 --directory sitear
```
Open http://localhost:5173

## Publish to use on phone / iPad (HTTPS required for camera, GPS and AR)
Same as SiteSnap: GitHub Pages
1. Upload every file in the `sitear` folder to a GitHub repository
2. Settings → Pages → Deploy from branch → `main` / `(root)`
3. Open `https://<user>.github.io/<repo>/`

## Install as an app
- **iPhone / iPad**: Safari → Share → Add to Home Screen
- **Android**: Chrome → ⋮ → Install app
- **PC (Windows)**: Chrome/Edge → the install icon in the address bar → you get a window like an .exe

## Device support
| | 3D/Plan/Walk | GPS + QR | Camera AR | WebXR AR (6DoF) |
|---|---|---|---|---|
| Android Chrome | ✓ | ✓ | ✓ | ✓ (needs ARCore) |
| iPhone / iPad Safari | ✓ | ✓ | ✓ | ✗ (Apple doesn't support it yet → wait for the Unity version) |
| Windows / Mac | ✓ | — | — | — |

## Accuracy (good to know)
- Phone GPS is accurate to about **±3–10 m**, so it is good for "where am I on the plan" but not for AR overlay
- For accurate AR, use a **QR control point the surveyor has set out** (Scan QR → position locked at that point) and **2nd Point** to correct the heading
- WebXR AR on Android: aim the ring at the QR / anchor point on the floor → *Align here* → fine-tune with heading trim

## File structure
```
sitear/
  index.html, manifest.webmanifest, sw.js   PWA shell + offline cache
  css/app.css                               UI (dark minimal, responsive portrait/landscape)
  js/main.js        app wiring, ribbon commands, dialogs
  js/viewer.js      three.js viewer, modes, picking, pins, GPS position
  js/loaders.js     IFC (web-ifc) / DXF / GLB / OBJ
  js/ar.js          WebXR + Camera AR
  js/geo.js         IFC ⇄ GPS coordinates (1-point anchor)
  js/sensors.js     GPS + compass/gyro
  js/bcf.js         BCF 3.0 export/import
  js/qr.js          QR control points
  js/store.js       IndexedDB (data stays on the device)
  schema/           JSON Schema (shared contract with Unity / Revit)
  docs/REVIT.md     Revit workflow + Dynamo script to place pins
  docs/UNITY_PORT.md plan for moving to Unity
  tools/make_assets.py  generates icons + samples/sample-building.ifc
```
