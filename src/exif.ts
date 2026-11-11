// Minimal EXIF reader for JPEG files: just the capture settings Dental Align can use or record.
// Nothing is written back; the photo file itself is never modified.

export interface PhotoSettings {
  model?: string;
  lens?: string;
  takenAt?: string; // ISO date
  focalLengthMm?: number;
  focalLength35?: number;
  digitalZoom?: number;
  exposureTime?: number; // seconds
  fNumber?: number;
  iso?: number;
  flashFired?: boolean;
  whiteBalanceManual?: boolean;
  orientation?: number;
  /** zoom relative to the phone's 1x main camera, worked out from the fields above */
  zoom?: number;
  /** how the zoom was worked out, for the log */
  zoomBasis?: string;
}

const TAGS: Record<number, keyof PhotoSettings | 'exifIfd'> = {
  0x0110: 'model',
  0x0112: 'orientation',
  0x8769: 'exifIfd',
  0x829a: 'exposureTime',
  0x829d: 'fNumber',
  0x8827: 'iso',
  0x9003: 'takenAt',
  0x9209: 'flashFired',
  0x920a: 'focalLengthMm',
  0xa403: 'whiteBalanceManual',
  0xa404: 'digitalZoom',
  0xa405: 'focalLength35',
  0xa434: 'lens',
};

export async function readPhotoSettings(file: Blob, mainCamera35 = 26): Promise<PhotoSettings | null> {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null; // not a JPEG
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off);
      const size = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
        const out = parseTiff(new DataView(buf, off + 10, Math.min(size - 8, v.byteLength - off - 10)));
        return out ? withZoom(out, mainCamera35) : null;
      }
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
      off += 2 + size;
    }
  } catch {
    /* unreadable metadata is not an error */
  }
  return null;
}

function parseTiff(t: DataView): PhotoSettings | null {
  const le = t.getUint16(0) === 0x4949;
  if (t.getUint16(2, le) !== 42) return null;
  const out: Record<string, unknown> = {};
  const readIfd = (start: number, depth: number) => {
    if (start <= 0 || start + 2 > t.byteLength) return;
    const n = t.getUint16(start, le);
    for (let i = 0; i < n; i++) {
      const e = start + 2 + i * 12;
      if (e + 12 > t.byteLength) return;
      const key = TAGS[t.getUint16(e, le)];
      if (!key) continue;
      const type = t.getUint16(e + 2, le), count = t.getUint32(e + 4, le);
      const bytes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8][type] ?? 1;
      const pos = bytes * count > 4 ? t.getUint32(e + 8, le) : e + 8;
      if (pos + bytes * count > t.byteLength) continue;
      let val: unknown;
      if (type === 2) {
        let s = '';
        for (let k = 0; k < count; k++) {
          const c = t.getUint8(pos + k);
          if (!c) break;
          s += String.fromCharCode(c);
        }
        val = s.trim();
      } else if (type === 3) val = t.getUint16(pos, le);
      else if (type === 4) val = t.getUint32(pos, le);
      else if (type === 5) val = t.getUint32(pos + 4, le) ? t.getUint32(pos, le) / t.getUint32(pos + 4, le) : undefined;
      else if (type === 10) val = t.getInt32(pos + 4, le) ? t.getInt32(pos, le) / t.getInt32(pos + 4, le) : undefined;
      else continue;
      if (key === 'exifIfd') {
        if (depth === 0) readIfd(val as number, 1);
      } else if (val !== undefined) out[key] = val;
    }
  };
  readIfd(t.getUint32(4, le), 0);
  const s = out as PhotoSettings & { flashFired?: unknown; whiteBalanceManual?: unknown; takenAt?: string };
  if (typeof out.flashFired === 'number') s.flashFired = (out.flashFired & 1) === 1;
  if (typeof out.whiteBalanceManual === 'number') s.whiteBalanceManual = out.whiteBalanceManual === 1;
  if (typeof s.takenAt === 'string') {
    const m = s.takenAt.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
    s.takenAt = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString() : undefined;
  }
  return Object.keys(s).length ? s : null;
}

function withZoom(s: PhotoSettings, main35: number): PhotoSettings {
  const fl = s.focalLength35, dz = s.digitalZoom;
  if (fl && fl > 0) {
    const byFocal = fl / main35;
    // some cameras leave the 35 mm figure at the lens value and report the crop separately
    if (dz && dz > 1.05 && Math.abs(byFocal - 1) < 0.1) {
      s.zoom = dz;
      s.zoomBasis = `digital zoom ratio ${dz.toFixed(2)}`;
    } else {
      s.zoom = byFocal;
      s.zoomBasis = `${fl} mm equivalent / ${main35} mm main camera`;
    }
  } else if (dz && dz >= 1) {
    s.zoom = dz;
    s.zoomBasis = `digital zoom ratio ${dz.toFixed(2)}`;
  }
  if (s.zoom) s.zoom = Math.round(s.zoom * 10) / 10;
  return s;
}

/** Short human summary, e.g. "4.5×, 1/60 s, f/1.5, ISO 125". */
export function describeSettings(s: PhotoSettings): string {
  const parts: string[] = [];
  if (s.zoom) parts.push(`${s.zoom}×`);
  if (s.exposureTime) parts.push(s.exposureTime >= 1 ? `${s.exposureTime} s` : `1/${Math.round(1 / s.exposureTime)} s`);
  if (s.fNumber) parts.push(`f/${s.fNumber.toFixed(1)}`);
  if (s.iso) parts.push(`ISO ${s.iso}`);
  if (s.flashFired != null) parts.push(s.flashFired ? 'flash on' : 'flash off');
  return parts.join(', ');
}
