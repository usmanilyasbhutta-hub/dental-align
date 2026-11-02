// Dental Align capture engine.
//
//  camera frame ─► processing image (gray, downscaled) ─► CV worker ─► registration metrics
//        │                                                             │
//        └─► full-resolution frame ring buffer ◄── metrics attached ───┘
//                                │
//                 shutter intent ─► temporal best-frame selection ─► untouched master JPEG
//
// The reference is never transformed. Registration results are only used to measure error,
// drive guidance, and choose among genuinely captured frames.

import type { Settings } from './settings';
import { motion, type MotionSample } from './motion';
import { haptic } from './haptics';

export type Phase = 'searching' | 'converging' | 'strong' | 'peak';

export interface RefPoint {
  x: number;
  y: number;
  response: number;
  cell: number;
}

export interface Registration {
  ok: boolean;
  tx: number;
  ty: number;
  scale: number;
  roll: number;
  px: number;
  py: number;
  perspResidual: number;
  E: number; // total error (fraction of image width, combined)
  Et: number;
  Es: number;
  Er: number;
  Ep: number;
}

export interface FrameResult {
  id: number;
  t: number;
  w: number;
  h: number;
  hasRef: boolean;
  ok?: boolean;
  error?: string;
  sharpness: number;
  brightness: { mean: number; clipped: number; crushed: number };
  liveFeatures?: number;
  matchMode?: 'none' | 'guided' | 'global';
  reacquired?: boolean;
  candidates?: number;
  inliers?: number;
  inlierRatio?: number;
  coverage?: number;
  cellCoverage?: number;
  tx?: number;
  ty?: number;
  scale?: number;
  roll?: number;
  px?: number;
  py?: number;
  perspResidual?: number;
  simRms?: number;
  homRms?: number;
  lumRatio?: number | null;
  H?: number[];
  status?: Int8Array;
  liveXY?: Float32Array;
  ms: number;
  timing?: { detect: number; match: number; total: number };
}

export interface EngineState {
  phase: Phase;
  hasRef: boolean;
  workerReady: boolean;
  cameraReady: boolean;
  error: string | null;
  aspectMismatch: boolean;
  last: FrameResult | null;
  smooth: Registration | null; // smoothed estimate used for guidance
  raw: Registration | null;
  sharpOk: boolean;
  motionRate: number;
  fps: number;
  procMs: number;
  dropped: number;
  refPoints: RefPoint[];
  refDims: { w: number; h: number } | null;
  videoDims: { w: number; h: number } | null;
  procDims: { w: number; h: number } | null;
  capturing: boolean;
  lightingHint: 'darker' | 'brighter' | null;
  controllerJ: number[] | null; // learned d(tx,ty)/d(gamma,beta) in width-units per degree
  convergeCount: number;
}

interface RingEntry {
  id: number;
  t: number;
  bitmap: ImageBitmap | null;
  pending: Promise<ImageBitmap | null>;
  result: FrameResult | null;
  motion: number;
}

export interface CaptureOutput {
  master: Blob;
  thumb: Blob;
  width: number;
  height: number;
  meta: Record<string, unknown>;
}

const RING_PREV = 4;
const RING_NEXT = 3;

function regFrom(r: FrameResult): Registration | null {
  if (!r.ok || r.tx == null) return null;
  const Et = Math.hypot(r.tx, r.ty!);
  const Es = Math.abs(Math.log(r.scale!));
  const Er = Math.abs(r.roll!) * 0.5;
  const Ep = r.perspResidual!;
  return {
    ok: true,
    tx: r.tx,
    ty: r.ty!,
    scale: r.scale!,
    roll: r.roll!,
    px: r.px!,
    py: r.py!,
    perspResidual: Ep,
    Et,
    Es,
    Er,
    Ep,
    E: Et + Es + Er + Ep,
  };
}

function recomputeE(g: Registration): Registration {
  g.Et = Math.hypot(g.tx, g.ty);
  g.Es = Math.abs(Math.log(g.scale));
  g.Er = Math.abs(g.roll) * 0.5;
  g.Ep = g.perspResidual;
  g.E = g.Et + g.Es + g.Er + g.Ep;
  return g;
}

