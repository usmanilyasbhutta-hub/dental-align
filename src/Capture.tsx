import { useEffect, useRef, useState } from 'react';
import { CaptureEngine, type EngineState } from './engine';
import { OverlayRenderer } from './overlay';
import { motion } from './motion';
import { db, uid, type Capture as CaptureRec } from './db';
import { viewDef } from './views';
import type { Settings } from './settings';
import { IconClose, IconGhost } from './icons';
import { coach, gravityCue, imageCue, type AngleCue, type Coach, type Vec3 } from './guidance';

interface Props {
  patientId: string;
  viewKey: string;
  settings: Settings;
  onSettings: (s: Settings) => void;
  onClose: () => void;
  onHistory: () => void;
}

const MAX_LOG_ROWS = 20000;

export default function Capture({ patientId, viewKey, settings, onSettings, onClose, onHistory }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CaptureEngine | null>(null);
  const stateRef = useRef<EngineState | null>(null);
  const [st, setSt] = useState<EngineState | null>(null);
  const [baseline, setBaseline] = useState<CaptureRec | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [lastThumb, setLastThumb] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [ghost, setGhost] = useState(settings.ghostOpacity);
  const [coachMsg, setCoachMsg] = useState<Coach | null>(null);
  const [angleInfo, setAngleInfo] = useState<AngleCue | null>(null);
  const baseGravityRef = useRef<Vec3 | null>(null);
  const logRef = useRef<{ rows: Record<string, unknown>[]; events: Record<string, unknown>[]; startedAt: number }>({ rows: [], events: [], startedAt: Date.now() });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const def = viewDef(viewKey);

  // ---- load baseline + last capture
  useEffect(() => {
    let alive = true;
    (async () => {
      const v = await db.getView(patientId, viewKey);
      const caps = await db.listCaptures(patientId, viewKey);
      if (!alive) return;
      const b = v?.baselineId ? caps.find((c) => c.id === v.baselineId) ?? null : null;
      setBaseline(b);
      const lastC = caps[caps.length - 1];
      if (lastC) setLastThumb(URL.createObjectURL(lastC.thumb));
    })();
    return () => {
      alive = false;
    };
  }, [patientId, viewKey]);

  useEffect(() => {
    if (!baseline) {
      baseGravityRef.current = null;
      setBaseUrl(null);
      engineRef.current?.requestReference(null);
      return;
    }
    const att = (baseline.meta as { attitude?: { gravity?: Vec3 | null } } | undefined)?.attitude;
    baseGravityRef.current = att?.gravity ?? null;
    if (engineRef.current) engineRef.current.baseGravity = baseGravityRef.current;
    const u = URL.createObjectURL(baseline.master);
    setBaseUrl(u);
    engineRef.current?.requestReference(baseline.master);
    return () => URL.revokeObjectURL(u);
  }, [baseline]);

  // ---- engine lifecycle
  useEffect(() => {
    const video = videoRef.current!;
    const eng = new CaptureEngine(video, settingsRef.current);
    engineRef.current = eng;
    let lastUi = 0;
    let lastCapturing = false;
    let lastReady = false;
    eng.onState = (s) => {
      stateRef.current = s;
      const now = performance.now();
      if (now - lastUi > 120 || s.capturing !== lastCapturing || s.workerReady !== lastReady || !!s.error) {
        lastUi = now;
        lastCapturing = s.capturing;
        lastReady = s.workerReady;
        setSt(s);
      }
    };
    eng.onLog = (row) => {
      const L = logRef.current;
      if (L.rows.length < MAX_LOG_ROWS) L.rows.push(row);
    };
    eng.onEvent = (ev) => {
      logRef.current.events.push({ t: Math.round(performance.now()), wall: Date.now(), ...ev });
    };
    eng.autoCaptureCb = () => void doCapture();
    void eng.startCamera();
    motion.start();

    const renderer = new OverlayRenderer();
    let raf = 0;
    let lastCoach = 0;
    const loop = () => {
      const S = stateRef.current, cfg = settingsRef.current;
      if (S && canvasRef.current) {
        eng.baseGravity = baseGravityRef.current;
        let angle: AngleCue | null = null;
        if (S.hasRef) {
          const gc = cfg.angleSource !== 'image' ? gravityCue(motion.gravity(), baseGravityRef.current) : null;
          angle = gc ?? (cfg.angleSource !== 'gravity' ? imageCue(S.smooth, cfg.flipYaw, cfg.flipPitch) : null);
        }
        renderer.draw({ canvas: canvasRef.current, state: S, settings: cfg, viewKey, phoneRoll: motion.phoneRoll(), angle });
        const now = performance.now();
        if (now - lastCoach > 200) {
          lastCoach = now;
          setAngleInfo(angle);
          setCoachMsg(
            cfg.coach
              ? coach({ hasRef: S.hasRef, reg: S.smooth, angle, angleTolDeg: cfg.angleTolDeg, motionRate: S.motionRate, motionMax: cfg.motionMax, sharpOk: S.sharpOk })
              : null,
          );
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      const L = logRef.current;
      const info = { camera: eng.cameraInfo(), settings: settingsRef.current, userAgent: navigator.userAgent, refPoints: eng.state.refPoints.length, motionPermission: motion.permission };
      eng.stop();
      engineRef.current = null;
      if (L.rows.length > 5) {
        void db.putLog({ id: uid(), patientId, viewKey, startedAt: L.startedAt, endedAt: Date.now(), rows: L.rows, events: L.events, info }).then(pruneLogs);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // reference may have been loaded before the engine existed
  useEffect(() => {
    if (engineRef.current && baseline) engineRef.current.requestReference(baseline.master);
  }, [baseline, st?.workerReady]);

  // keep engine settings live
  useEffect(() => {
    if (engineRef.current) engineRef.current.settings = settings;
  }, [settings]);

  const busyRef = useRef(false);
  async function doCapture() {
    const eng = engineRef.current;
    if (!eng || busyRef.current) return;
    busyRef.current = true;
    setFlash(true);
    setTimeout(() => setFlash(false), 180);
    try {
      const out = await eng.capture();
      if (!out) return;
      const v = await db.getView(patientId, viewKey);
      const isBaseline = !v?.baselineId;
      const rec: CaptureRec = {
        id: uid(),
        patientId,
        viewKey,
        role: isBaseline ? 'baseline' : 'followup',
        createdAt: Date.now(),
        master: out.master,
        thumb: out.thumb,
        width: out.width,
        height: out.height,
        meta: { ...out.meta, referenceId: v?.baselineId ?? null },
      };
      await db.putCapture(rec);
      await db.putView({ key: `${patientId}|${viewKey}`, patientId, viewKey, baselineId: v?.baselineId ?? rec.id, createdAt: v?.createdAt ?? Date.now() });
      await db.touchPatient(patientId);
      setLastThumb(URL.createObjectURL(out.thumb));
      if (isBaseline) {
        // The first satisfactory photograph automatically becomes the baseline (spec §6).
        setBaseline(rec);
        showToast('Baseline saved');
      } else showToast('Follow-up saved');
    } catch (e) {
      showToast('Capture failed: ' + (e as Error).message);
    } finally {
      busyRef.current = false;
    }
  }

  function showToast(t: string) {
    setToast(t);
    setTimeout(() => setToast(null), 1400);
  }

  // hidden developer toggle: long-press the view label
  const pressT = useRef<number | null>(null);
  const startPress = () => {
    pressT.current = window.setTimeout(() => {
      onSettings({ ...settings, developer: !settings.developer });
      showToast(settings.developer ? 'Diagnostics off' : 'Diagnostics on');
    }, 900);
  };
  const endPress = () => {
    if (pressT.current) clearTimeout(pressT.current);
  };

  const cycleGhost = () => {
    const steps = [0, 0.2, 0.35, 0.55];
    const i = steps.findIndex((x) => Math.abs(x - ghost) < 0.01);
    const n = steps[(i + 1) % steps.length];
    setGhost(n);
    onSettings({ ...settings, ghostOpacity: n });
    showToast(n === 0 ? 'Ghost off' : `Ghost ${Math.round(n * 100)}%`);
  };

  const phase = st?.phase ?? 'searching';
  const aligned = !!baseline && (phase === 'peak' || phase === 'strong');
  const shutterClass = `shutter ${st?.capturing ? 'busy' : ''} ${baseline && phase === 'peak' ? 'peak' : aligned ? 'strong' : ''}`;

  return (
    <div className="capture">
      <video ref={videoRef} className="cam" playsInline muted autoPlay />
      {baseUrl && <img src={baseUrl} className="ghost" style={{ opacity: ghost }} alt="" draggable={false} />}
      <canvas ref={canvasRef} className="overlay" />
      {flash && <div className="flash" />}

      <div className="cam-top">
        <button className="cam-btn" onClick={onClose} aria-label="Close camera">
          <IconClose />
        </button>
        <div className="cam-title" onPointerDown={startPress} onPointerUp={endPress} onPointerLeave={endPress}>
          <span className="cam-view">{def.label}</span>
          <span className="cam-pid">{baseline ? patientId : `${patientId}, first photo`}</span>
        </div>
        <button className={`cam-btn ${ghost > 0 && baseUrl ? 'on' : ''}`} onClick={cycleGhost} aria-label="Ghost opacity" disabled={!baseUrl}>
          <IconGhost />
        </button>
      </div>

      {st?.error && <div className="cam-notice err">{st.error}</div>}
      {!st?.error && st && !st.workerReady && <div className="cam-notice">Preparing alignment…</div>}
      {st?.aspectMismatch && <div className="cam-notice">Hold the phone the same way as in the baseline</div>}
      {st?.lightingHint && !settings.developer && <div className="lighthint">{st.lightingHint === 'darker' ? 'Lighting is dimmer than the baseline' : 'Lighting is brighter than the baseline'}</div>}
      {toast && <div className="cam-toast">{toast}</div>}
      {coachMsg && !toast && <div className={`coach ${coachMsg.kind}`}>{coachMsg.text}</div>}

      {settings.developer && st && <DevHud st={st} log={logRef.current} angle={angleInfo} />}

      <div className="cam-bottom">
        <button className="cam-thumb" onClick={onHistory} aria-label="Photo history">
          {lastThumb ? <img src={lastThumb} alt="" /> : <span />}
        </button>
        <button className={shutterClass} onClick={() => void doCapture()} aria-label="Take photo">
          <span className="shutter-halo" />
          <span className="shutter-core" />
        </button>
        <div className="cam-mode">{baseline ? 'Follow-up' : 'Baseline'}</div>
      </div>
    </div>
  );
}

async function pruneLogs() {
  const logs = await db.listLogs();
  for (const l of logs.slice(40)) await db.deleteLog(l.id);
}

function f(v: number | null | undefined, d = 3) {
  return v == null || Number.isNaN(v) ? '—' : v.toFixed(d);
}

function DevHud({ st, log, angle }: { st: EngineState; log: { rows: Record<string, unknown>[] }; angle: AngleCue | null }) {
  const r = st.last;
  const g = st.smooth;
  const raw = st.raw;
  const J = st.controllerJ;
  const recent = log.rows.slice(-30);
  const fol = recent.map((x) => x.followed as number | null).filter((x): x is number => x != null);
  const imp = recent.map((x) => x.improved as boolean | null).filter((x): x is boolean => x != null);
  return (
    <div className="devhud">
      <div>
        <b>{st.phase}</b> · fps {f(st.fps, 1)} · proc {f(st.procMs, 0)}ms · drop {st.dropped}
      </div>
      <div>
        video {st.videoDims?.w}×{st.videoDims?.h} · proc {st.procDims?.w}×{st.procDims?.h}
      </div>
      <div>
        {r?.matchMode ?? '—'} · ref {st.refPoints.length} · live {r?.liveFeatures ?? '—'} · cand {r?.candidates ?? '—'} · inl {r?.inliers ?? '—'} ({f(r?.inlierRatio, 2)})
      </div>
      <div>
        cov4 {f(r?.coverage, 2)} · cells {f(r?.cellCoverage, 2)} · simRMS {f(r?.simRms, 4)} · homRMS {f(r?.homRms, 4)}
      </div>
      <div>
        raw t({f(raw?.tx)},{f(raw?.ty)}) s {f(raw?.scale)} roll {raw ? f((raw.roll * 180) / Math.PI, 2) : '—'}° p({f(raw?.px, 3)},{f(raw?.py, 3)})
      </div>
      <div>
        E {f(raw?.E)} [t {f(raw?.Et)} s {f(raw?.Es)} r {f(raw?.Er)} p {f(raw?.Ep)}] · Esm {f(g?.E)}
      </div>
      <div>
        sharp {f(r?.sharpness, 0)} {st.sharpOk ? '✓' : '✗'} · lum {f(r?.brightness?.mean, 0)} clip {f(r?.brightness?.clipped, 3)} · lumRatio {f(r?.lumRatio ?? null, 2)}
      </div>
      <div>
        gyro {f(st.motionRate, 1)}°/s · perm {motion.permission} · roll(g) {motion.phoneRoll() == null ? '—' : f(((motion.phoneRoll() as number) * 180) / Math.PI, 1)}°
      </div>
      <div>
        followed(avg30) {fol.length ? f(fol.reduce((a, b) => a + b, 0) / fol.length, 2) : '—'} · improved {imp.length ? Math.round((100 * imp.filter(Boolean).length) / imp.length) + '%' : '—'}
      </div>
      <div>
        angle {angle ? `${angle.source} ${angle.deg.toFixed(1)}° aim(${((angle.x * 180) / Math.PI).toFixed(1)}, ${((angle.y * 180) / Math.PI).toFixed(1)})` : 'n/a (no baseline attitude & no registration)'}
      </div>
      <div>J {J ? `[${J.map((x) => (x * 1000).toFixed(2)).join(', ')}]e-3 w/°` : 'learning…'} · rows {log.rows.length}</div>
    </div>
  );
}
