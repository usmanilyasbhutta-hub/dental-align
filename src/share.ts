// Export helpers. In a PWA we cannot write into a named Photos album (PhotoKit is native-only),
// so images leave via the iOS share sheet ("Save Image" → Photos) or as downloads.

export async function shareOrDownload(files: File[], title: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  try {
    if (nav.share && nav.canShare && nav.canShare({ files })) {
      await nav.share({ files, title });
      return 'shared';
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return 'cancelled';
  }
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  return 'downloaded';
}

export function toCSV(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s; }, new Set<string>()));
  const esc = (v: unknown) => {
    if (v == null) return '';
    const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toPrecision(6)) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

export const stamp = (t: number) => new Date(t).toISOString().replace(/[:.]/g, '-').slice(0, 19);
