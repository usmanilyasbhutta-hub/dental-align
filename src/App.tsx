import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Capture from './Capture';
import { db, type Capture as CaptureRec, type LogRecord, type ViewRecord } from './db';
import { VIEWS, viewDef } from './views';
import { DEFAULTS, loadSettings, saveSettings, type Settings } from './settings';
import { motion } from './motion';
import { sound } from './sound';
import { importPhoto } from './importPhoto';
import { describeSettings, type PhotoSettings } from './exif';
import { shareOrDownload, stamp, toCSV } from './share';
import {
  IconCamera, IconCheck, IconChevronLeft, IconChevronRight, IconClose, IconEllipsis, IconGear, IconInfo,
  IconPhoto, IconPin, IconPlus, IconSearch, IconShare, IconTrash,
} from './icons';

type Route =
  | { name: 'home' }
  | { name: 'patient'; id: string }
  | { name: 'capture'; id: string; view: string }
  | { name: 'history'; id: string; view: string }
  | { name: 'settings' };

const BASE = import.meta.env.BASE_URL;

// keep the bottom search dock above the iOS keyboard
if (typeof window !== 'undefined' && window.visualViewport) {
  const vv = window.visualViewport;
  const upd = () => document.documentElement.style.setProperty('--kb', `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`);
  vv.addEventListener('resize', upd);
  vv.addEventListener('scroll', upd);
}

export default function App() {
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const setSettings = (s: Settings) => {
    setSettingsState(s);
    saveSettings(s);
  };

  switch (route.name) {
    case 'home':
      return <Home onOpen={(id) => setRoute({ name: 'patient', id })} onSettings={() => setRoute({ name: 'settings' })} />;
    case 'patient':
      return (
        <PatientScreen
          id={route.id}
          onBack={() => setRoute({ name: 'home' })}
          onCapture={(view) => setRoute({ name: 'capture', id: route.id, view })}
          onHistory={(view) => setRoute({ name: 'history', id: route.id, view })}
        />
      );
    case 'capture':
      return (
        <Capture
          key={`${route.id}|${route.view}`}
          patientId={route.id}
          viewKey={route.view}
          settings={settings}
          onSettings={setSettings}
          onClose={() => setRoute({ name: 'patient', id: route.id })}
          onHistory={() => setRoute({ name: 'history', id: route.id, view: route.view })}
        />
      );
    case 'history':
      return (
        <History
          patientId={route.id}
          viewKey={route.view}
          onBack={() => setRoute({ name: 'patient', id: route.id })}
          onCapture={() => setRoute({ name: 'capture', id: route.id, view: route.view })}
        />
      );
    case 'settings':
      return <SettingsScreen settings={settings} onChange={setSettings} onBack={() => setRoute({ name: 'home' })} />;
  }
}

// ---------------------------------------------------------------- shared chrome
function NavBar({ back, onBack, title, right }: { back?: string; onBack?: () => void; title?: string; right?: ReactNode }) {
  return (
    <nav className="navbar">
      <div className="nav-left">
        {onBack && (
          <button className="glass glass-circle interactive" onClick={onBack} aria-label={`Back to ${back}`}>
            <IconChevronLeft />
          </button>
        )}
      </div>
      <div className="nav-title">{title}</div>
      <div className="nav-right">{right}</div>
    </nav>
  );
}