export class CaptureEngine {
  video: HTMLVideoElement;
  settings: Settings;
  stream: MediaStream | null = null;
  track: MediaStreamTrack | null = null;
  worker: Worker;
  state: EngineState;
  onState: (s: EngineState) => void = () => {};
  onLog: (row: Record<string, unknown>) => void = () => {};
  onEvent: (ev: Record<string, unknown>) => void = () => {};

  private procCanvas = document.createElement('canvas');
  private procCtx: CanvasRenderingContext2D;
  private cropCanvas = document.createElement('canvas');
  private cropCtx: CanvasRenderingContext2D;
  private busy = false;
  private frameId = 0;
  private running = false;
  private ring: RingEntry[] = [];
  private lastResultT = 0;
  private fpsEma = 0;
  private prevRaw: Registration | null = null;
  private lastOkT = 0;
  private strongLatched = false;
  private peakLatched = false;
  private peakStreak = 0;
  private autoCaptured = false;
  private captureReq: { intentId: number; resolve: (o: CaptureOutput | null) => void; reject: (e: unknown) => void; t: number; afterCount: number } | null = null;
  private rvfcHandle = 0;
  private rafHandle = 0;
  private motionAcc: MotionSample | null = null;
  // RLS controller model: Δ[tx,ty] ≈ J · [dGamma, dBeta]   (spec §17 ΔPose → ΔE)
  private J = [0, 0, 0, 0];
  private P = [1e3, 0, 0, 1e3];
  private jSamples = 0;
  private sentAt = new Map<number, number>();

  constructor(video: HTMLVideoElement, settings: Settings) {
    this.video = video;
    this.settings = settings;
    this.procCtx = this.procCanvas.getContext('2d', { willReadFrequently: true })!;
    this.cropCtx = this.cropCanvas.getContext('2d', { willReadFrequently: true })!;
    this.state = {
      phase: 'searching',
      hasRef: false,
      workerReady: false,
      cameraReady: false,
      error: null,
      aspectMismatch: false,
      last: null,
      smooth: null,
      raw: null,
      sharpOk: false,
      motionRate: 0,
      fps: 0,
      procMs: 0,
      dropped: 0,
      refPoints: [],
      refDims: null,
      videoDims: null,
      procDims: null,
      capturing: false,
      lightingHint: null,
      controllerJ: null,
      convergeCount: 0,
    };
    this.worker = new Worker(`${import.meta.env.BASE_URL}cv-worker.js`);
    this.worker.onmessage = (e) => this.onWorker(e.data);
    this.worker.onerror = (e) => this.fail('CV worker error: ' + (e.message || 'unknown'));
  }

  private emit() {
    this.onState({ ...this.state });
  }
  private fail(msg: string) {
    this.state.error = msg;
    this.emit();
  }

