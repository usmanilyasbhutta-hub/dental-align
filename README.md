# Dental Align — Goal 1 experimental prototype

*Design v0.4: Liquid Glass (iOS 26-inspired). Glass only on controls (floating nav buttons, bottom search dock, floating toolbar, inset sheet, camera controls); content stays solid. Dental House logo in its original colours, slate/bronze tint, light and dark mode.*

> 1. **The reference is the target. The target never chases the live image.**
> 2. **Measure mismatch; never hide mismatch by warping the clinical photograph.**
> 3. **Changed anatomy should stop contributing to registration rather than be mistaken for camera-position error.**
> 4. **The goal is not to declare a photograph acceptable. The goal is to continuously help the operator find the closest practically achievable reproduction of the reference.**

This is a real, working prototype for answering one question: *can computer vision plus phone motion meaningfully guide a dentist's hand until a live intraoral image closely reproduces a previous photograph?* It's built to expose failures, not to hide them.

---

## 1. Put it on your iPhone (no Mac needed)

The camera only works over **HTTPS**, so the `dist/` folder must be hosted. Either of these works from Windows:

**Option A — Netlify Drop (about 2 minutes, free)**
1. On your PC, unzip the package and open https://app.netlify.com/drop
2. Drag the **`dist`** folder onto the page. You get an `https://….netlify.app` address.
3. On the iPhone, open that address in **Safari** → Share → **Add to Home Screen**.
4. Open **Dental Align** from the home screen. Allow **Camera**. On the first view you open, allow **Motion & Orientation**.

**Option B — GitHub Pages:** push the repository and publish the `dist` folder (or run `npm run build` in a GitHub Action). Any static HTTPS host works, since the app has no server component.

Later deployments: rebuild, re-drag `dist`. The service worker picks up the new build on the next launch (open the app twice if the old version is still showing).

**Local development:** `npm install`, then `npm run dev`. On the phone, use an HTTPS tunnel (e.g. `cloudflared tunnel --url http://localhost:5173`), because Safari blocks the camera on plain-HTTP LAN addresses.

---

## 2. Workflow

**Patient → View → Align → Capture**

- Enter a patient ID (e.g. `DH-0147`). Each view tile shows its real baseline photo.
- **First photograph of a view:** a restrained generic composition guide (arch/midline/occlusal plane, oblique box for buccal/posterior, U-arch for occlusal) plus a gravity level line. The first capture **automatically becomes the baseline**, with no dialog.
- **Follow-ups:** the baseline appears as a **fixed translucent ghost** (◐ cycles its opacity). Move the phone and patient until the live anatomy settles onto it.
- Thumbnail (bottom-left) → history: unwarped baseline/follow-up comparison slider, **Save / Share** (iOS share sheet → *Save Image* puts it in Photos), metadata export, **Make baseline**, delete.

### Angle guide and coaching (v0.2, added after the first real test)

- **Crosshair = angulation.** A small fixed **+** sits at the centre; a bold **+** shows where to **aim** the camera. Tilt the phone until the bold + sits on the fixed one (white → amber → green). It updates at sensor speed, independently of image matching.
  - **Tilt-sensor source:** every capture now stores the phone's gravity direction. Follow-ups compare against it, which is instant and noise-free. **Baselines taken before v0.2 don't have this; retake the baseline once** (or the guide falls back to the image source).
  - **Image source:** estimated from the measured perspective of the subject itself. Slower and noisier, but it measures camera vs. subject. Settings → *Angle guide source* switches between auto, tilt sensor and image.
  - The tilt sensor assumes the subject keeps its own orientation, which holds for a stamp on a table and only roughly for a patient's head. If a patient tilts their head, trust the image (ghost, feature lines) over the crosshair.
- **Coach line:** one instruction for the biggest error, in order: angle (if > 2.5°) → distance → position → roll → fine angle → "Hold still" → **"Hold — capture"**. Turn it off in Settings.
- The shutter ring only turns green (and the haptic fires) when the angle also matches within tolerance (default 1°).
- The ring no longer tilts. It now shows only position, distance and roll; angle has its own cue.

### Reading the guidance

