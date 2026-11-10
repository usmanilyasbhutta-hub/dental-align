// Audio proximity guidance (parking-sensor style).
//
// Why sound: Safari gives a web app no vibration API, and the switch-toggle haptic trick stopped
// working for script-triggered haptics in iOS 26.5. Sound is the one non-visual channel a web app
// can drive continuously, so the operator can keep their eyes on the teeth.
//
//   no registration      -> silent
//   converging           -> ticks, faster and higher as alignment improves
//   aligned              -> two-note chime, then a soft steady tone while it holds

type AC = AudioContext;

class GuidanceSound {
  private ctx: AC | null = null;
  private timer = 0;
  private nextAt = 0;
  private closeness: number | null = null;
  private aligned = false;
  private wasAligned = false;
  private hum: { osc: OscillatorNode; gain: GainNode } | null = null;
  enabled = true;
  onTick: ((closeness: number) => void) | null = null;

  /** Must be called from a tap (iOS only starts audio inside a user gesture). */
  unlock() {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        // play even when the ring/silent switch is on (iOS 17+)
        const as = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
        if (as) as.type = 'playback';
      }
      if (this.ctx.state !== 'running') void this.ctx.resume();
    } catch {
      /* audio unavailable */
    }
  }

  start() {
    if (this.timer) return;
    this.timer = window.setInterval(() => this.pump(), 30);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
    this.closeness = null;
    this.aligned = false;
    this.wasAligned = false;
    this.setHum(false);
  }

  /** closeness: 0 (far) .. 1 (on target), or null when there is no registration. */
  update(closeness: number | null, aligned: boolean) {
    this.closeness = closeness;
    this.aligned = aligned;
  }

  private blip(freq: number, dur: number, vol: number, when = 0) {
    const c = this.ctx;
    if (!c || c.state !== 'running') return;
    const t = c.currentTime + when;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private setHum(on: boolean) {
    const c = this.ctx;
    if (!c) return;
    if (on && !this.hum && c.state === 'running') {
      const osc = c.createOscillator(), gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, c.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.05, c.currentTime + 0.25);
      osc.connect(gain).connect(c.destination);
      osc.start();
      this.hum = { osc, gain };
    } else if (!on && this.hum) {
      const { osc, gain } = this.hum;
      this.hum = null;
      gain.gain.cancelScheduledValues(c.currentTime);
      gain.gain.setTargetAtTime(0.0001, c.currentTime, 0.04);
      osc.stop(c.currentTime + 0.25);
    }
  }

  private pump() {
    if (!this.enabled || this.closeness == null) {
      this.setHum(false);
      this.wasAligned = false;
      return;
    }
    const now = performance.now();
    if (this.aligned) {
      if (!this.wasAligned) {
        this.blip(660, 0.12, 0.22);
        this.blip(990, 0.2, 0.22, 0.11);
        this.onTick?.(1);
      }
      this.setHum(true);
      this.wasAligned = true;
      return;
    }
    this.wasAligned = false;
    this.setHum(false);
    if (now < this.nextAt) return;
    const q = Math.max(0, Math.min(1, this.closeness));
    // 900 ms apart when far, 110 ms when almost there; pitch 330 -> 780 Hz
    this.nextAt = now + 900 - 790 * Math.pow(q, 0.8);
    this.blip(330 + 450 * q, 0.06, 0.09 + 0.1 * q);
    this.onTick?.(q);
  }
}

export const sound = new GuidanceSound();
