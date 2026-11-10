import { useEffect, useRef, useState } from 'react';
import { CaptureEngine, type EngineState } from './engine';
import { OverlayRenderer } from './overlay';
import { motion } from './motion';
import { db, uid, type Capture as CaptureRec } from './db';
import { viewDef } from './views';
import type { Settings } from './settings';
import { IconClose, IconGhost, IconPhoto, IconSpeaker, IconSpeakerOff } from './icons';
import { sound } from './sound';
import { haptic } from './haptics';
import { importPhoto } from './importPhoto';
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
  const [loaded, setLoaded] = useState(false);
  const shutterRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const coachRef = useRef<Coach | null>(null);
  const [lastThumb, setLastThumb] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
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
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [patientId, viewKey]);

  // zoom the baseline was taken at (in-app baselines record it; imported photos do not)
  const baseZoom = (baseline?.meta as { zoom?: number } | undefined)?.zoom ?? null;
  const zoomLocked = baseZoom != null;

  useEffect(() => {
    const att = (baseline?.meta as { attitude?: { gravity?: Vec3 | null } } | undefined)?.attitude;
    baseGravityRef.current = att?.gravity ?? null;
    const eng = engineRef.current;
    if (!eng) return;
    eng.baseGravity = baseGravityRef.current;
    eng.requestReference(baseline?.master ?? null);
    if (baseZoom != null) void eng.setZoom(baseZoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline, loaded]);

  // ---- engine lifecycle
  useEffect(() => {
    if (!loaded) return;
    const video = videoRef.current!;
    const eng = new CaptureEngine(video, settingsRef.current);
    engineRef.current = eng;
    eng.zoom = baseZoom ?? settingsRef.current.zoom ?? 1;
    eng.state.zoom = eng.zoom;
    eng.baseGravity = baseGravityRef.current;
    eng.requestReference(baseline?.master ?? null);
    let lastUi = 0;
    let lastCapturing = false;
    let lastReady = false;
    let lastGhost: string | null = null;
    eng.onState = (s) => {
      stateRef.current = s;
      const now = performance.now();
      if (now - lastUi > 120 || s.capturing !== lastCapturing || s.workerReady !== lastReady || !!s.error || s.ghostUrl !== lastGhost) {
        lastGhost = s.ghostUrl;
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
    sound.onTick = (q) => {
      if (settingsRef.current.haptics && q > 0.55) haptic(q >= 1 ? 'success' : 'tick');
    };
    sound.start();

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
        const aligned = S.hasRef && (S.phase === 'strong' || S.phase === 'peak');
        const closeness = S.hasRef && S.smooth ? 1 - Math.min(1, S.smooth.E / cfg.convergingE) : null;
        renderer.draw({ canvas: canvasRef.current, state: S, settings: cfg, viewKey, phoneRoll: motion.phoneRoll(), angle, coach: coachRef.current });
        sound.enabled = cfg.sound;
        sound.update(closeness, aligned);
        shutterRef.current?.style.setProperty('--p', String(aligned ? 1 : closeness ?? 0));
        const now = performance.now();
        if (now - lastCoach > 200) {
          lastCoach = now;
          setAngleInfo(angle);
          coachRef.current = cfg.coach
            ? coach({ hasRef: S.hasRef, reg: S.smooth, angle, angleTolDeg: cfg.angleTolDeg, motionRate: S.motionRate, motionMax: cfg.motionMax, sharpOk: S.sharpOk, aligned })
            : null;
          setCoachMsg(coachRef.current);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      sound.stop();
      sound.onTick = null;
      const L = logRef.current;
      const info = { camera: eng.cameraInfo(), settings: settingsRef.current, userAgent: navigator.userAgent, refPoints: eng.state.refPoints.length, motionPermission: motion.permission };
      eng.stop();
      engineRef.current = null;
      if (L.rows.length > 5) {
        void db.putLog({ id: uid(), patientId, viewKey, startedAt: L.startedAt, endedAt: Date.now(), rows: L.rows, events: L.events, info }).then(pruneLogs);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // keep engine settings live
  useEffect(() => {
    if (engineRef.current) engineRef.current.settings = settings;
  }, [settings]);

  const busyRef = useRef(false);
  async function doCapture() {
    const eng = engineRef.current;
    sound.unlock();
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

  const ghostMode = settings.ghostMode;
  const cycleGhost = () => {
    const order: Settings['ghostMode'][] = ['both', 'outline', 'photo', 'off'];
    const n = order[(order.indexOf(ghostMode) + 1) % order.length];
    onSettings({ ...settings, ghostMode: n });
    showToast({ both: 'Ghost: photo + outline', outline: 'Ghost: outline', photo: 'Ghost: photo', off: 'Ghost off' }[n]);
  };
  const cycleZoom = () => {
    const eng = engineRef.current;
    if (!eng) return;
    if (zoomLocked) return showToast(`Zoom is fixed at the baseline's ${baseZoom}×`);
    const n = eng.zoom >= 3 ? 1 : eng.zoom + 1;
    void eng.setZoom(n);
    onSettings({ ...settings, zoom: n });
  };
  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const rec = await importPhoto(f, patientId, viewKey);
      setLastThumb(URL.createObjectURL(rec.thumb));
      if (rec.role === 'baseline') {
        setBaseline(rec);
        showToast('Photo set as baseline');
      } else showToast('Photo added');
    } catch (err) {
      showToast('Could not read that photo: ' + (err as Error).message);
    }
  };
  const ghostUrl = st?.ghostUrl ?? null;

  const phase = st?.phase ?? 'searching';
  const aligned = !!baseline && (phase === 'peak' || phase === 'strong');
  const shutterClass = `shutter ${st?.capturing ? 'busy' : ''} ${baseline && phase === 'peak' ? 'peak' : aligned ? 'strong' : ''}`;

  return (
    <div className="capture" onPointerDown={() => sound.unlock()}>
      <video ref={videoRef} className="cam" playsInline muted autoPlay />
      {ghostUrl && <img src={ghostUrl} className="ghost" style={{ opacity: ghostMode === 'photo' ? 0.42 : ghostMode === 'both' ? 0.3 : 0 }} alt="" draggable={false} />}
      {st?.outlineUrl && <img src={st.outlineUrl} className="ghost outline" style={{ opacity: ghostMode === 'outline' || ghostMode === 'both' ? 0.95 : 0 }} alt="" draggable={false} />}
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPick} />
      <canvas ref={canvasRef} className="overlay" />
      {flash && <div className="flash" />}

      <div className="cam-top">
        <button className="glass glass-circle clear interactive" onClick={onClose} aria-label="Close camera">
          <IconClose />
        </button>
        <div className="cam-title glass clear" onPointerDown={startPress} onPointerUp={endPress} onPointerLeave={endPress}>
          <span className="cam-view">{def.label}</span>
          <span className="cam-pid">{baseline ? `${patientId}, follow-up` : `${patientId}, baseline`}</span>
        </div>
        <div className="cam-tools">
          <button className={`glass glass-circle clear interactive ${settings.sound ? 'on' : ''}`} onClick={() => { sound.unlock(); onSettings({ ...settings, sound: !settings.sound }); showToast(settings.sound ? 'Sound guidance off' : 'Sound guidance on'); }} aria-label="Sound guidance">
            {settings.sound ? <IconSpeaker /> : <IconSpeakerOff />}
          </button>
          <button className={`glass glass-circle clear interactive ${ghostMode !== 'off' && ghostUrl ? 'on' : ''}`} onClick={cycleGhost} aria-label="Ghost style" disabled={!ghostUrl}>
            <IconGhost />
          </button>
        </div>
      </div>

      {st?.error && <div className="cam-notice err">{st.error}</div>}
      {!st?.error && st && !st.workerReady && <div className="cam-notice glass clear">Preparing alignment…</div>}
      {st?.aspectMismatch && <div className="cam-notice glass clear">Turn the phone to match the baseline photo</div>}
      {st?.lightingHint && !settings.developer && <div className="lighthint">{st.lightingHint === 'darker' ? 'Lighting is dimmer than the baseline' : 'Lighting is brighter than the baseline'}</div>}
      {toast && <div className="cam-toast glass clear">{toast}</div>}
      {coachMsg && !toast && <div className={`coach glass clear ${coachMsg.kind}`}>{coachMsg.text}</div>}

      {settings.developer && st && <DevHud st={st} log={logRef.current} angle={angleInfo} />}

      <div className="cam-bottom">
        {baseline || lastThumb ? (
          <button className="cam-thumb" onClick={onHistory} aria-label="Photo history">
            {lastThumb ? <img src={lastThumb} alt="" /> : <span />}
          </button>
        ) : (
          <button className="cam-import glass clear interactive" onClick={() => fileRef.current?.click()}>
            <IconPhoto />
            <span>Use a photo</span>
          </button>
        )}
        <button ref={shutterRef} className={shutterClass} onClick={() => void doCapture()} aria-label="Take photo">
          <span className="shutter-arc" />
          <span className="shutter-halo" />
          <span className="shutter-core" />
        </button>
        <button className={`cam-zoom glass clear interactive ${zoomLocked ? 'locked' : ''}`} onClick={cycleZoom} aria-label="Zoom">
          {st?.zoom ?? 1}×
        </button>
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
