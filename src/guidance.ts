// Angulation cue + coaching (added after the first real-world test: "angulation problems,
// guidance limited").
//
// Angle cue: a crosshair showing where to AIM the camera to restore the baseline angulation.
//   Source "gravity": the phone's gravity vector at baseline capture vs. now. Instant (sensor rate),
//     noise-free, independent of image features. Assumes the subject keeps its own orientation
//     (true for an object on a table; only approximately true for a patient's head).
//   Source "image": the homography keystone terms (px, py). Slower and noisier, but measures the
//     camera relative to the actual subject. Used when the baseline has no stored attitude.
//
// Conventions (iOS device frame: x right, y up, z out of screen). Output is in screen directions:
//   cue.x < 0 → aim further left, cue.y > 0 → aim lower. Units: radians.

import type { Registration } from './engine';

export type Vec3 = { x: number; y: number; z: number };

export interface AngleCue {
  x: number;
  y: number;
  deg: number;
  source: 'gravity' | 'image';
}

// approx. focal length of the iPhone main camera in units of (portrait) image width for 16:9 video
const F_WIDTH_UNITS = 1.45;

export function gravityCue(now: Vec3 | null, base: Vec3 | null): AngleCue | null {
  if (!now || !base) return null;
  // device rotation needed (axis) = base × now ; |axis| = sin(angle)
  const ax = base.y * now.z - base.z * now.y;
  const ay = base.z * now.x - base.x * now.z;
  const x = -ay, y = -ax;
  const ang = Math.asin(Math.min(1, Math.hypot(ax, ay)));
  return { x, y, deg: (ang * 180) / Math.PI, source: 'gravity' };
}

export function imageCue(g: Registration | null, flipYaw: boolean, flipPitch: boolean): AngleCue | null {
  if (!g) return null;
  const x = -g.px * F_WIDTH_UNITS * (flipYaw ? -1 : 1);
  const y = -g.py * F_WIDTH_UNITS * (flipPitch ? -1 : 1);
  return { x, y, deg: (Math.hypot(x, y) * 180) / Math.PI, source: 'image' };
}

export interface Coach {
  text: string;
  kind: 'angle' | 'distance' | 'move' | 'rotate' | 'steady' | 'ok' | 'search';
  /** unit screen direction for move / angle cues */
  dx?: number;
  dy?: number;
  /** size of the correction in image-width units (move) */
  amount?: number;
  /** distance: +1 = move closer, -1 = move back. rotate: +1 = clockwise */
  sign?: number;
}

export function coach(opts: {
  hasRef: boolean;
  reg: Registration | null;
  angle: AngleCue | null;
  angleTolDeg: number;
  motionRate: number;
  motionMax: number;
  sharpOk: boolean;
  aligned: boolean;
}): Coach | null {
  const { hasRef, reg, angle, angleTolDeg, motionRate, motionMax, sharpOk, aligned } = opts;
  const angCue = (a: AngleCue, suffix: string): Coach => {
    const horiz = Math.abs(a.x) > Math.abs(a.y);
    const text = horiz ? (a.x < 0 ? 'Aim left' : 'Aim right') : a.y < 0 ? 'Aim higher' : 'Aim lower';
    const n = Math.hypot(a.x, a.y) || 1;
    return { text: text + suffix, kind: 'angle', dx: a.x / n, dy: a.y / n };
  };
  if (!hasRef) {
    if (motionRate > motionMax) return { text: 'Hold steady', kind: 'steady' };
    return null;
  }
  // The tilt sensor is precise, so a clear angle error is corrected first (it distorts everything else).
  // The image-based angle is noisy, so it is only raised late and only when large.
  const sensor = angle?.source === 'gravity';
  if (angle && sensor && angle.deg > angleTolDeg * 2.5) return angCue(angle, ` ${angle.deg.toFixed(0)}°`);
  if (!reg) return { text: 'Line up the outline with the teeth', kind: 'search' };
  const tTol = 0.02, sTol = 0.02, rTol = (1.5 * Math.PI) / 180;
  const ls = Math.log(reg.scale);
  const dist = (soft: boolean): Coach => ({ text: ls > 0 ? (soft ? 'A little back' : 'Move back') : soft ? 'A little closer' : 'Move closer', kind: 'distance', sign: ls > 0 ? -1 : 1 });
  if (Math.abs(ls) > sTol * 2.5) return dist(false);
  const t = Math.hypot(reg.tx, reg.ty);
  if (t > tTol) {
    const text = Math.abs(reg.tx) > Math.abs(reg.ty) ? (reg.tx > 0 ? 'Move right' : 'Move left') : reg.ty > 0 ? 'Move down' : 'Move up';
    return { text, kind: 'move', dx: reg.tx / t, dy: reg.ty / t, amount: t };
  }
  if (Math.abs(ls) > sTol) return dist(true);
  if (Math.abs(reg.roll) > rTol) return { text: reg.roll > 0 ? 'Rotate clockwise' : 'Rotate anticlockwise', kind: 'rotate', sign: reg.roll > 0 ? 1 : -1 };
  if (angle && angle.deg > (sensor ? angleTolDeg : Math.max(5, angleTolDeg * 3))) return angCue(angle, ' slightly');
  if (motionRate > motionMax || !sharpOk) return { text: 'Hold still', kind: 'steady' };
  return aligned ? { text: 'Aligned. Take the photo', kind: 'ok' } : { text: 'Nearly there. Hold steady', kind: 'steady' };
}
