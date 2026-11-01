/* Dental Align — computer-vision registration worker.
 *
 * Runs OpenCV.js (WebAssembly) off the main thread.
 *
 * INTEGRITY RULE: this worker only MEASURES the geometric relationship between
 * the fixed reference and the live frame. It never warps, resamples or alters
 * either image. The homography is a measuring instrument, not a correction.
 *
 * Coordinate conventions
 *   pixel coords: processing-resolution pixels, origin top-left, y down.
 *   normalized coords: u = (x - w/2) / w,  v = (y - h/2) / w   (units of image width)
 *   model fitted: live = A(ref)   i.e. where reference content currently appears in live.
 */
/* global cv */
self.Module = {
  onRuntimeInitialized() {
    ready = true;
    postMessage({ type: 'ready' });
  },
};
let ready = false;
try {
  importScripts('opencv.js');
} catch (e) {
  postMessage({ type: 'error', message: 'Failed to load opencv.js: ' + e });
}
// Some opencv.js builds expose cv as a promise / factory instead of firing Module callback.
(function waitForCv() {
  if (ready) return;
  if (typeof cv !== 'undefined') {
    if (cv instanceof Promise || (cv && typeof cv.then === 'function')) {
      cv.then((m) => { self.cv = m; if (!ready) { ready = true; postMessage({ type: 'ready' }); } });
      return;
    }
    if (cv.Mat) { if (!ready) { ready = true; postMessage({ type: 'ready' }); } return; }
    if (!cv.__hooked) {
      cv.__hooked = true;
      const prev = cv.onRuntimeInitialized;
      cv.onRuntimeInitialized = () => { if (prev) try { prev(); } catch (_) { /* */ } if (!ready) { ready = true; postMessage({ type: 'ready' }); } };
    }
  }
  setTimeout(waitForCv, 50);
})();

// ---------------------------------------------------------------- state
let ref = null; // { w, h, kps:[{x,y,response,octave,cell}], desc: cv.Mat, cells:Set, gray: Uint8Array }
let orbLive = null, orbLiveN = 0;
let clahe = null;
let track = null; // { Hpx: number[9], t: number } last good reference→live homography (pixel coords)
const POP = new Uint8Array(256);
for (let i = 0; i < 256; i++) POP[i] = (i & 1) + POP[i >> 1];

function getClahe() {
  if (!clahe) clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
  return clahe;
}
function getOrbLive(n) {
  if (!orbLive || orbLiveN !== n) {
    if (orbLive) orbLive.delete();
    orbLive = new cv.ORB(n);
    orbLiveN = n;
  }
  return orbLive;
}

function grayMat(buf, w, h, useClahe) {
  const m = new cv.Mat(h, w, cv.CV_8UC1);
  m.data.set(new Uint8Array(buf));
  if (useClahe) {
    const o = new cv.Mat();
    getClahe().apply(m, o);
    m.delete();
    return o;
  }
  return m;
}

