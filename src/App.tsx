import { useEffect, useState } from 'react';
import Capture from './Capture';
import { db, type Capture as CaptureRec, type LogRecord, type Patient, type ViewRecord } from './db';
import { VIEWS, viewDef } from './views';
import { DEFAULTS, loadSettings, saveSettings, type Settings } from './settings';
import { motion } from './motion';
import { shareOrDownload, stamp, toCSV } from './share';

type Route =
  | { name: 'home' }
  | { name: 'patient'; id: string }
  | { name: 'capture'; id: string; view: string }
  | { name: 'history'; id: string; view: string }
  | { name: 'settings' };

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

// ---------------------------------------------------------------- Home
function Home({ onOpen, onSettings }: { onOpen: (id: string) => void; onSettings: () => void }) {
  const [id, setId] = useState('');
  const [patients, setPatients] = useState<Patient[]>([]);
  useEffect(() => {
    void db.listPatients().then(setPatients);
  }, []);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone;
  const open = async (pid: string) => {
    const clean = pid.trim().toUpperCase();
    if (!clean) return;
    await db.touchPatient(clean);
    onOpen(clean);
  };
  return (
    <div className="page">
      <header className="hdr">
        <h1>Dental Align</h1>
        <button className="link" onClick={onSettings}>
          Settings
        </button>
      </header>
      <form
        className="pidform"
        onSubmit={(e) => {
          e.preventDefault();
          void open(id);
        }}
      >
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="Patient ID, e.g. DH-0147" autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
        <button type="submit" disabled={!id.trim()}>
          Open
        </button>
      </form>
      {patients.length > 0 && <div className="sectionlabel">Recent</div>}
      <ul className="plist">
        {patients.map((p) => (
          <li key={p.id} onClick={() => void open(p.id)}>
            <span>{p.id}</span>
            <small>{new Date(p.updatedAt).toLocaleDateString()}</small>
          </li>
        ))}
      </ul>
      {!standalone && <p className="hint">For best results on iPhone: Share → Add to Home Screen, then open Dental Align from the home screen.</p>}
      <p className="hint small">Experimental prototype · Goal 1 · images stay on this device</p>
    </div>
  );
}