| Cue | Meaning |
|---|---|
| **Fixed thin ring** at the centre | Where the reference content should be. It never moves. |
| **Live ring** | Where that same reference circle currently is in the live image, i.e. the image of the circle under the measured transform. **Bring the live ring onto the fixed ring.** |
| Live ring off-centre | Translation: move the phone toward the ring (it slides back to centre). |
| Live ring larger / smaller | Too close / too far. |
| Tick on the live ring rotated | Roll: rotate the phone the same way the tick leans. |
| Bold **+** away from the centre **+** | Angulation: aim the camera toward the bold +. |
| Feature lines | Each line joins a live match to its *fixed* reference location. Colour goes continuously white → amber → green as they converge. Points on changed anatomy **fade out** (never red). |
| Shutter ring green + haptic tick | Strong convergence. A second, double tick = *peak opportunity* (geometry strong + sharp + phone steady). |

The interface gets quieter as alignment improves: lines dim, the puck flattens, settles and fades. The manual shutter always works.

**Temporal best-frame capture.** Pressing the shutter is treated as *intent*. The app scores the 3 frames before and 3 after the press (geometric error dominates; sharpness, low motion and exposure break ties) and keeps the best real frame. The **master is that camera frame encoded 1:1**: no warp, crop, resampling or enhancement.

### Hidden diagnostics mode
**Long-press the view name** on the capture screen (or Settings → Diagnostics). It shows live numbers: match mode, reference/live features, candidates, inliers, coverage, raw translation/scale/roll/perspective, error components, sharpness, luminance, gyro, whether movement improved the error, the learned motion→image Jacobian, FPS, processing time and dropped frames.

**Every capture session is logged frame-by-frame on the device** (last 40 sessions), whether or not diagnostics are visible. Settings → *Diagnostic logs* → **Export** shares a `_frames.csv` and an `_events.json`. Send those along with any report like *"the puck told me to go left when I should have gone right"*.

---

## 3. How it works

```
camera (getUserMedia, rear, 1080p or 4K)
  ├─► processing frame: gray, 640 px long side ─────────► CV worker (OpenCV.js / WASM)
  ├─► 384 px native-resolution centre crop (focus) ─────►   CLAHE → ORB → match → RANSAC homography
  └─► full-res ImageBitmap ring buffer                       → similarity fit → error components
                 ▲                                                  │
                 └─── metrics attached per frame ◄──────────────────┘
DeviceMotion (gyro, gravity) ─► motion→image learning (RLS), roll level, steadiness
guidance: EMA smoothing → phases (searching / converging / strong / peak) → overlay + haptics
```

- **Reference keypoints (spec §9–10):** ~2500 ORB detections on the baseline, then a coverage-based selection: an 8×8 grid, round-robin across cells, strongest first, with minimum spacing. Target 120 points (tunable).
- **Correspondence (§12):** (a) **guided matching**: predict each reference point from the last good homography and search a 20 px radius; (b) if there's no recent estimate or guidance fails, **global** Hamming kNN plus ratio test on the same frame (re-acquisition).
- **Robust geometry (§11):** RANSAC homography (4 px). Matches that don't fit the coherent set are dropped, so changed anatomy stops influencing registration.
- **What's estimated (§13):** a least-squares similarity on the inliers gives **translation** (image-width units), **scale** and **roll**. The homography's keystone terms (`px`, `py`) and the corner displacement between the homography and the similarity give the **perspective** residual. Total error `E = |t| + |ln s| + 0.5·|roll| + perspective`.
- **Homography rule (§14):** it is only measured. Nothing is ever warped for display or storage.
- **Controller (§15–17):** closed loop, every frame. Per frame the app logs whether error dropped (`improved`) and the cosine between observed content motion and the guided direction (`followed`). A recursive-least-squares model learns how phone rotation (gyro yaw/pitch) moves the image (`J`), as groundwork for IBVS-style guidance.

---

## 4. Verification done before delivery

Tested in headless Chromium with a synthetic intraoral-like video carrying a scripted camera error (shift +8% / +3% of width, scale 1.07, roll 4° clockwise, then back):

| | true | measured |
|---|---|---|
| translation x / y | 0.080 / 0.030 | 0.080 / 0.031 |
| scale | 1.070 | 1.073 |
| roll | 4.00° | 3.92° |