// ---------------------------------------------------------------- reference
function setReference(msg) {
  const { w, h, gray, params } = msg;
  if (ref && ref.desc) ref.desc.delete();
  ref = null;
  track = null;
  const t0 = performance.now();
  const img = grayMat(gray, w, h, params.clahe);
  const orb = new cv.ORB(params.refDetect);
  const kpv = new cv.KeyPointVector();
  const desc = new cv.Mat();
  const none = new cv.Mat();
  orb.detectAndCompute(img, none, kpv, desc);
  const all = [];
  for (let i = 0; i < kpv.size(); i++) {
    const k = kpv.get(i);
    all.push({ i, x: k.pt.x, y: k.pt.y, response: k.response, octave: k.octave });
  }
  // ---- spatially distributed (grid / coverage-based) selection
  const G = params.refGrid; // G x G cells
  const cellOf = (p) => {
    const cx = Math.min(G - 1, Math.floor((p.x / w) * G));
    const cy = Math.min(G - 1, Math.floor((p.y / h) * G));
    return cy * G + cx;
  };
  const buckets = new Map();
  for (const p of all) {
    p.cell = cellOf(p);
    if (!buckets.has(p.cell)) buckets.set(p.cell, []);
    buckets.get(p.cell).push(p);
  }
  for (const b of buckets.values()) b.sort((a, c) => c.response - a.response);
  // round-robin across cells, strongest first, with a minimum spacing
  const minSpacing = Math.max(4, Math.min(w, h) / (G * 3));
  const chosen = [];
  const target = params.refTarget;
  const lists = [...buckets.values()];
  const ptr = new Array(lists.length).fill(0);
  let progressed = true;
  // Each round, every cell contributes its next-strongest point that respects the spacing.
  while (chosen.length < target && progressed) {
    progressed = false;
    for (let li = 0; li < lists.length && chosen.length < target; li++) {
      const b = lists[li];
      while (ptr[li] < b.length) {
        const cand = b[ptr[li]++];
        let ok = true;
        for (const c of chosen) {
          const dx = c.x - cand.x, dy = c.y - cand.y;
          if (dx * dx + dy * dy < minSpacing * minSpacing) { ok = false; break; }
        }
        if (ok) { chosen.push(cand); progressed = true; break; }
      }
    }
  }
  // descriptors for chosen
  const sel = new cv.Mat(chosen.length, desc.cols, desc.type());
  chosen.forEach((p, r) => {
    for (let c = 0; c < desc.cols; c++) sel.ucharPtr(r, c)[0] = desc.ucharPtr(p.i, c)[0];
  });
  const cells = new Set(chosen.map((p) => p.cell));
  // coverage at 4x4 for reporting
  const cov4 = new Set(chosen.map((p) => Math.min(3, Math.floor((p.y / h) * 4)) * 4 + Math.min(3, Math.floor((p.x / w) * 4))));
  ref = {
    w, h,
    kps: chosen.map((p) => ({ x: p.x, y: p.y, response: p.response, cell: p.cell })),
    desc: sel,
    cells,
    gray: new Uint8Array(gray),
    cov4,
  };
  img.delete(); kpv.delete(); desc.delete(); none.delete(); orb.delete();
  postMessage({
    type: 'reference',
    w, h,
    detected: all.length,
    points: ref.kps,
    coverage4: cov4.size / 16,
    ms: performance.now() - t0,
  });
}

// ---------------------------------------------------------------- helpers
function laplacianVariance(buf, w, h) {
  if (!buf || !w) return 0;
  const m = new cv.Mat(h, w, cv.CV_8UC1);
  m.data.set(new Uint8Array(buf));
  const lap = new cv.Mat();
  cv.Laplacian(m, lap, cv.CV_64F, 3);
  const mean = new cv.Mat(), sd = new cv.Mat();
  cv.meanStdDev(lap, mean, sd);
  const v = sd.data64F[0] * sd.data64F[0];
  m.delete(); lap.delete(); mean.delete(); sd.delete();
  return v;
}

function brightnessStats(g) {
  let sum = 0, clip = 0, dark = 0;
  for (let i = 0; i < g.length; i++) {
    const v = g[i];
    sum += v;
    if (v >= 250) clip++;
    if (v <= 5) dark++;
  }
  return { mean: sum / g.length, clipped: clip / g.length, crushed: dark / g.length };
}

// Least-squares similarity (Umeyama 2D) mapping P -> Q, both normalized coords.
function fitSimilarity(P, Q) {
  const n = P.length / 2;
  let mpx = 0, mpy = 0, mqx = 0, mqy = 0;
  for (let i = 0; i < n; i++) { mpx += P[2 * i]; mpy += P[2 * i + 1]; mqx += Q[2 * i]; mqy += Q[2 * i + 1]; }
  mpx /= n; mpy /= n; mqx /= n; mqy /= n;
  let sa = 0, sb = 0, sp = 0;
  for (let i = 0; i < n; i++) {
    const px = P[2 * i] - mpx, py = P[2 * i + 1] - mpy;
    const qx = Q[2 * i] - mqx, qy = Q[2 * i + 1] - mqy;
    sa += px * qx + py * qy;
    sb += px * qy - py * qx;
    sp += px * px + py * py;
  }
  const a = sa / sp, b = sb / sp;
  const tx = mqx - (a * mpx - b * mpy);
  const ty = mqy - (b * mpx + a * mpy);
  // residual RMS
  let r2 = 0;
  for (let i = 0; i < n; i++) {
    const px = P[2 * i], py = P[2 * i + 1];
    const ex = a * px - b * py + tx - Q[2 * i];
    const ey = b * px + a * py + ty - Q[2 * i + 1];
    r2 += ex * ex + ey * ey;
  }
  return { a, b, tx, ty, scale: Math.hypot(a, b), roll: Math.atan2(b, a), rms: Math.sqrt(r2 / n) };
}

