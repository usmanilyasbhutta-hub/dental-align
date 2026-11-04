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
}

export function coach(opts: {
  hasRef: boolean;
  reg: Registration | null;
  angle: AngleCue | null;
  angleTolDeg: number;
  motionRate: number;
  motionMax: number;
  sharpOk: boolean;
}): Coach | null {
  const { hasRef, reg, angle, angleTolDeg, motionRate, motionMax, sharpOk } = opts;
  const angDir = (a: AngleCue) =>
    Math.abs(a.x) > Math.abs(a.y) ? (a.x < 0 ? 'Aim left' : 'Aim right') : a.y < 0 ? 'Aim higher' : 'Aim lower';
  if (!hasRef) {
    if (motionRate > motionMax) return { text: 'Hold steady', kind: 'steady' };
    return null;
  }
  // angle first when clearly off: it also corrupts the other estimates
  if (angle && angle.deg > angleTolDeg * 2.5) return { text: `${angDir(angle)} · ${angle.deg.toFixed(0)}°`, kind: 'angle' };
  if (!reg) return { text: 'Find the reference — match the ghost', kind: 'search' };
  const tTol = 0.015, sTol = 0.015, rTol = (1 * Math.PI) / 180;
  const ls = Math.log(reg.scale);
  if (Math.abs(ls) > sTol * 2) return { text: ls > 0 ? 'Move back' : 'Move closer', kind: 'distance' };
  if (Math.hypot(reg.tx, reg.ty) > tTol) {
    const t = Math.abs(reg.tx) > Math.abs(reg.ty) ? (reg.tx > 0 ? 'Move right' : 'Move left') : reg.ty > 0 ? 'Move down' : 'Move up';
    return { text: t, kind: 'move' };
  }
  if (Math.abs(ls) > sTol) return { text: ls > 0 ? 'A little back' : 'A little closer', kind: 'distance' };
  if (Math.abs(reg.roll) > rTol) return { text: reg.roll > 0 ? 'Rotate ↻' : 'Rotate ↺', kind: 'rotate' };
  if (angle && angle.deg > angleTolDeg) return { text: `${angDir(angle)} slightly`, kind: 'angle' };
  if (motionRate > motionMax || !sharpOk) return { text: 'Hold still', kind: 'steady' };
  return { text: 'Aligned. Take the photo', kind: 'ok' };
}