  // ------------------------------------------------------------------ camera
  async startCamera() {
    const hi = this.settings.resolution === '4k';
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: hi ? 3840 : 1920 },
        height: { ideal: hi ? 2160 : 1080 },
        frameRate: { ideal: 30 },
      },
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      this.fail('Camera unavailable: ' + (e as Error).message + '. Camera access needs HTTPS and permission.');
      return;
    }
    this.track = this.stream.getVideoTracks()[0];
    // Keep zoom fixed (spec §21) where the platform exposes it.
    try {
      const caps = (this.track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { zoom?: { min: number; max: number } };
      if (caps.zoom) {
        const z = Math.max(caps.zoom.min, Math.min(caps.zoom.max, 1));
        await this.track.applyConstraints({ advanced: [{ zoom: z } as unknown as MediaTrackConstraintSet] });
      }
    } catch {
      /* not supported */
    }
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play().catch(() => {});
    await new Promise<void>((res) => {
      if (this.video.videoWidth) return res();
      this.video.onloadedmetadata = () => res();
    });
    this.state.cameraReady = true;
    this.state.videoDims = { w: this.video.videoWidth, h: this.video.videoHeight };
    this.onEvent({ type: 'camera', settings: this.cameraInfo() });
    this.emit();
    this.running = true;
    this.schedule();
  }

  cameraInfo(): Record<string, unknown> {
    const s = this.track?.getSettings?.() ?? {};
    let caps: Record<string, unknown> = {};
    try {
      caps = (this.track?.getCapabilities?.() ?? {}) as Record<string, unknown>;
    } catch {
      /* */
    }
    return {
      label: this.track?.label,
      settings: s,
      capabilities: caps,
      video: { w: this.video.videoWidth, h: this.video.videoHeight },
    };
  }

  stop() {
    this.running = false;
    const v = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
    if (this.rvfcHandle && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this.rvfcHandle);
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.worker.terminate();
    for (const r of this.ring) r.bitmap?.close();
    this.ring = [];
  }

  private schedule() {
    if (!this.running) return;
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (v.requestVideoFrameCallback) this.rvfcHandle = v.requestVideoFrameCallback(() => this.tick());
    else this.rafHandle = requestAnimationFrame(() => this.tick());
  }

  // ------------------------------------------------------------------ frame loop
  private tick() {
    if (!this.running) return;
    if (!this.state.workerReady || !this.video.videoWidth) {
      this.schedule();
      return;
    }
    if (this.busy) {
      this.state.dropped++;
      this.schedule();
      return;
    }
    this.sendFrame();
    this.schedule();
  }

  private procSize(vw: number, vh: number) {
    const s = this.settings.procLong / Math.max(vw, vh);
    return { w: Math.round(vw * s), h: Math.round(vh * s) };
  }

  private sendFrame() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!this.state.videoDims || this.state.videoDims.w !== vw || this.state.videoDims.h !== vh) {
      this.state.videoDims = { w: vw, h: vh };
      this.onEvent({ type: 'video-dims-changed', w: vw, h: vh });
    }
    const { w, h } = this.procSize(vw, vh);
    if (this.procCanvas.width !== w || this.procCanvas.height !== h) {
      this.procCanvas.width = w;
      this.procCanvas.height = h;
    }
    this.state.procDims = { w, h };
    this.procCtx.drawImage(this.video, 0, 0, w, h);
    const gray = toGray(this.procCtx.getImageData(0, 0, w, h));
    // native-resolution centre crop for focus/sharpness assessment
    const cs = Math.min(384, vw, vh);
    if (this.cropCanvas.width !== cs) {
      this.cropCanvas.width = cs;
      this.cropCanvas.height = cs;
    }
    this.cropCtx.drawImage(this.video, (vw - cs) / 2, (vh - cs) / 2, cs, cs, 0, 0, cs, cs);
    const crop = toGray(this.cropCtx.getImageData(0, 0, cs, cs));

    const id = ++this.frameId;
    // full-resolution frame for the temporal best-frame buffer
    const entry: RingEntry = { id, t: performance.now(), bitmap: null, pending: Promise.resolve(null), result: null, motion: motion.peekRate() };
    entry.pending = createImageBitmap(this.video)
      .then((b) => {
        entry.bitmap = b;
        return b;
      })
      .catch(() => null);
    this.ring.push(entry);
    this.pruneRing();

    this.busy = true;
    this.sentAt.set(id, performance.now());
    const s = this.settings;
    this.worker.postMessage(
      {
        type: 'frame',
        id,
        w,
        h,
        gray: gray.buffer,
        crop: crop.buffer,
        cropW: cs,
        cropH: cs,
        params: {
          clahe: s.clahe,
          liveDetect: s.liveDetect,
          ratio: s.ratio,
          maxHamming: s.maxHamming,
          ransacPx: s.ransacPx,
          minCandidates: s.minCandidates,
          minInliers: s.minInliers,
          trackMaxAgeMs: s.tracking ? 400 : 0,
          trackRadius: s.trackRadius,
          trackMaxHamming: s.trackMaxHamming,
          trackRatio: s.trackRatio,
        },
      },
      [gray.buffer, crop.buffer],
    );
  }

  private pruneRing() {
    // keep RING_PREV completed frames, plus anything needed by an active capture window
    const keepFrom = this.captureReq ? this.captureReq.intentId - RING_PREV : this.frameId - RING_PREV - 1;
    const maxKeep = this.settings.resolution === '4k' ? 5 : RING_PREV + RING_NEXT + 3;
    while (this.ring.length && (this.ring[0].id < keepFrom || this.ring.length > maxKeep)) {
      const r = this.ring.shift()!;
      if (r.bitmap) r.bitmap.close();
      else r.pending.then((b) => b?.close());
    }
  }

  // ------------------------------------------------------------------ reference
  async setReference(blob: Blob | null) {
    if (!blob) {
      this.state.hasRef = false;
      this.state.refPoints = [];
      this.state.refDims = null;
      this.worker.postMessage({ type: 'clearReference' });
      this.emit();
      return;
    }
    const bmp = await createImageBitmap(blob);
    const { w, h } = this.procSize(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0, w, h);
    const gray = toGray(ctx.getImageData(0, 0, w, h));
    this.state.refDims = { w: bmp.width, h: bmp.height };
    bmp.close();
    const s = this.settings;
    this.worker.postMessage(
      { type: 'setReference', w, h, gray: gray.buffer, params: { clahe: s.clahe, refDetect: s.refDetect, refTarget: s.refTarget, refGrid: s.refGrid } },
      [gray.buffer],
    );
  }
  private refQueue: Blob | null | undefined = undefined;

  /** Queue a reference until the worker is ready. */
  requestReference(blob: Blob | null) {
    if (!this.state.workerReady) {
      this.refQueue = blob;
      return;
    }
    void this.setReference(blob);
  }

  // ------------------------------------------------------------------ worker results
  private onWorker(m: Record<string, unknown> & { type: string }) {
    if (m.type === 'ready') {
      this.state.workerReady = true;
      this.onEvent({ type: 'worker-ready' });
      if (this.refQueue !== undefined) {
        void this.setReference(this.refQueue);
        this.refQueue = undefined;
      }
      this.emit();
      return;
    }
    if (m.type === 'error') {
      this.busy = false;
      this.onEvent({ type: 'worker-error', message: m.message });
      if (!this.state.workerReady) this.fail(String(m.message));
      return;
    }
    if (m.type === 'reference') {
      this.state.hasRef = true;
      this.state.refPoints = m.points as RefPoint[];
      this.prevRaw = null;
      this.state.smooth = null;
      this.strongLatched = false;
      this.peakLatched = false;
      this.autoCaptured = false;
      this.onEvent({ type: 'reference-set', detected: m.detected, kept: (m.points as RefPoint[]).length, coverage4: m.coverage4, ms: m.ms });
      this.emit();
      return;
    }
    if (m.type === 'result') this.onResult(m as unknown as FrameResult);
  }

  private onResult(r: FrameResult) {
    this.busy = false;
    const now = performance.now();
    r.t = now;
    const sent = this.sentAt.get(r.id);
    this.sentAt.delete(r.id);
    const latency = sent ? now - sent : r.ms;
    if (this.lastResultT) {
      const inst = 1000 / (now - this.lastResultT);
      this.fpsEma = this.fpsEma ? this.fpsEma * 0.85 + inst * 0.15 : inst;
    }
    this.lastResultT = now;
    const entry = this.ring.find((e) => e.id === r.id);
    if (entry) entry.result = r;

    const m = motion.take();
    this.motionAcc = m;
    const s = this.settings;
    const st = this.state;
    st.last = r;
    st.fps = this.fpsEma;
    st.procMs = r.ms;
    st.motionRate = m.rate;
    st.sharpOk = r.sharpness >= s.sharpMin;
    st.aspectMismatch = r.error === 'aspect';

    const raw = r.hasRef ? regFrom(r) : null;
    st.raw = raw;
    // ---- temporal smoothing
    if (raw) {
      this.lastOkT = now;
      const a = s.smoothing;
      if (!st.smooth) st.smooth = { ...raw };
      else {
        const g = st.smooth;
        g.tx += a * (raw.tx - g.tx);
        g.ty += a * (raw.ty - g.ty);
        g.scale = Math.exp(Math.log(g.scale) + a * (Math.log(raw.scale) - Math.log(g.scale)));
        g.roll += a * (raw.roll - g.roll);
        g.px += a * (raw.px - g.px);
        g.py += a * (raw.py - g.py);
        g.perspResidual += a * (raw.perspResidual - g.perspResidual);
        recomputeE(g);
      }
    } else if (now - this.lastOkT > 600) {
      st.smooth = null;
    }

    // ---- controller learning: observed Δ(tx,ty) vs. phone rotation (RLS)
    let followed: number | null = null;
    let improved: boolean | null = null;
    let dE: number | null = null;
    if (raw && this.prevRaw) {
      const dtx = raw.tx - this.prevRaw.tx, dty = raw.ty - this.prevRaw.ty;
      dE = raw.E - this.prevRaw.E;
      improved = dE < 0;
      // desired content motion is towards the centre: -t
      const desired = [-this.prevRaw.tx, -this.prevRaw.ty];
      const nd = Math.hypot(desired[0], desired[1]), no = Math.hypot(dtx, dty);
      if (nd > 1e-4 && no > 1e-4) followed = (desired[0] * dtx + desired[1] * dty) / (nd * no);
      const x = [m.dGamma, m.dBeta];
      if (Math.hypot(x[0], x[1]) > 0.15 && Math.hypot(x[0], x[1]) < 10) this.rlsUpdate(x, [dtx, dty]);
    }
    this.prevRaw = raw;
    st.controllerJ = this.jSamples > 10 ? [...this.J] : null;

    // ---- gravity angulation error vs. baseline (if the baseline stored its attitude)
    let angleGravityDeg: number | null = null;
    {
      const n = motion.gravity(), b = this.baseGravity;
      if (n && b) {
        const ax = b.y * n.z - b.z * n.y, ay = b.z * n.x - b.x * n.z;
        angleGravityDeg = (Math.asin(Math.min(1, Math.hypot(ax, ay))) * 180) / Math.PI;
      }
    }
    const angleBlocks = s.angleSource !== 'image' && angleGravityDeg != null && angleGravityDeg > s.angleTolDeg * 2;

    // ---- phase
    const prevPhase = st.phase;
    let phase: Phase;
    if (!r.hasRef) {
      phase = st.sharpOk && m.rate < s.motionMax ? 'peak' : 'converging';
    } else if (!st.smooth) phase = 'searching';
    else if (st.smooth.E < s.strongE) phase = st.sharpOk && m.rate < s.motionMax ? 'peak' : 'strong';
    else if (st.smooth.E < s.convergingE) phase = 'converging';
    else phase = 'converging';
    if (r.hasRef && angleBlocks && (phase === 'strong' || phase === 'peak')) phase = 'converging';
    st.phase = phase;

    // haptics with hysteresis (spec §18D)
    if (r.hasRef && st.smooth) {
      if (!this.strongLatched && st.smooth.E < s.strongE && !angleBlocks) {
        this.strongLatched = true;
        if (s.haptics) haptic('tick');
        this.onEvent({ type: 'strong-convergence', E: st.smooth.E });
      } else if (this.strongLatched && st.smooth.E > s.strongE * 1.6) this.strongLatched = false;
      if (!this.peakLatched && phase === 'peak') {
        this.peakLatched = true;
        if (s.haptics) haptic('success');
      } else if (this.peakLatched && phase !== 'peak' && st.smooth.E > s.strongE * 1.3) this.peakLatched = false;
    }
    this.peakStreak = phase === 'peak' ? this.peakStreak + 1 : 0;
    st.convergeCount = this.peakStreak;

    // lighting comparison only once geometry is close (secondary, spec §23)
    st.lightingHint = null;
    if (raw && st.smooth && st.smooth.E < s.convergingE && r.lumRatio != null) {
      if (r.lumRatio < 0.8) st.lightingHint = 'darker';
      else if (r.lumRatio > 1.25) st.lightingHint = 'brighter';
    }

    if (prevPhase !== phase) this.onEvent({ type: 'phase', from: prevPhase, to: phase });

    // ---- frame-by-frame diagnostic log (spec §31)
    const g = st.smooth;
    this.onLog({
      id: r.id,
      t: Math.round(now),
      hasRef: r.hasRef,
      refFeatures: st.refPoints.length,
      liveFeatures: r.liveFeatures ?? null,
      matchMode: r.matchMode ?? null,
      reacquired: !!r.reacquired,
      candidates: r.candidates ?? null,
      inliers: r.inliers ?? null,
      inlierRatio: r.inlierRatio ?? null,
      coverage: r.coverage ?? null,
      cellCoverage: r.cellCoverage ?? null,
      ok: !!raw,
      tx: raw?.tx ?? null,
      ty: raw?.ty ?? null,
      scale: raw?.scale ?? null,
      rollDeg: raw ? (raw.roll * 180) / Math.PI : null,
      px: raw?.px ?? null,
      py: raw?.py ?? null,
      transResid: raw?.Et ?? null,
      scaleResid: raw?.Es ?? null,
      rollResid: raw?.Er ?? null,
      perspResid: raw?.Ep ?? null,
      E: raw?.E ?? null,
      E_smooth: g?.E ?? null,
      simRms: r.simRms ?? null,
      homRms: r.homRms ?? null,
      sharpness: r.sharpness,
      lumMean: r.brightness?.mean,
      clipped: r.brightness?.clipped,
      lumRatio: r.lumRatio ?? null,
      gyroRate: m.rate,
      accel: m.accel,
      dAlpha: m.dAlpha,
      dBeta: m.dBeta,
      dGamma: m.dGamma,
      angleGravityDeg,
      angleImageDeg: raw ? (Math.hypot(raw.px, raw.py) * 1.45 * 180) / Math.PI : null,
      guideX: g ? -g.tx : null, // desired content motion (screen direction)
      guideY: g ? -g.ty : null,
      guideScale: g ? 1 / g.scale : null,
      guideRollDeg: g ? (-g.roll * 180) / Math.PI : null,
      followed,
      improved,
      dE,
      phase,
      procMs: r.ms,
      detectMs: r.timing?.detect ?? null,
      matchMs: r.timing?.match ?? null,
      latencyMs: latency,
      fps: this.fpsEma,
      dropped: st.dropped,
      error: r.error ?? null,
    });

    // ---- auto-capture (optional)
    if (s.autoCapture && r.hasRef && !this.autoCaptured && !this.captureReq && this.peakStreak >= 6) {
      this.autoCaptured = true;
      this.onEvent({ type: 'auto-capture' });
      this.autoCaptureCb?.();
    }

    // ---- capture window
    if (this.captureReq) {
      const cr = this.captureReq;
      if (r.id > cr.intentId) cr.afterCount++;
      if (cr.afterCount >= RING_NEXT || now - cr.t > 900) void this.finishCapture();
    }
    this.pruneRing();
    this.emit();
  }

  autoCaptureCb: (() => void) | null = null;
  /** baseline gravity (device frame) if the baseline stored it; used for logging the angle error */
  baseGravity: { x: number; y: number; z: number } | null = null;

  private rlsUpdate(x: number[], y: number[]) {
    // independent RLS for each output row sharing P (2x2), forgetting factor
    const lam = 0.98;
    const P = this.P;
    const Px = [P[0] * x[0] + P[1] * x[1], P[2] * x[0] + P[3] * x[1]];
    const den = lam + x[0] * Px[0] + x[1] * Px[1];
    const K = [Px[0] / den, Px[1] / den];
    for (let row = 0; row < 2; row++) {
      const pred = this.J[row * 2] * x[0] + this.J[row * 2 + 1] * x[1];
      const err = y[row] - pred;
      this.J[row * 2] += K[0] * err;
      this.J[row * 2 + 1] += K[1] * err;
    }
    const xP = [x[0] * P[0] + x[1] * P[2], x[0] * P[1] + x[1] * P[3]];
    this.P = [(P[0] - K[0] * xP[0]) / lam, (P[1] - K[0] * xP[1]) / lam, (P[2] - K[1] * xP[0]) / lam, (P[3] - K[1] * xP[1]) / lam];
    this.jSamples++;
  }

  // ------------------------------------------------------------------ temporal best-frame capture
  capture(): Promise<CaptureOutput | null> {
    if (this.captureReq) return Promise.resolve(null);
    this.state.capturing = true;
    this.emit();
    return new Promise((resolve, reject) => {
      this.captureReq = { intentId: this.frameId, resolve, reject, t: performance.now(), afterCount: 0 };
      this.onEvent({ type: 'shutter-intent', frame: this.frameId });
      if (!this.running || !this.state.workerReady) void this.finishCapture();
    });
  }

  private score(e: RingEntry, maxSharp: number): number {
    const r = e.result!;
    const sharpNorm = maxSharp > 0 ? r.sharpness / maxSharp : 0;
    const motionPen = Math.min(1, e.motion / 120);
    const exposurePen = (r.brightness?.clipped ?? 0) * 2 + (r.brightness?.crushed ?? 0);
    if (r.hasRef) {
      const reg = regFrom(r);
      const geo = reg ? reg.E : 1;
      // geometry dominates; sharpness/motion/exposure break ties among near-equal geometry
      return geo + (1 - sharpNorm) * 0.02 + motionPen * 0.015 + exposurePen * 0.05;
    }
    return (1 - sharpNorm) + motionPen * 0.5 + exposurePen;
  }

  private async finishCapture() {
    const cr = this.captureReq;
    if (!cr) return;
    this.captureReq = null;
    try {
      const lo = cr.intentId - RING_PREV + 1, hi = cr.intentId + RING_NEXT;
      let cands = this.ring.filter((e) => e.id >= lo && e.id <= hi && e.result);
      if (!cands.length) cands = this.ring.filter((e) => e.result).slice(-1);
      if (!cands.length && this.ring.length) cands = [this.ring[this.ring.length - 1]];
      let chosen: RingEntry | null = null;
      const scored: Record<string, unknown>[] = [];
      if (cands.length && cands[0].result) {
        const maxSharp = Math.max(...cands.map((c) => c.result?.sharpness ?? 0));
        let best = Infinity;
        for (const c of cands) {
          if (!c.result) continue;
          const sc = this.score(c, maxSharp);
          const reg = regFrom(c.result);
          scored.push({ frame: c.id, offset: c.id - cr.intentId, score: sc, E: reg?.E ?? null, sharpness: c.result.sharpness, motion: c.motion, inliers: c.result.inliers ?? null });
          if (sc < best) {
            best = sc;
            chosen = c;
          }
        }
      } else chosen = cands[0] ?? null;

      let bmp: ImageBitmap | null = null;
      if (chosen) {
        // take ownership so ring pruning cannot release it while we encode
        this.ring = this.ring.filter((e) => e !== chosen);
        bmp = chosen.bitmap ?? (await chosen.pending);
      }
      let width: number, height: number;
      const full = document.createElement('canvas');
      if (bmp) {
        width = bmp.width;
        height = bmp.height;
        full.width = width;
        full.height = height;
        full.getContext('2d')!.drawImage(bmp, 0, 0); // 1:1 copy, no geometric change
        bmp.close();
      } else {
        // fallback: grab current video frame
        width = this.video.videoWidth;
        height = this.video.videoHeight;
        full.width = width;
        full.height = height;
        full.getContext('2d')!.drawImage(this.video, 0, 0);
      }
      const master = await canvasBlob(full, 'image/jpeg', 0.95);
      const tc = document.createElement('canvas');
      const ts = 360 / Math.max(width, height);
      tc.width = Math.round(width * ts);
      tc.height = Math.round(height * ts);
      tc.getContext('2d')!.drawImage(full, 0, 0, tc.width, tc.height);
      const thumb = await canvasBlob(tc, 'image/jpeg', 0.8);
      const r = chosen?.result ?? null;
      const reg = r ? regFrom(r) : null;
      const meta: Record<string, unknown> = {
        capturedAt: new Date().toISOString(),
        camera: this.cameraInfo(),
        userAgent: navigator.userAgent,
        procDims: this.state.procDims,
        selection: { intentFrame: cr.intentId, chosenFrame: chosen?.id ?? null, candidates: scored },
        registration: reg
          ? { tx: reg.tx, ty: reg.ty, scale: reg.scale, rollDeg: (reg.roll * 180) / Math.PI, px: reg.px, py: reg.py, E: reg.E, inliers: r?.inliers, candidates: r?.candidates, inlierRatio: r?.inlierRatio, coverage: r?.coverage }
          : null,
        sharpness: r?.sharpness ?? null,
        brightness: r?.brightness ?? null,
        motion: { rate: chosen?.motion ?? null, last: this.motionAcc },
        // phone attitude at capture: lets follow-ups reproduce angulation from the gravity sensor
        attitude: { gravity: motion.gravity(), orientation: this.motionAcc?.orientation ?? null },
        settings: this.settings,
        integrity: 'Untouched acquisition: selected camera frame encoded 1:1, no warp, crop, or enhancement.',
      };
      this.onEvent({ type: 'captured', chosen: chosen?.id, intent: cr.intentId, candidates: scored.length });
      if (this.settings.haptics) haptic('tick');
      cr.resolve({ master, thumb, width, height, meta });
    } catch (e) {
      cr.reject(e);
    } finally {
      this.state.capturing = false;
      this.emit();
    }
  }
}

function toGray(img: ImageData): Uint8Array {
  const d = img.data;
  const g = new Uint8Array(img.width * img.height);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return g;
}

function canvasBlob(c: HTMLCanvasElement, type: string, q: number): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, q));
}
