// Viewfinder overlay renderer (spec §18).
//
// A. Fixed ghost — rendered by an <img> with the same cover-fit as the video; never transformed.
// B. Feature correspondence — lines from each live match to its FIXED reference position,
//    colour moving continuously white → amber → green as they converge. Outliers / changed
//    anatomy fade out (never red).
// C. Puck — the image of a reference circle under the measured transform: a target ring is
//    fixed at the centre; the live ring shows where that reference circle currently is.
//    Translation moves it, distance scales it, roll turns its tick, pitch/yaw tilts it.
//    Bring the live ring onto the target. It flattens, settles and fades as you converge.

import type { EngineState } from './engine';
import type { Settings } from './settings';
import { drawGenericGuide } from './views';
import type { AngleCue } from './guidance';

export interface OverlayCtx {
  canvas: HTMLCanvasElement;
  state: EngineState;
  settings: Settings;
  viewKey: string;
  phoneRoll: number | null;
  angle: AngleCue | null;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));

function colorFor(dPx: number): [number, number, number] {
  const green: [number, number, number] = [90, 230, 140];
  const amber: [number, number, number] = [255, 190, 70];
  const white: [number, number, number] = [255, 255, 255];
  if (dPx <= 18) {
    const t = clamp((dPx - 4) / 14);
    return [lerp(green[0], amber[0], t), lerp(green[1], amber[1], t), lerp(green[2], amber[2], t)];
  }
  const t = clamp((dPx - 18) / 36);
  return [lerp(amber[0], white[0], t), lerp(amber[1], white[1], t), lerp(amber[2], white[2], t)];
}

/** object-fit: cover mapping from a source of size (sw, sh) into viewport (W, H). */
export function coverMap(sw: number, sh: number, W: number, H: number) {
  const k = Math.max(W / sw, H / sh);
  const ox = (W - sw * k) / 2, oy = (H - sh * k) / 2;
  return { k, ox, oy, map: (x: number, y: number): [number, number] => [ox + x * k, oy + y * k] };
}

export class OverlayRenderer {
  private alphas: Float32Array = new Float32Array(0);
  private puckAlpha = 0;
  private settle = 0; // 0..1 how settled (for fade-out)
  private t0 = performance.now();

  draw(o: OverlayCtx) {
    const { canvas, state: st, settings } = o;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!st.cameraReady || !st.videoDims) return;

    if (!st.hasRef) {
      drawGenericGuide(ctx, o.viewKey, W, H, o.phoneRoll);
      return;
    }
    const vd = st.videoDims, pd = st.procDims, rd = st.refDims;
    if (!pd || !rd) return;
    const vmap = coverMap(vd.w, vd.h, W, H);
    const rmap = coverMap(rd.w, rd.h, W, H);
    // processing px → screen
    const liveToScreen = (x: number, y: number) => vmap.map((x * vd.w) / pd.w, (y * vd.h) / pd.h);
    const refProcW = pd.w, refProcH = pd.h; // reference is processed at the same size when aspect matches
    const refToScreen = (x: number, y: number) => rmap.map((x * rd.w) / refProcW, (y * rd.h) / refProcH);

    const g = st.smooth;
    const E = g?.E ?? 1;
    const q = clamp(E / settings.convergingE); // 1 = far, 0 = aligned
    const strong = !!g && E < settings.strongE;
    this.settle = lerp(this.settle, strong ? 1 : 0, strong ? 0.06 : 0.25);

