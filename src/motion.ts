// Phone motion sensing (spec §16). Secondary evidence only: it answers
// "how did the phone move?", while CV answers "did that make the photo more like the reference?".

export interface MotionSample {
  // integrated rotation since last take() in degrees (device frame)
  dAlpha: number; // around z (screen normal) — roll of the phone
  dBeta: number; // around x — pitch
  dGamma: number; // around y — yaw
  rate: number; // current rotation rate magnitude, deg/s
  accel: number; // current linear acceleration magnitude (m/s², gravity excluded if available)
  orientation: { alpha: number | null; beta: number | null; gamma: number | null };
}

class MotionTracker {
  private acc = { a: 0, b: 0, g: 0 };
  private rate = 0;
  private accel = 0;
  private orient = { alpha: null as number | null, beta: null as number | null, gamma: null as number | null };
  private last = 0;
  private grav: { x: number; y: number; z: number } | null = null;
  started = false;
  permission: 'unknown' | 'granted' | 'denied' | 'unsupported' = 'unknown';

  private onMotion = (e: DeviceMotionEvent) => {
    const r = e.rotationRate;
    const now = performance.now();
    const dt = this.last ? Math.min(0.2, (now - this.last) / 1000) : (e.interval || 16) / 1000;
    this.last = now;
    if (r) {
      const a = r.alpha ?? 0, b = r.beta ?? 0, g = r.gamma ?? 0;
      this.acc.a += a * dt;
      this.acc.b += b * dt;
      this.acc.g += g * dt;
      this.rate = Math.hypot(a, b, g);
    }
    const g = e.accelerationIncludingGravity;
    if (g && g.x != null && g.y != null) this.grav = { x: g.x ?? 0, y: g.y ?? 0, z: g.z ?? 0 };
    const la = e.acceleration;
    if (la && la.x != null) this.accel = Math.hypot(la.x ?? 0, la.y ?? 0, la.z ?? 0);
  };
  private onOrient = (e: DeviceOrientationEvent) => {
    this.orient = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
  };

  /** Must be called from a user gesture on iOS. */
  async requestPermission(): Promise<void> {
    try {
      const DME = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
      const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
      if (!DME) {
        this.permission = 'unsupported';
        return;
      }
      if (typeof DME.requestPermission === 'function') {
        const r = await DME.requestPermission();
        if (DOE && typeof DOE.requestPermission === 'function') {
          try {
            await DOE.requestPermission();
          } catch {
            /* ignore */
          }
        }
        this.permission = r === 'granted' ? 'granted' : 'denied';
      } else {
        this.permission = 'granted';
      }
    } catch {
      this.permission = 'denied';
    }
    if (this.permission === 'granted') this.start();
  }

  start() {
    if (this.started) return;
    this.started = true;
    window.addEventListener('devicemotion', this.onMotion);
    window.addEventListener('deviceorientation', this.onOrient);
  }

  take(): MotionSample {
    const s: MotionSample = {
      dAlpha: this.acc.a,
      dBeta: this.acc.b,
      dGamma: this.acc.g,
      rate: this.rate,
      accel: this.accel,
      orientation: { ...this.orient },
    };
    this.acc = { a: 0, b: 0, g: 0 };
    return s;
  }

  peekRate() {
    return this.rate;
  }

  /**
   * Phone roll about the camera axis relative to gravity (radians, + = phone rotated clockwise),
   * for a portrait-held phone (iOS sign convention). Returns null when the phone points
   * mostly up/down (occlusal views), where roll relative to gravity is ill-defined.
   */
  phoneRoll(): number | null {
    const g = this.grav;
    if (!g) return null;
    const inPlane = Math.hypot(g.x, g.y);
    if (inPlane < 0.5 * Math.hypot(g.x, g.y, g.z)) return null;
    return Math.atan2(-g.x, -g.y);
  }
}

export const motion = new MotionTracker();