function applyH(H, u, v) {
  const X = H[0] * u + H[1] * v + H[2];
  const Y = H[3] * u + H[4] * v + H[5];
  const W = H[6] * u + H[7] * v + H[8];
  return [X / W, Y / W];
}
function mul3(A, B) {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += A[r * 3 + k] * B[k * 3 + c];
    C[r * 3 + c] = s;
  }
  return C;
}

// ---------------------------------------------------------------- frame
function processFrame(msg) {
  const t0 = performance.now();
  const { id, w, h, gray, crop, cropW, cropH, params } = msg;
  const out = { type: 'result', id, w, h, hasRef: !!ref };
  // image quality — absolute, independent of the reference
  out.sharpness = laplacianVariance(crop, cropW, cropH);
  const g = new Uint8Array(gray);
  out.brightness = brightnessStats(g);

  if (!ref) {
    out.ms = performance.now() - t0;
    postMessage(out);
    return;
  }
  if (ref.w !== w || ref.h !== h) {
    out.error = 'aspect';
    out.ms = performance.now() - t0;
    postMessage(out);
    return;
  }

  const img = grayMat(gray, w, h, params.clahe);
  const orb = getOrbLive(params.liveDetect);
  const kpv = new cv.KeyPointVector();
  const desc = new cv.Mat();
  const none = new cv.Mat();
  orb.detectAndCompute(img, none, kpv, desc);
  const tDetect = performance.now();
  out.liveFeatures = kpv.size();

  const nRef = ref.kps.length;
  const status = new Int8Array(nRef).fill(-1); // -1 unmatched, 0 outlier, 1 inlier
  const liveXY = new Float32Array(nRef * 2);
  let P = [], Q = [], idx = [];
  const nLive = kpv.size();
  const lp = new Float32Array(nLive * 2);
  for (let j = 0; j < nLive; j++) { const pt = kpv.get(j).pt; lp[2 * j] = pt.x; lp[2 * j + 1] = pt.y; }
  out.matchMode = 'none';

  // ---- (a) guided matching (temporal tracking): predict each reference point from the last
  //      good estimate and search only nearby live keypoints. Much better on repetitive dental texture.
  const now = performance.now();
  if (track && now - track.t < params.trackMaxAgeMs && nLive >= 8 && desc.rows > 0) {
    const R = params.trackRadius;
    const CS = Math.max(8, R); // bucket size
    const gw = Math.ceil(w / CS) + 1, gh = Math.ceil(h / CS) + 1;
    const grid = new Array(gw * gh);
    for (let j = 0; j < nLive; j++) {
      const gx = Math.floor(lp[2 * j] / CS), gy = Math.floor(lp[2 * j + 1] / CS);
      const k = gy * gw + gx;
      (grid[k] || (grid[k] = [])).push(j);
    }
    const H = track.Hpx, rd = ref.desc.data, ld = desc.data, DB = desc.cols;
    for (let i = 0; i < nRef; i++) {
      const r = ref.kps[i];
      const W = H[6] * r.x + H[7] * r.y + H[8];
      const X = (H[0] * r.x + H[1] * r.y + H[2]) / W, Y = (H[3] * r.x + H[4] * r.y + H[5]) / W;
      if (X < -R || Y < -R || X > w + R || Y > h + R) continue;
      const gx0 = Math.floor((X - R) / CS), gx1 = Math.floor((X + R) / CS);
      const gy0 = Math.floor((Y - R) / CS), gy1 = Math.floor((Y + R) / CS);
      let best = 999, second = 999, bj = -1;
      for (let gy = Math.max(0, gy0); gy <= Math.min(gh - 1, gy1); gy++)
        for (let gx = Math.max(0, gx0); gx <= Math.min(gw - 1, gx1); gx++) {
          const cell = grid[gy * gw + gx];
          if (!cell) continue;
          for (const j of cell) {
            const dx = lp[2 * j] - X, dy = lp[2 * j + 1] - Y;
            if (dx * dx + dy * dy > R * R) continue;
            let hd = 0;
            const ro = i * DB, lo = j * DB;
            for (let b = 0; b < DB; b++) hd += POP[rd[ro + b] ^ ld[lo + b]];
            if (hd < best) { second = best; best = hd; bj = j; } else if (hd < second) second = hd;
          }
        }
      if (bj >= 0 && best <= params.trackMaxHamming && best < params.trackRatio * second) {
        P.push(r.x, r.y); Q.push(lp[2 * bj], lp[2 * bj + 1]); idx.push(i);
      }
    }
    if (idx.length >= params.minCandidates) out.matchMode = 'guided';
    else { P = []; Q = []; idx = []; }
  }

  // ---- (b) global descriptor matching with ratio test (acquisition / re-acquisition)
  if (out.matchMode === 'none' && nLive >= 8 && desc.rows > 0) {
    const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
    const mm = new cv.DMatchVectorVector();
    bf.knnMatch(ref.desc, desc, mm, 2);
    for (let i = 0; i < mm.size(); i++) {
      const m = mm.get(i);
      if (m.size() < 1) continue;
      const best = m.get(0);
      const ok = m.size() < 2 || best.distance < params.ratio * m.get(1).distance;
      if (ok && best.distance <= params.maxHamming) {
        const r = ref.kps[best.queryIdx];
        P.push(r.x, r.y);
        Q.push(lp[2 * best.trainIdx], lp[2 * best.trainIdx + 1]);
        idx.push(best.queryIdx);
      }
    }
    mm.delete(); bf.delete();
    out.matchMode = 'global';
  }
  for (let k = 0; k < idx.length; k++) {
    liveXY[idx[k] * 2] = Q[2 * k];
    liveXY[idx[k] * 2 + 1] = Q[2 * k + 1];
    status[idx[k]] = 0;
  }
  out.candidates = idx.length;
  const tMatch = performance.now();

  out.ok = false;
  if (idx.length >= params.minCandidates) {
    const A = cv.matFromArray(idx.length, 1, cv.CV_32FC2, P);
    const B = cv.matFromArray(idx.length, 1, cv.CV_32FC2, Q);
    const mask = new cv.Mat();
    const Hm = cv.findHomography(A, B, cv.RANSAC, params.ransacPx, mask, 2000, 0.995);
    if (!Hm.empty()) {
      const Hpx = Array.from(Hm.data64F);
      const Pin = [], Qin = [];
      let inl = 0;
      const cov = new Set(), cells = new Set();
      for (let k = 0; k < idx.length; k++) {
        if (mask.data[k]) {
          inl++;
          status[idx[k]] = 1;
          const rx = P[2 * k], ry = P[2 * k + 1];
          Pin.push((rx - w / 2) / w, (ry - h / 2) / w);
          Qin.push((Q[2 * k] - w / 2) / w, (Q[2 * k + 1] - h / 2) / w);
          cov.add(Math.min(3, Math.floor((ry / h) * 4)) * 4 + Math.min(3, Math.floor((rx / w) * 4)));
          cells.add(ref.kps[idx[k]].cell);
        }
      }
      out.inliers = inl;
      out.inlierRatio = inl / idx.length;
      out.coverage = cov.size / Math.max(1, ref.cov4.size); // of the reference's own coverage
      out.cellCoverage = cells.size / Math.max(1, ref.cells.size);
      if (inl >= params.minInliers) {
        // homography in normalized centered coords: Hn = T * Hpx * T^-1
        const T = [1 / w, 0, -0.5, 0, 1 / w, -h / (2 * w), 0, 0, 1];
        const Ti = [w, 0, w / 2, 0, w, h / 2, 0, 0, 1];
        let Hn = mul3(mul3(T, Hpx), Ti);
        const s9 = Hn[8];
        Hn = Hn.map((v) => v / s9);
        const sim = fitSimilarity(Pin, Qin);
        // perspective component: displacement of reference corners under H vs. under the similarity
        const hh = h / (2 * w);
        const corners = [[-0.5, -hh], [0.5, -hh], [0.5, hh], [-0.5, hh]];
        let pd = 0;
        for (const [u, v] of corners) {
          const [hx, hy] = applyH(Hn, u, v);
          const sx = sim.a * u - sim.b * v + sim.tx;
          const sy = sim.b * u + sim.a * v + sim.ty;
          pd += Math.hypot(hx - sx, hy - sy);
        }
        pd /= 4;
        // homography reprojection RMS on inliers (normalized units)
        let hr = 0;
        for (let k = 0; k < Pin.length / 2; k++) {
          const [hx, hy] = applyH(Hn, Pin[2 * k], Pin[2 * k + 1]);
          hr += (hx - Qin[2 * k]) ** 2 + (hy - Qin[2 * k + 1]) ** 2;
        }
        out.ok = true;
        track = { Hpx, t: performance.now() };
        out.H = Hn;
        out.tx = sim.tx; // where the reference CENTER appears in live (normalized, +right)
        out.ty = sim.ty; // (+down)
        out.scale = sim.scale; // >1: live content larger than reference (camera too close)
        out.roll = sim.roll; // radians, + = live content rotated clockwise on screen
        out.px = Hn[6]; // keystone terms: + px => right side of reference content appears smaller (farther)
        out.py = Hn[7]; //                + py => lower side appears smaller (farther)
        out.perspResidual = pd;
        out.simRms = sim.rms;
        out.homRms = Math.sqrt(hr / Math.max(1, Pin.length / 2));
        // lighting comparison at inlier neighbourhoods (stable regions only)
        let sr = 0, sl = 0, n = 0;
        const R = 4;
        for (let k = 0; k < idx.length; k++) {
          if (!mask.data[k]) continue;
          const rx = Math.round(P[2 * k]), ry = Math.round(P[2 * k + 1]);
          const lx = Math.round(Q[2 * k]), ly = Math.round(Q[2 * k + 1]);
          for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) {
            const a1 = ry + dy, b1 = rx + dx, a2 = ly + dy, b2 = lx + dx;
            if (a1 < 0 || a1 >= h || b1 < 0 || b1 >= w || a2 < 0 || a2 >= h || b2 < 0 || b2 >= w) continue;
            sr += ref.gray[a1 * w + b1];
            sl += g[a2 * w + b2];
            n++;
          }
        }
        out.lumRatio = n ? sl / Math.max(1, sr) : null;
      }
    }
    A.delete(); B.delete(); mask.delete(); Hm.delete();
  }
  if (!out.ok && out.matchMode === 'guided' && !msg._retry) {
    // tracking prediction was wrong: drop it and re-acquire with global matching on this same frame
    track = null;
    img.delete(); kpv.delete(); desc.delete(); none.delete();
    processFrame({ ...msg, _retry: true });
    return;
  }
  if (msg._retry) out.reacquired = true;
  if (!out.ok && track && performance.now() - track.t > params.trackMaxAgeMs) track = null;
  out.status = status;
  out.liveXY = liveXY;
  out.timing = { detect: tDetect - t0, match: tMatch - tDetect, total: performance.now() - t0 };
  out.ms = out.timing.total;
  img.delete(); kpv.delete(); desc.delete(); none.delete();
  postMessage(out, [status.buffer, liveXY.buffer]);
}

self.onmessage = (e) => {
  const msg = e.data;
  if (!ready) {
    postMessage({ type: 'busy-not-ready', id: msg.id });
    return;
  }
  try {
    if (msg.type === 'setReference') setReference(msg);
    else if (msg.type === 'clearReference') { if (ref && ref.desc) ref.desc.delete(); ref = null; postMessage({ type: 'reference-cleared' }); }
    else if (msg.type === 'frame') processFrame(msg);
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, message: String(err && err.message ? err.message : err) });
  }
};