    // ---------- B. feature correspondence
    const pts = st.refPoints;
    if (this.alphas.length !== pts.length) this.alphas = new Float32Array(pts.length);
    const last = st.last;
    const status = last?.status && last.status.length === pts.length ? last.status : null;
    const lxy = last?.liveXY;
    const quiet = 0.3 + 0.7 * q; // the closer, the quieter
    ctx.lineCap = 'round';
    for (let i = 0; i < pts.length; i++) {
      const s = status ? status[i] : -1;
      const target = s === 1 ? 1 : 0.06;
      this.alphas[i] = lerp(this.alphas[i], target, s === 1 ? 0.35 : 0.12);
      const a = this.alphas[i] * quiet * (1 - 0.7 * this.settle);
      if (a < 0.02) continue;
      const [rx, ry] = refToScreen(pts[i].x, pts[i].y);
      if (s === 1 && lxy) {
        const [lx, ly] = liveToScreen(lxy[i * 2], lxy[i * 2 + 1]);
        const d = Math.hypot(lx - rx, ly - ry);
        const [r, gg, b] = colorFor(d);
        ctx.strokeStyle = `rgba(${r | 0},${gg | 0},${b | 0},${a * 0.75})`;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(rx, ry);
        ctx.stroke();
        ctx.fillStyle = `rgba(${r | 0},${gg | 0},${b | 0},${a})`;
        ctx.beginPath();
        ctx.arc(rx, ry, 2.2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.beginPath();
        ctx.arc(rx, ry, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ---------- C. puck
    const R0 = Math.min(W, H) * 0.14;
    const kScreenPerNorm = vmap.k * vd.w; // screen px per normalized (image-width) unit
    const rn = R0 / kScreenPerNorm;
    const normToScreen = (u: number, v: number) => liveToScreen(u * pd.w + pd.w / 2, v * pd.w + pd.h / 2);
    const [tcx, tcy] = normToScreen(0, 0);
    const time = (performance.now() - this.t0) / 1000;

    // target ring (fixed)
    const targetA = g ? lerp(0.55, 0.12, this.settle) : 0.25 + 0.15 * Math.sin(time * 3);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = strong ? `rgba(110,235,160,${targetA + 0.2 * (1 - this.settle)})` : `rgba(255,255,255,${targetA})`;
    ctx.beginPath();
    ctx.arc(tcx, tcy, R0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tcx, tcy - R0 - 6);
    ctx.lineTo(tcx, tcy - R0 + 6);
    ctx.stroke();

    this.puckAlpha = lerp(this.puckAlpha, g ? 1 : 0, 0.25);
    if (g && this.puckAlpha > 0.02) {
      const s = g.scale, th = g.roll;
      const A = s * Math.cos(th), B = s * Math.sin(th);
      const GAIN = 0; // angulation now has its own crosshair cue; the ring shows position, distance, roll
      const gx = GAIN * g.px * (settings.flipYaw ? -1 : 1);
      const gy = GAIN * g.py * (settings.flipPitch ? -1 : 1);
      const proj = (u: number, v: number): [number, number] => {
        const ww = 1 + gx * u + gy * v; // keystone term of the (exaggerated) homography
        const X = (A * u - B * v) / ww + g.tx;
        const Y = (B * u + A * v) / ww + g.ty;
        return normToScreen(X, Y);
      };
      let [ccx, ccy] = proj(0, 0);
      // clamp off-screen centre and show an edge chevron
      const margin = 40;
      const off = ccx < margin || ccx > W - margin || ccy < margin || ccy > H - margin;
      const a = this.puckAlpha * lerp(1, 0.08, this.settle) * (0.45 + 0.55 * Math.sqrt(q));
      const [r, gg, b] = colorFor(Math.hypot(ccx - tcx, ccy - tcy) + Math.abs(Math.log(s)) * 300 + Math.abs(th) * 300);
      const col = (al: number) => `rgba(${r | 0},${gg | 0},${b | 0},${al})`;
      if (off) {
        const ang = Math.atan2(ccy - tcy, ccx - tcx);
        const ex = clamp(ccx, margin, W - margin), ey = clamp(ccy, margin, H - margin);
        ctx.save();
        ctx.translate(ex, ey);
        ctx.rotate(ang);
        ctx.strokeStyle = col(Math.max(0.6, a));
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-10, -12);
        ctx.lineTo(4, 0);
        ctx.lineTo(-10, 12);
        ctx.stroke();
        ctx.restore();
        ccx = ex;
        ccy = ey;
      } else {
        // live ring: image of the reference circle under the measured transform
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = col(a);
        ctx.fillStyle = col(a * 0.12);
        ctx.beginPath();
        const N = 64;
        for (let k = 0; k <= N; k++) {
          const ang = (k / N) * Math.PI * 2;
          const [x, y] = proj(rn * Math.cos(ang), rn * Math.sin(ang));
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.fill();
        ctx.stroke();
        // roll tick (top of the reference circle)
        const [t1x, t1y] = proj(0, -rn * 1.0);
        const [t2x, t2y] = proj(0, -rn * 0.72);
        ctx.beginPath();
        ctx.moveTo(t1x, t1y);
        ctx.lineTo(t2x, t2y);
        ctx.stroke();
        // centre dot
        ctx.beginPath();
        ctx.arc(ccx, ccy, 3, 0, Math.PI * 2);
        ctx.fillStyle = col(a);
        ctx.fill();
      }
    }

    this.drawAngle(ctx, o, W, H);
  }

  /** Angulation crosshair: fixed "+" at the centre, moving "+" shows where to aim. */
  private drawAngle(ctx: CanvasRenderingContext2D, o: OverlayCtx, W: number, H: number) {
    const a = o.angle;
    if (!a) return;
    const tol = o.settings.angleTolDeg;
    const cx = W / 2, cy = H / 2;
    const K = 8 * (180 / Math.PI); // 8 px per degree
    const maxR = Math.min(W, H) * 0.42;
    let dx = a.x * K, dy = a.y * K;
    const r = Math.hypot(dx, dy);
    if (r > maxR) { dx *= maxR / r; dy *= maxR / r; }
    const ok = a.deg <= tol;
    const col = ok ? '110,235,160' : a.deg <= tol * 3 ? '255,190,70' : '255,255,255';
    const alpha = ok ? 0.55 : 0.95;
    const arm = 11;
    ctx.save();
    ctx.lineCap = 'round';
    // fixed target
    ctx.strokeStyle = `rgba(255,255,255,${ok ? 0.35 : 0.7})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - arm, cy); ctx.lineTo(cx - 4, cy); ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + arm, cy);
    ctx.moveTo(cx, cy - arm); ctx.lineTo(cx, cy - 4); ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + arm);
    ctx.stroke();
    // link + moving cross
    if (!ok) {
      ctx.setLineDash([3, 5]);
      ctx.strokeStyle = `rgba(${col},0.5)`;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + dx, cy + dy); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = `rgba(${col},${alpha})`;
    ctx.lineWidth = 3;
    const mx = cx + dx, my = cy + dy;
    ctx.beginPath();
    ctx.moveTo(mx - arm, my); ctx.lineTo(mx + arm, my); ctx.moveTo(mx, my - arm); ctx.lineTo(mx, my + arm);
    ctx.stroke();
    if (r > maxR) {
      // off-scale: arrowhead on the cross pointing outward
      const ang = Math.atan2(dy, dx);
      ctx.translate(mx, my); ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(arm + 2, -7); ctx.lineTo(arm + 12, 0); ctx.lineTo(arm + 2, 7); ctx.stroke();
    }
    ctx.restore();
  }
}
