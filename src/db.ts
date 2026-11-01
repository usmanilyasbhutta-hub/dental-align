// Minimal IndexedDB layer. Dental Align is not a patient database (spec §26):
// Patient ID → View → Baseline + follow-ups, plus acquisition metadata and diagnostic logs.

export interface Patient {
  id: string;
  createdAt: number;
  updatedAt: number;
}

export interface ViewRecord {
  key: string; // `${patientId}|${viewKey}`
  patientId: string;
  viewKey: string;
  baselineId: string | null;
  createdAt: number;
}

export interface Capture {
  id: string;
  patientId: string;
  viewKey: string;
  role: 'baseline' | 'followup';
  createdAt: number;
  master: Blob; // untouched acquisition (JPEG of the selected camera frame, no geometric change)
  thumb: Blob;
  width: number;
  height: number;
  meta: Record<string, unknown>;
}

export interface LogRecord {
  id: string;
  patientId: string;
  viewKey: string;
  startedAt: number;
  endedAt: number;
  rows: Record<string, unknown>[];
  events: Record<string, unknown>[];
  info: Record<string, unknown>;
}

const DB_NAME = 'dental-align';
const VERSION = 1;
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('patients', { keyPath: 'id' });
      const v = db.createObjectStore('views', { keyPath: 'key' });
      v.createIndex('patient', 'patientId');
      const c = db.createObjectStore('captures', { keyPath: 'id' });
      c.createIndex('view', ['patientId', 'viewKey']);
      c.createIndex('patient', 'patientId');
      db.createObjectStore('logs', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const r = fn(s);
        let result: T;
        if (r) r.onsuccess = () => (result = r.result);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const db = {
  async listPatients(): Promise<Patient[]> {
    const all = await tx<Patient[]>('patients', 'readonly', (s) => s.getAll());
    return (all || []).sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async touchPatient(id: string) {
    const existing = await tx<Patient | undefined>('patients', 'readonly', (s) => s.get(id));
    const now = Date.now();
    await tx('patients', 'readwrite', (s) => s.put({ id, createdAt: existing?.createdAt ?? now, updatedAt: now }));
  },
  async deletePatient(id: string) {
    const views = await this.listViews(id);
    for (const v of views) await tx('views', 'readwrite', (s) => s.delete(v.key));
    const caps = await tx<Capture[]>('captures', 'readonly', (s) => s.index('patient').getAll(id));
    for (const c of caps || []) await tx('captures', 'readwrite', (s) => s.delete(c.id));
    await tx('patients', 'readwrite', (s) => s.delete(id));
  },
  async listViews(patientId: string): Promise<ViewRecord[]> {
    return (await tx<ViewRecord[]>('views', 'readonly', (s) => s.index('patient').getAll(patientId))) || [];
  },
  async getView(patientId: string, viewKey: string): Promise<ViewRecord | undefined> {
    return tx<ViewRecord | undefined>('views', 'readonly', (s) => s.get(`${patientId}|${viewKey}`));
  },
  async putView(v: ViewRecord) {
    await tx('views', 'readwrite', (s) => s.put(v));
  },
  async getCapture(id: string): Promise<Capture | undefined> {
    return tx<Capture | undefined>('captures', 'readonly', (s) => s.get(id));
  },
  async listCaptures(patientId: string, viewKey: string): Promise<Capture[]> {
    const all = (await tx<Capture[]>('captures', 'readonly', (s) => s.index('view').getAll([patientId, viewKey]))) || [];
    return all.sort((a, b) => a.createdAt - b.createdAt);
  },
  async putCapture(c: Capture) {
    await tx('captures', 'readwrite', (s) => s.put(c));
  },
  async deleteCapture(id: string) {
    await tx('captures', 'readwrite', (s) => s.delete(id));
  },
  async putLog(l: LogRecord) {
    await tx('logs', 'readwrite', (s) => s.put(l));
  },
  async listLogs(): Promise<LogRecord[]> {
    const all = (await tx<LogRecord[]>('logs', 'readonly', (s) => s.getAll())) || [];
    return all.sort((a, b) => b.startedAt - a.startedAt);
  },
  async deleteLog(id: string) {
    await tx('logs', 'readwrite', (s) => s.delete(id));
  },
};
