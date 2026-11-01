// Standard photographic views (spec §5) and the restrained generic composition guides
// used ONLY for the very first (baseline) photograph of a view (spec §6).

export interface ViewDef {
  key: string;
  label: string;
  short: string;
}

export const VIEWS: ViewDef[] = [
  { key: 'anterior', label: 'Anterior', short: 'ANT' },
  { key: 'right-buccal', label: 'Right Buccal', short: 'R BUC' },
  { key: 'left-buccal', label: 'Left Buccal', short: 'L BUC' },
  { key: 'right-posterior', label: 'Right Posterior', short: 'R POST' },
  { key: 'left-posterior', label: 'Left Posterior', short: 'L POST' },
  { key: 'upper-occlusal', label: 'Upper Occlusal', short: 'UPPER OCC' },
  { key: 'lower-occlusal', label: 'Lower Occlusal', short: 'LOWER OCC' },
];

export const viewDef = (key: string) => VIEWS.find((v) => v.key === key) ?? { key, label: key, short: key };

/** Draws the generic guide into a 2D context covering a w×h viewport. Lines are thin and translucent. */
export function drawGenericGuide(ctx: CanvasRenderingContext2D, key: string, w: number, h: number, phoneRoll: number | null) {
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.setLineDash([]);
  const cx = w / 2, cy = h / 2;
  const S = Math.min(w, h);

  // horizon / roll indicator (from gravity) — a short level line that stays world-horizontal
  const levelLen = S * 0.18;
  const rollRad = phoneRoll ?? 0;
  ctx.save();
  if (phoneRoll == null) ctx.globalAlpha = 0;
  ctx.translate(cx, cy);
  ctx.rotate(-rollRad);
  const levelOk = Math.abs(rollRad) < (1.5 * Math.PI) / 180;
  ctx.strokeStyle = levelOk ? 'rgba(120,230,160,0.8)' : 'rgba(255,255,255,0.6)';
  ctx.beginPath();
  ctx.moveTo(-levelLen, 0);
  ctx.lineTo(-levelLen * 0.35, 0);
  ctx.moveTo(levelLen * 0.35, 0);
  ctx.lineTo(levelLen, 0);
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  if (key === 'anterior') {
    // midline + occlusal plane + upper/lower arch arcs + approximate scale brackets
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(cx, cy - S * 0.32);
    ctx.lineTo(cx, cy + S * 0.32);
    ctx.moveTo(cx - S * 0.42, cy);
    ctx.lineTo(cx + S * 0.42, cy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.ellipse(cx, cy - S * 0.02, S * 0.4, S * 0.17, 0, Math.PI * 1.08, Math.PI * 1.92);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy + S * 0.02, S * 0.36, S * 0.15, 0, Math.PI * 0.08, Math.PI * 0.92);
    ctx.stroke();
  } else if (key.includes('buccal') || key.includes('posterior')) {
    const dir = key.startsWith('right') ? -1 : 1; // oblique orientation hint
    const spread = key.includes('posterior') ? 0.34 : 0.42;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(cx - S * spread, cy + dir * S * 0.03);
    ctx.lineTo(cx + S * spread, cy - dir * S * 0.03);
    ctx.stroke();
    ctx.setLineDash([]);
    // approximate dental region box
    const bw = S * spread * 2, bh = S * (key.includes('posterior') ? 0.36 : 0.32);
    roundRect(ctx, cx - bw / 2, cy - bh / 2, bw, bh, 18);
    ctx.stroke();
  } else if (key.includes('occlusal')) {
    const upper = key.startsWith('upper');
    ctx.beginPath();
    // U-shaped arch; open end towards the incisors' opposite side
    const ax = S * 0.3, ay = S * 0.38;
    const dir = upper ? 1 : -1;
    ctx.ellipse(cx, cy - dir * ay * 0.35, ax, ay, 0, upper ? 0 : Math.PI, upper ? Math.PI : Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.moveTo(cx, cy - S * 0.36);
    ctx.lineTo(cx, cy + S * 0.36);
    ctx.stroke();
  }
  // centre mark
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fill();
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