// ---------------------------------------------------------------- Patient
function PatientScreen({ id, onBack, onCapture, onHistory }: { id: string; onBack: () => void; onCapture: (v: string) => void; onHistory: (v: string) => void }) {
  const [views, setViews] = useState<(ViewRecord & { thumb?: string })[]>([]);
  const [picker, setPicker] = useState(false);
  useEffect(() => {
    let urls: string[] = [];
    (async () => {
      const vs = await db.listViews(id);
      const out = [];
      for (const v of vs) {
        let thumb: string | undefined;
        if (v.baselineId) {
          const c = await db.getCapture(v.baselineId);
          if (c) {
            thumb = URL.createObjectURL(c.thumb);
            urls.push(thumb);
          }
        }
        out.push({ ...v, thumb });
      }
      out.sort((a, b) => VIEWS.findIndex((x) => x.key === a.viewKey) - VIEWS.findIndex((x) => x.key === b.viewKey));
      setViews(out);
    })();
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls = [];
    };
  }, [id]);

  // motion permission must be requested inside a user gesture on iOS
  const go = (view: string) => {
    if (motion.permission === 'unknown') void motion.requestPermission();
    onCapture(view);
  };
  const used = new Set(views.map((v) => v.viewKey));
  return (
    <div className="page">
      <header className="hdr">
        <button className="link" onClick={onBack}>
          ‹ Patients
        </button>
        <h2>{id}</h2>
        <span />
      </header>
      <div className="tiles">
        {views.map((v) => (
          <div key={v.key} className="tile" onClick={() => go(v.viewKey)}>
            {v.thumb ? <img src={v.thumb} alt="" /> : <div className="noimg">no baseline</div>}
            <div className="tlabel">{viewDef(v.viewKey).label}</div>
            <button
              className="tinfo"
              onClick={(e) => {
                e.stopPropagation();
                onHistory(v.viewKey);
              }}
              aria-label="History"
            >
              ⋯
            </button>
          </div>
        ))}
        <div className="tile add" onClick={() => setPicker(true)}>
          <span>+</span>
          <div className="tlabel">New View</div>
        </div>
      </div>
      {picker && (
        <div className="sheet" onClick={() => setPicker(false)}>
          <div className="sheetbody" onClick={(e) => e.stopPropagation()}>
            <div className="sectionlabel">Standard views</div>
            {VIEWS.map((v) => (
              <button
                key={v.key}
                className="sheetitem"
                disabled={used.has(v.key)}
                onClick={async () => {
                  // request motion permission synchronously, inside the tap (iOS requirement)
                  if (motion.permission === 'unknown') void motion.requestPermission();
                  await db.putView({ key: `${id}|${v.key}`, patientId: id, viewKey: v.key, baselineId: null, createdAt: Date.now() });
                  setPicker(false);
                  onCapture(v.key);
                }}
              >
                {v.label}
                {used.has(v.key) && <small> · exists</small>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- History / compare
function History({ patientId, viewKey, onBack, onCapture }: { patientId: string; viewKey: string; onBack: () => void; onCapture: () => void }) {
  const [caps, setCaps] = useState<CaptureRec[]>([]);
  const [view, setView] = useState<ViewRecord | undefined>();
  const [sel, setSel] = useState<CaptureRec | null>(null);
  const [mix, setMix] = useState(0);
  const [urls, setUrls] = useState<Record<string, string>>({});
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
    const b = base ? URL.createObjectURL(base.master) : undefined;
    setFull({ sel: s, base: b });
    setMix(0);
    return () => {
      URL.revokeObjectURL(s);
      if (b) URL.revokeObjectURL(b);
    };
  }, [sel, base]);

  const name = (c: CaptureRec) => `${patientId}_${viewKey}_${stamp(c.createdAt)}${c.id === view?.baselineId ? '_baseline' : ''}.jpg`;

  return (
    <div className="page">
      <header className="hdr">
        <button className="link" onClick={sel ? () => setSel(null) : onBack}>
          ‹ {sel ? 'History' : patientId}
        </button>
        <h2>{viewDef(viewKey).label}</h2>
        <button className="link" onClick={onCapture}>
          Camera
        </button>
      </header>
      {!sel && (
        <div className="hist">
          {caps.length === 0 && <p className="hint">No photographs yet.</p>}
          {caps.map((c) => (
            <div key={c.id} className="hrow" onClick={() => setSel(c)}>
              <img src={urls[c.id]} alt="" />
              <div>
                <div>{new Date(c.createdAt).toLocaleString()}</div>
                <small>
                  {c.id === view?.baselineId ? 'Baseline · ' : ''}
                  {c.width}×{c.height}
                  {c.meta && (c.meta as { registration?: { E?: number } }).registration?.E != null
                    ? ` · E ${((c.meta as { registration: { E: number } }).registration.E).toFixed(3)}`
                    : ''}
                </small>
              </div>
            </div>
          ))}
        </div>
      )}
      {sel && (
        <div className="viewer">
          <div className="stack">
            {full.sel && <img src={full.sel} alt="" />}
            {full.base && sel.id !== base?.id && <img src={full.base} alt="" style={{ opacity: mix }} className="over" />}
          </div>
          {base && sel.id !== base.id && (
            <label className="mix">
              <span>Selected</span>
              <input type="range" min={0} max={1} step={0.01} value={mix} onChange={(e) => setMix(+e.target.value)} />
              <span>Baseline</span>
            </label>
          )}
          <p className="hint small">Unwarped comparison: both images shown exactly as acquired. Residual misalignment is real.</p>
          <div className="actions">
            <button onClick={() => void shareOrDownload([new File([sel.master], name(sel), { type: 'image/jpeg' })], name(sel))}>Save / Share</button>
            <button
              onClick={() => {
                const meta = new Blob([JSON.stringify({ id: sel.id, patientId, viewKey, role: sel.role, createdAt: sel.createdAt, ...sel.meta }, null, 2)], { type: 'application/json' });
                void shareOrDownload([new File([meta], name(sel).replace('.jpg', '.json'), { type: 'application/json' })], 'metadata');
              }}
            >
              Metadata
            </button>
            {sel.id !== view?.baselineId && (
              <button
                onClick={async () => {
                  if (!view) return;
                  await db.putView({ ...view, baselineId: sel.id });
                  await reload();
                }}
              >
                Make baseline
              </button>
            )}
            <ConfirmButton
              label="Delete"
              onConfirm={async () => {
                await db.deleteCapture(sel.id);
                if (view && view.baselineId === sel.id) {
                  const rest = caps.filter((c) => c.id !== sel.id);
                  await db.putView({ ...view, baselineId: rest[0]?.id ?? null });
                }
                setSel(null);
                await reload();
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ConfirmButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      className={armed ? 'danger' : ''}
      onClick={() => {
        if (armed) onConfirm();
        else {
          setArmed(true);
          setTimeout(() => setArmed(false), 2500);
        }
      }}
    >
      {armed ? 'Tap to confirm' : label}
    </button>
  );
}

// ---------------------------------------------------------------- Settings & diagnostics
function SettingsScreen({ settings, onChange, onBack }: { settings: Settings; onChange: (s: Settings) => void; onBack: () => void }) {
  const [logs, setLogs] = useState<LogRecord[]>([]);
  useEffect(() => {
    void db.listLogs().then(setLogs);
  }, []);
  const num = (k: keyof Settings, label: string, step = 1) => (
    <label className="row">
      <span>{label}</span>
      <input type="number" step={step} value={settings[k] as number} onChange={(e) => onChange({ ...settings, [k]: Number(e.target.value) })} />
    </label>
  );
  const bool = (k: keyof Settings, label: string) => (
    <label className="row">
      <span>{label}</span>
      <input type="checkbox" checked={settings[k] as boolean} onChange={(e) => onChange({ ...settings, [k]: e.target.checked })} />
    </label>
  );
  return (
    <div className="page">
      <header className="hdr">
        <button className="link" onClick={onBack}>
          ‹ Back
        </button>
        <h2>Settings</h2>
        <span />
      </header>
      <div className="sectionlabel">Capture</div>
      {bool('haptics', 'Haptic confirmation')}
      {bool('autoCapture', 'Auto-capture at peak opportunity')}
      <label className="row">
        <span>Camera resolution</span>
        <select value={settings.resolution} onChange={(e) => onChange({ ...settings, resolution: e.target.value as Settings['resolution'] })}>
          <option value="1080">1080p (faster)</option>
          <option value="4k">4K (if available)</option>
        </select>
      </label>
      {bool('coach', 'Coaching text (one instruction at a time)')}
      <label className="row">
        <span>Angle guide source</span>
        <select value={settings.angleSource} onChange={(e) => onChange({ ...settings, angleSource: e.target.value as Settings['angleSource'] })}>
          <option value="auto">Auto (tilt sensor if baseline has it)</option>
          <option value="gravity">Tilt sensor only</option>
          <option value="image">Image only</option>
        </select>
      </label>
      {num('angleTolDeg', 'Angle tolerance (°)', 0.25)}
      {bool('developer', 'Diagnostics overlay (also: long-press view name)')}

      <div className="sectionlabel">Registration (developer)</div>
      {num('procLong', 'Processing size (long side px)', 16)}
      {num('refTarget', 'Reference keypoints kept')}
      {num('refDetect', 'Reference ORB detections')}
      {num('refGrid', 'Coverage grid (N×N)')}
      {num('liveDetect', 'Live ORB detections')}
      {num('ratio', 'Ratio test', 0.01)}
      {num('maxHamming', 'Max Hamming distance')}
      {num('ransacPx', 'RANSAC threshold (px)', 0.5)}
      {num('minInliers', 'Min inliers')}
      {bool('clahe', 'CLAHE contrast normalisation')}
      {bool('tracking', 'Guided temporal matching')}
      {num('trackRadius', 'Tracking search radius (px)')}
      {num('trackRatio', 'Tracking ratio test', 0.01)}
      {num('smoothing', 'Smoothing (0–1, higher = faster)', 0.05)}
      {num('strongE', 'Strong convergence E', 0.005)}
      {num('convergingE', 'Converging E (cue scale)', 0.01)}
      {num('sharpMin', 'Sharpness floor')}
      {num('motionMax', 'Max gyro rate at peak (°/s)')}
      {bool('flipYaw', 'Flip yaw cue sign')}
      {bool('flipPitch', 'Flip pitch cue sign')}
      <div className="row">
        <button onClick={() => onChange({ ...DEFAULTS, developer: settings.developer })}>Reset to defaults</button>
      </div>

      <div className="sectionlabel">Diagnostic logs ({logs.length})</div>
      <p className="hint small">Every capture session is logged frame-by-frame on this device (last 40 kept). Export after clinical testing.</p>
      {logs.map((l) => (
        <div key={l.id} className="logrow">
          <div>
            <div>
              {l.patientId} · {viewDef(l.viewKey).label}
            </div>
            <small>
              {new Date(l.startedAt).toLocaleString()} · {Math.round((l.endedAt - l.startedAt) / 1000)}s · {l.rows.length} frames
            </small>
          </div>
          <div className="logbtns">
            <button
              onClick={() => {
                const base = `dentalalign_log_${l.patientId}_${l.viewKey}_${stamp(l.startedAt)}`;
                void shareOrDownload(
                  [
                    new File([toCSV(l.rows)], base + '_frames.csv', { type: 'text/csv' }),
                    new File([JSON.stringify({ info: l.info, events: l.events }, null, 2)], base + '_events.json', { type: 'application/json' }),
                  ],
                  base,
                );
              }}
            >
              Export
            </button>
            <ConfirmButton
              label="✕"
              onConfirm={async () => {
                await db.deleteLog(l.id);
                setLogs(await db.listLogs());
              }}
            />
          </div>
        </div>
      ))}
      <p className="hint small">Build {__BUILD__}</p>
    </div>
  );
}

declare const __BUILD__: string;
