// Tunable parameters. Defaults are starting points to be determined empirically (spec §9, §34).
export interface Settings {
  procLong: number; // long side of the processing image (px)
  refDetect: number; // ORB features detected on the reference before selection
  refTarget: number; // spatially distributed reference keypoints kept (spec: ~50–100)
  refGrid: number; // grid size for coverage-based selection
  liveDetect: number; // ORB features detected per live frame
  ratio: number; // Lowe ratio test
  maxHamming: number;
  ransacPx: number; // RANSAC reprojection threshold (processing px)
  minCandidates: number;
  minInliers: number;
  clahe: boolean; // local contrast normalisation before detection
  tracking: boolean; // guided (temporal) matching using the previous frame's estimate
  trackRadius: number; // search radius around the predicted position (processing px)
  trackMaxHamming: number;
  trackRatio: number;
  smoothing: number; // EMA factor 0..1 (higher = more responsive)
  strongE: number; // total error below which = strong convergence (fraction of image width)
  convergingE: number;
  sharpMin: number; // absolute sharpness floor (Laplacian variance of centre crop)
  motionMax: number; // max rotation rate (deg/s) for "peak opportunity"
  flipYaw: boolean; // sign calibration for the perspective cue
  flipPitch: boolean;
  resolution: '1080' | '4k';
  autoCapture: boolean;
  haptics: boolean;
  developer: boolean;
  ghostOpacity: number;
}

export const DEFAULTS: Settings = {
  procLong: 640,
  refDetect: 2500,
  refTarget: 120,
  refGrid: 8,
  liveDetect: 1200,
  ratio: 0.8,
  maxHamming: 80,
  ransacPx: 4,
  minCandidates: 12,
  minInliers: 10,
  clahe: true,
  tracking: true,
  trackRadius: 20,
  trackMaxHamming: 64,
  trackRatio: 0.9,
  smoothing: 0.45,
  strongE: 0.025,
  convergingE: 0.12,
  sharpMin: 60,
  motionMax: 25,
  flipYaw: false,
  flipPitch: false,
  resolution: '1080',
  autoCapture: false,
  haptics: true,
  developer: false,
  ghostOpacity: 0.35,
};

const KEY = 'dental-align-settings-v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