/** Segmented control with a sliding glass lens behind the selected item. */
function Segmented<T extends string>({ items, value, onChange, small }: { items: { value: T; label: string }[]; value: T; onChange: (v: T) => void; small?: boolean }) {
  const i = Math.max(0, items.findIndex((x) => x.value === value));
  return (
    <div className={`segmented ${small ? 'small' : ''}`} role="tablist" style={{ ['--n' as string]: items.length, ['--i' as string]: i }}>
      <span className="seg-lens" aria-hidden />
      {items.map((it) => (
        <button key={it.value} role="tab" aria-selected={it.value === value} className={it.value === value ? 'on' : ''} onClick={() => onChange(it.value)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

function relDay(t: number) {
  const d = new Date(t), now = new Date();
  const day = 86400000;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= start) return 'Today';
  if (t >= start - day) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function initials(id: string) {
  const letters = id.replace(/[^A-Za-z]/g, '');
  return (letters.slice(0, 2) || id.slice(0, 2)).toUpperCase();
}

// ---------------------------------------------------------------- Home
interface PatientRow { id: string; updatedAt: number; views: number }

function Home({ onOpen, onSettings }: { onOpen: (id: string) => void; onSettings: () => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<PatientRow[] | null>(null);
  const [hintHidden, setHintHidden] = useState(() => {
    try { return localStorage.getItem('da-hint-hidden') === '1'; } catch { return false; }
  });
  useEffect(() => {
    (async () => {
      const ps = await db.listPatients();
      const out: PatientRow[] = [];
      for (const p of ps) out.push({ id: p.id, updatedAt: p.updatedAt, views: (await db.listViews(p.id)).length });
      setRows(out);
    })();
  }, []);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone;
  const clean = q.trim().toUpperCase();
  const filtered = useMemo(() => (rows ?? []).filter((r) => !clean || r.id.includes(clean)), [rows, clean]);
  const exact = rows?.some((r) => r.id === clean);
  const open = async (pid: string) => {
    const id = pid.trim().toUpperCase();
    if (!id) return;
    await db.touchPatient(id);
    onOpen(id);
  };

  return (
    <div className="screen with-dock">
      <NavBar right={<button className="glass glass-circle interactive" onClick={onSettings} aria-label="Settings"><IconGear /></button>} />
      <header className="brandhead">
        <img src={`${BASE}brand/logo.jpg`} alt="Dental House" className="brandlogo" />
      </header>
      <h1 className="largetitle">Patients</h1>
      <div className="dock" style={{ bottom: 'calc(var(--kb, 0px) + env(safe-area-inset-bottom) + 14px)' }}>
      <form
        className="searchfield glass"
        onSubmit={(e) => {
          e.preventDefault();
          void open(q);
        }}
      >
        <IconSearch />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find or add a patient ID"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          aria-label="Patient ID"
        />
        {q && (
          <button type="button" className="clearbtn" onClick={() => setQ('')} aria-label="Clear">
            <IconClose />
          </button>
        )}
      </form>
      <button
        className="glass glass-circle large tinted interactive"
        aria-label={clean ? `Add patient ${clean}` : 'Add patient'}
        onClick={() => {
          if (clean) void open(clean);
          else (document.querySelector('.searchfield input') as HTMLInputElement | null)?.focus();
        }}
      >
        <IconPlus />
      </button>
      </div>

      {clean && !exact && (
        <div className="group">
          <button className="cell cell-action" onClick={() => void open(clean)}>
            <span className="cell-icon accent"><IconPlus /></span>
            <span className="cell-main">
              <span className="cell-title">Add patient {clean}</span>
            </span>
          </button>
        </div>
      )}

      {rows && rows.length === 0 && !clean && (
        <div className="empty">
          <img src={`${BASE}brand/mark.jpg`} alt="" />
          <p>Type a patient ID in the search bar to start their first photo series.</p>
        </div>
      )}

      {filtered.length > 0 && (
        <>
          <div className="group-header">{clean ? 'Matches' : 'Recent'}</div>
          <div className="group">
            {filtered.map((p) => (
              <button key={p.id} className="cell" onClick={() => void open(p.id)}>
                <span className="avatar">{initials(p.id)}</span>
                <span className="cell-main">
                  <span className="cell-title">{p.id}</span>
                  <span className="cell-sub">
                    {p.views === 0 ? 'No views yet' : p.views === 1 ? '1 view' : `${p.views} views`}, {relDay(p.updatedAt).toLowerCase()}
                  </span>
                </span>
                <IconChevronRight className="chev" />
              </button>
            ))}
          </div>
        </>
      )}

      {!standalone && !hintHidden && (
        <div className="tipcard">
          <div>
            <strong>Add to Home Screen</strong>
            <p>In Safari, tap Share, then Add to Home Screen. Dental Align then opens full screen like an app.</p>
          </div>
          <button
            className="tipclose"
            aria-label="Dismiss"
            onClick={() => {
              setHintHidden(true);
              try { localStorage.setItem('da-hint-hidden', '1'); } catch { /* */ }
            }}
          >
            <IconClose />
          </button>
        </div>
      )}
      <p className="footnote">Photos stay on this iPhone.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Patient
interface Tile extends ViewRecord { thumb?: string; count: number }

function PatientScreen({ id, onBack, onCapture, onHistory }: { id: string; onBack: () => void; onCapture: (v: string) => void; onHistory: (v: string) => void }) {
  const [tiles, setTiles] = useState<Tile[] | null>(null);
  const [picker, setPicker] = useState(false);
  useEffect(() => {
    const urls: string[] = [];
    (async () => {
      const vs = await db.listViews(id);
      const out: Tile[] = [];
      for (const v of vs) {
        let thumb: string | undefined;
        const caps = await db.listCaptures(id, v.viewKey);
        const b = caps.find((c) => c.id === v.baselineId);
        if (b) {
          thumb = URL.createObjectURL(b.thumb);
          urls.push(thumb);
        }
        out.push({ ...v, thumb, count: caps.length });
      }
      out.sort((a, b) => VIEWS.findIndex((x) => x.key === a.viewKey) - VIEWS.findIndex((x) => x.key === b.viewKey));
      setTiles(out);
    })();
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [id]);

  // iOS only grants motion access inside a tap
  const go = (view: string) => {
    if (motion.permission === 'unknown') void motion.requestPermission();
    sound.unlock();
    onCapture(view);
  };
  const used = new Set((tiles ?? []).map((v) => v.viewKey));
  const caption = (t: Tile) => {
    if (!t.baselineId) return 'No baseline yet';
    const f = t.count - 1;
    return f <= 0 ? 'Baseline' : f === 1 ? 'Baseline + 1 follow-up' : `Baseline + ${f} follow-ups`;
  };

  return (
    <div className="screen">
      <NavBar back="Patients" onBack={onBack} />
      <h1 className="largetitle">{id}</h1>
      <div className="tilegrid">
        {(tiles ?? []).map((t) => (
          <div key={t.key} className="tile">
            <button className="tile-img" onClick={() => go(t.viewKey)} aria-label={`Photograph ${viewDef(t.viewKey).label}`}>
              {t.thumb ? <img src={t.thumb} alt="" /> : <span className="tile-empty"><IconCamera /></span>}
            </button>
            <div className="tile-meta">
              <button className="tile-text" onClick={() => go(t.viewKey)}>
                <span className="tile-title">{viewDef(t.viewKey).label}</span>
                <span className="tile-sub">{caption(t)}</span>
              </button>
              <button className="tile-more" onClick={() => onHistory(t.viewKey)} aria-label="Photo history">
                <IconEllipsis />
              </button>
            </div>
          </div>
        ))}
        <div className="tile">
          <button className="tile-img tile-add" onClick={() => setPicker(true)} aria-label="Add a view">
            <IconPlus />
          </button>
          <div className="tile-meta">
            <button className="tile-text" onClick={() => setPicker(true)}>
              <span className="tile-title">Add view</span>
              <span className="tile-sub">{used.size === 0 ? 'Choose the first view' : `${VIEWS.length - used.size} more available`}</span>
            </button>
          </div>
        </div>
      </div>

      {picker && (
        <Sheet title="Add a view" onClose={() => setPicker(false)}>
          <div className="group flush">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                className="cell"
                disabled={used.has(v.key)}
                onClick={async () => {
                  if (motion.permission === 'unknown') void motion.requestPermission();
                  sound.unlock();
                  await db.putView({ key: `${id}|${v.key}`, patientId: id, viewKey: v.key, baselineId: null, createdAt: Date.now() });
                  setPicker(false);
                  onCapture(v.key);
                }}
              >
                <span className="cell-main">
                  <span className="cell-title">{v.label}</span>
                </span>
                {used.has(v.key) ? <IconCheck className="chev accent" /> : <IconChevronRight className="chev" />}
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet glass" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="grabber" />
        <div className="sheet-head">
          <span>{title}</span>
          <button className="glass glass-circle small interactive" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- History / compare
type CompareMode = 'photo' | 'blend' | 'baseline';

function History({ patientId, viewKey, onBack, onCapture }: { patientId: string; viewKey: string; onBack: () => void; onCapture: () => void }) {
  const [caps, setCaps] = useState<CaptureRec[]>([]);
  const [view, setView] = useState<ViewRecord | undefined>();
  const [sel, setSel] = useState<CaptureRec | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<CompareMode>('photo');
  const [mix, setMix] = useState(0.5);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [info, setInfo] = useState(false);

  const reload = async () => {
    const c = await db.listCaptures(patientId, viewKey);
    const v = await db.getView(patientId, viewKey);
    setCaps(c);
    setView(v);
    const u: Record<string, string> = {};
    c.forEach((x) => (u[x.id] = URL.createObjectURL(x.thumb)));
    setUrls(u);
  };
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, viewKey]);
  const base = caps.find((c) => c.id === view?.baselineId) ?? null;
  const [full, setFull] = useState<{ sel?: string; base?: string }>({});
  useEffect(() => {
    if (!sel) return;
    const s = URL.createObjectURL(sel.master);
    const b = base && base.id !== sel.id ? URL.createObjectURL(base.master) : undefined;
    setFull({ sel: s, base: b });
    setMode('photo');
    return () => {
      URL.revokeObjectURL(s);
      if (b) URL.revokeObjectURL(b);
    };
  }, [sel, base]);

  const fileName = (c: CaptureRec) => `${patientId}_${viewKey}_${stamp(c.createdAt)}${c.id === view?.baselineId ? '_baseline' : ''}.jpg`;
  const ordered = [...caps].reverse();
  const isBase = (c: CaptureRec) => c.id === view?.baselineId;

  if (sel) {
    const canCompare = !!full.base;
    const reg = (sel.meta as { registration?: { E?: number; inliers?: number } } | undefined)?.registration;
    return (
      <div className="screen viewer-screen">
        <NavBar back="Photos" onBack={() => { setSel(null); setInfo(false); setConfirmDelete(false); }} title={new Date(sel.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} />
        <div className="viewer-stage">
          {full.sel && <img src={full.sel} alt="" style={{ opacity: mode === 'baseline' ? 0 : 1 }} />}
          {full.base && <img src={full.base} alt="" className="over" style={{ opacity: mode === 'baseline' ? 1 : mode === 'blend' ? mix : 0 }} />}
          {isBase(sel) && <span className="badge-on-image">Baseline</span>}
        </div>
        {canCompare && (
          <div className="compare">
            <Segmented
              items={[{ value: 'photo', label: 'This photo' }, { value: 'blend', label: 'Blend' }, { value: 'baseline', label: 'Baseline' }]}
              value={mode}
              onChange={(m) => setMode(m as CompareMode)}
            />
            {mode === 'blend' && <input className="slider" type="range" min={0} max={1} step={0.01} value={mix} onChange={(e) => setMix(+e.target.value)} aria-label="Blend amount" />}
            <p className="footnote">Shown exactly as captured. Any misalignment you see is real.</p>
          </div>
        )}
        {info && (
          <div className="group infogroup">
            <div className="cell static"><span className="cell-main"><span className="cell-title">Captured</span></span><span className="cell-value">{new Date(sel.createdAt).toLocaleString()}</span></div>
            <div className="cell static"><span className="cell-main"><span className="cell-title">Size</span></span><span className="cell-value">{sel.width} × {sel.height}</span></div>
            {(() => {
              const m = sel.meta as { exif?: PhotoSettings | null; zoom?: number; imported?: boolean };
              const text = m.exif ? describeSettings(m.exif) : m.zoom ? `${m.zoom}×` : '';
              return (
                <>
                  {text && <div className="cell static"><span className="cell-main"><span className="cell-title">Camera settings</span></span><span className="cell-value">{text}</span></div>}
                  {m.exif?.model && <div className="cell static"><span className="cell-main"><span className="cell-title">Camera</span></span><span className="cell-value">{m.exif.model}</span></div>}
                  {m.imported && <div className="cell static"><span className="cell-main"><span className="cell-title">Source</span></span><span className="cell-value">Imported photo</span></div>}
                </>
              );
            })()}
            {reg?.E != null && <div className="cell static"><span className="cell-main"><span className="cell-title">Alignment error</span></span><span className="cell-value">{(reg.E * 100).toFixed(1)}% of width</span></div>}
            <button
              className="cell"
              onClick={() => {
                const meta = new Blob([JSON.stringify({ id: sel.id, patientId, viewKey, role: sel.role, createdAt: sel.createdAt, ...sel.meta }, null, 2)], { type: 'application/json' });
                void shareOrDownload([new File([meta], fileName(sel).replace('.jpg', '.json'), { type: 'application/json' })], 'metadata');
              }}
            >
              <span className="cell-main"><span className="cell-title accent-text">Export capture data</span></span>
            </button>
          </div>
        )}
        <div className="toolbar-dock">
        <div className="toolbar glass">
          <button onClick={() => void shareOrDownload([new File([sel.master], fileName(sel), { type: 'image/jpeg' })], fileName(sel))} aria-label="Save or share">
            <IconShare />
          </button>
          <button
            onClick={async () => {
              if (!view || isBase(sel)) return;
              await db.putView({ ...view, baselineId: sel.id });
              await reload();
            }}
            className={isBase(sel) ? 'on' : ''}
            aria-label={isBase(sel) ? 'This is the baseline' : 'Make baseline'}
          >
            <IconPin />
            <span>{isBase(sel) ? 'Baseline' : 'Make baseline'}</span>
          </button>
          <button onClick={() => setInfo(!info)} className={info ? 'on' : ''} aria-label="Details">
            <IconInfo />
          </button>
          <button
            className={confirmDelete ? 'danger' : ''}
            onClick={async () => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                setTimeout(() => setConfirmDelete(false), 3000);
                return;
              }
              await db.deleteCapture(sel.id);
              if (view && view.baselineId === sel.id) {
                const rest = caps.filter((c) => c.id !== sel.id);
                await db.putView({ ...view, baselineId: rest[0]?.id ?? null });
              }
              setSel(null);
              setConfirmDelete(false);
              await reload();
            }}
            aria-label="Delete photo"
          >
            <IconTrash />
            {confirmDelete && <span>Delete photo</span>}
          </button>
        </div>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <NavBar
        back={patientId}
        onBack={onBack}
        right={
          <>
            <label className="glass glass-circle interactive" aria-label="Add a photo from your library">
              <IconPhoto />
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  await importPhoto(f, patientId, viewKey, loadSettings().mainCamera35);
                  await reload();
                }}
              />
            </label>
            <button className="glass glass-circle interactive" onClick={onCapture} aria-label="Open camera"><IconCamera /></button>
          </>
        }
      />
      <h1 className="largetitle">{viewDef(viewKey).label}</h1>
      {caps.length === 0 ? (
        <div className="empty">
          <p>No photos of this view yet. Take the baseline here, or add one from your photo library with the picture button above.</p>
          <button className="btn-filled" onClick={onCapture}>Take baseline</button>
        </div>
      ) : (
        <>
          <p className="subtitle">{caps.length === 1 ? '1 photo' : `${caps.length} photos`}, newest first</p>
          <div className="photogrid">
            {ordered.map((c) => (
              <button key={c.id} className="photo" onClick={() => setSel(c)}>
                <img src={urls[c.id]} alt="" />
                {isBase(c) && <span className="photo-badge">Baseline</span>}
                <span className="photo-date">{relDay(c.createdAt)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Settings & diagnostics
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="cell static">
      <span className="cell-main"><span className="cell-title">{label}</span></span>
      <input type="checkbox" className="ios-switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function SettingsScreen({ settings, onChange, onBack }: { settings: Settings; onChange: (s: Settings) => void; onBack: () => void }) {
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    void db.listLogs().then(setLogs);
  }, []);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...settings, [k]: v });
  const num = (k: keyof Settings, label: string, step = 1) => (
    <label className="cell static" key={k}>
      <span className="cell-main"><span className="cell-title">{label}</span></span>
      <input className="numfield" type="number" inputMode="decimal" step={step} value={settings[k] as number} onChange={(e) => set(k, Number(e.target.value) as never)} />
    </label>
  );

  return (
    <div className="screen">
      <NavBar back="Patients" onBack={onBack} />
      <h1 className="largetitle">Settings</h1>

      <div className="group-header">Guidance</div>
      <div className="group">
        <Toggle label="Coaching text" checked={settings.coach} onChange={(v) => set('coach', v)} />
        <Toggle label="Sound guidance" checked={settings.sound} onChange={(v) => set('sound', v)} />
        <Toggle label="Haptics (where iOS allows)" checked={settings.haptics} onChange={(v) => set('haptics', v)} />
        <Toggle label="Auto-capture when aligned" checked={settings.autoCapture} onChange={(v) => set('autoCapture', v)} />
        <label className="cell static">
          <span className="cell-main"><span className="cell-title">Angle guide</span></span>
          <select className="menu" value={settings.angleSource} onChange={(e) => set('angleSource', e.target.value as Settings['angleSource'])}>
            <option value="auto">Automatic</option>
            <option value="gravity">Tilt sensor</option>
            <option value="image">Image</option>
          </select>
        </label>
      </div>
      <p className="group-footer">Automatic uses the tilt sensor when the baseline recorded it, otherwise the image.</p>

      <div className="group-header">Camera</div>
      <div className="group">
        <div className="cell static">
          <span className="cell-main"><span className="cell-title">Resolution</span></span>
          <Segmented small items={[{ value: '1080', label: '1080p' }, { value: '4k', label: '4K' }]} value={settings.resolution} onChange={(r) => set('resolution', r as Settings['resolution'])} />
        </div>
      </div>
      <p className="group-footer">1080p keeps guidance fastest. 4K gives larger photos if your iPhone allows it.</p>

      <div className="group-header">Diagnostics</div>
      <div className="group">
        <Toggle label="Show measurements" checked={settings.developer} onChange={(v) => set('developer', v)} />
        <button className="cell" onClick={() => setAdvanced(!advanced)}>
          <span className="cell-main"><span className="cell-title">Advanced tuning</span></span>
          <IconChevronRight className={`chev ${advanced ? 'rot' : ''}`} />
        </button>
        {advanced && (
          <>
            {num('mainCamera35', '1× camera, 35 mm equivalent')}
            {num('angleTolDeg', 'Angle tolerance (°)', 0.25)}
            {num('procLong', 'Processing size (px)', 16)}
            {num('refTarget', 'Reference points')}
            {num('toothShare', 'Share on teeth (0–1)', 0.05)}
            {num('liveDetect', 'Live features')}
            {num('ratio', 'Ratio test', 0.01)}
            {num('ransacPx', 'RANSAC threshold (px)', 0.5)}
            {num('minInliers', 'Minimum inliers')}
            {num('trackRadius', 'Tracking radius (px)')}
            {num('smoothing', 'Smoothing', 0.05)}
            {num('strongE', 'Aligned threshold', 0.005)}
            {num('sharpMin', 'Sharpness floor')}
            {num('motionMax', 'Steadiness limit (°/s)')}
            <Toggle label="Contrast normalisation" checked={settings.clahe} onChange={(v) => set('clahe', v)} />
            <Toggle label="Temporal tracking" checked={settings.tracking} onChange={(v) => set('tracking', v)} />
            <Toggle label="Flip left–right angle" checked={settings.flipYaw} onChange={(v) => set('flipYaw', v)} />
            <Toggle label="Flip up–down angle" checked={settings.flipPitch} onChange={(v) => set('flipPitch', v)} />
            <button className="cell" onClick={() => onChange({ ...DEFAULTS, developer: settings.developer })}>
              <span className="cell-main"><span className="cell-title accent-text">Restore defaults</span></span>
            </button>
          </>
        )}
      </div>
      <p className="group-footer">You can also long-press the view name on the camera screen to show measurements.</p>

      <div className="group-header">Session logs</div>
      {logs.length === 0 ? (
        <p className="group-footer">Each camera session is recorded here so alignment problems can be diagnosed later.</p>
      ) : (
        <>
          <div className="group">
            {logs.map((l) => (
              <LogCell key={l.id} l={l} onDeleted={async () => setLogs(await db.listLogs())} />
            ))}
          </div>
          <p className="group-footer">The last 40 sessions are kept on this iPhone. Export sends the frame-by-frame CSV and an events file.</p>
        </>
      )}
      <p className="footnote">Dental Align, build {__BUILD__}</p>
    </div>
  );
}

function LogCell({ l, onDeleted }: { l: LogRecord; onDeleted: () => void }) {
  const [armed, setArmed] = useState(false);
  const base = `dentalalign_log_${l.patientId}_${l.viewKey}_${stamp(l.startedAt)}`;
  return (
    <div className="cell static">
      <span className="cell-main">
        <span className="cell-title">{l.patientId}, {viewDef(l.viewKey).label}</span>
        <span className="cell-sub">
          {new Date(l.startedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}, {Math.round((l.endedAt - l.startedAt) / 1000)} s
        </span>
      </span>
      <button
        className="pill"
        onClick={() =>
          void shareOrDownload(
            [
              new File([toCSV(l.rows)], base + '_frames.csv', { type: 'text/csv' }),
              new File([JSON.stringify({ info: l.info, events: l.events }, null, 2)], base + '_events.json', { type: 'application/json' }),
            ],
            base,
          )
        }
      >
        Export
      </button>
      <button
        className={`pill ${armed ? 'danger' : 'quiet'}`}
        onClick={async () => {
          if (!armed) {
            setArmed(true);
            setTimeout(() => setArmed(false), 2500);
            return;
          }
          await db.deleteLog(l.id);
          onDeleted();
        }}
        aria-label="Delete log"
      >
        {armed ? 'Delete' : <IconTrash />}
      </button>
    </div>
  );
}

declare const __BUILD__: string;