- Perspective sign checked in all four directions (right/left/top/bottom side farther) using the real worker code.
- **Changed anatomy:** central teeth painted over plus a specular blob. Registration unchanged (0.0795 / 0.0298, scale 1.072, roll 3.94°). None of the 30 reference points in the changed region was used; they dropped out as unmatched or outliers.
- Guided matching raised inliers under that offset from 15 to 41 compared with global matching alone.
- `followed` ≈ −1 while the image drifted away, ≈ +1 while it returned.
- Processing ≈ 34 ms/frame on the build server. **iPhone 14 performance is unmeasured**; the logs will show it.

---

## 5. Known limitations (platform, not hidden)

- **The photo is a video frame.** Safari can't take a full-resolution still from inside a web app, so the master is the best frame from the video stream (1080p by default, 4K optional in Settings). This is the strongest argument for going native in Goal 2.
- **No manual camera control in Safari.** ISO, exposure time, white balance, focus and lens can't be locked or read. The app records what `getSettings()` exposes. Zoom is held at 1× where the browser exposes zoom. Pinch-zoom is disabled.
- **No Photos albums.** A web app can't use PhotoKit. Images live in the app's local storage; use *Save / Share* to put them in Photos. **Deleting the home-screen app or clearing Safari website data deletes the stored photos and logs.** Export anything you need.
- **Haptics:** iOS has no vibration API. The app uses the iOS 18+ switch-control haptic trick. On older iOS there's no haptic, only the visual cue.
- **Motion permission** must be granted from a tap. If it was denied, delete and re-add the home-screen app, or reset in iOS Settings.
- **Perspective vs. translation ambiguity:** at intraoral working distances, yaw and sideways translation look similar. The puck shows the image-space correction. Whether people interpret it correctly is one of the things Goal 1 has to measure (the `followed` and `improved` columns).
- **Perspective noise:** with few inliers the keystone estimate is noisy (~0.02 to 0.04 even with no real tilt), which can delay "strong convergence". Watch `perspResid` in the logs.
- **Cold-start re-acquisition** with large offsets *and* changed anatomy can approach the minimum inlier count. Watch `matchMode` / `inliers` in the logs.
- **Orientation:** hold the phone the same way as the baseline. If the aspect ratio differs, registration pauses with a notice.

---

## 6. Suggested Goal-1 test protocol (spec §32)

For each scenario, capture with guidance, export the session log, and also take an unaided handheld photo for comparison.

1. Static object (book cover, printed photo): sanity check.
2. Dental model: dental texture.
3. Same patient, same session, without repositioning: micro-position reproducibility.
4. Same patient after repositioning (chair raised/lowered, retractors out and back in).
5. Different day.
6. After preparation (changed central anatomy).
7. After restoration.
8. Different saliva / retractor.
9. Slight lighting change.
10. Posterior view.
11. Occlusal / mirror view.

Things to note per test: time to convergence, whether the puck direction felt right, jitter, false "green", feature lines on the wrong structures, FPS, and whether the final photo was more reproducible than unaided.

**Useful log columns:** `matchMode, candidates, inliers, inlierRatio, coverage, tx, ty, scale, rollDeg, px, py, perspResid, E, E_smooth, sharpness, gyroRate, dGamma, dBeta, followed, improved, procMs, latencyMs, fps, dropped`.

---

## 7. Code map

| File | Role |
|---|---|
| `public/cv-worker.js` | Registration engine (OpenCV.js WASM): reference selection, guided/global matching, RANSAC, error components, sharpness, lighting ratio |
| `src/engine.ts` | Camera, frame pipeline, ring buffer, smoothing, phases, haptics, RLS controller model, best-frame capture, logging |
| `src/overlay.ts` | Feature lines, target ring, live ring (image of the reference circle under the measured transform) |
| `src/views.ts` | Standard views and generic baseline guides |
| `src/motion.ts` | DeviceMotion/Orientation: gyro integration, gravity roll |
| `src/Capture.tsx` | Capture screen, diagnostics overlay, session log persistence |
| `src/App.tsx` | Patient → View screens, history/compare, settings, log export |
| `src/db.ts` | IndexedDB: patients, views, captures (master + thumb + metadata), logs |
| `src/settings.ts` | All tunable parameters (editable in Settings) |

Stack: React 19 + TypeScript + Vite, OpenCV.js 4.10 (`@techstark/opencv-js`), no backend.
