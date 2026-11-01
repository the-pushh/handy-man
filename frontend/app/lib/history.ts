/* Request history, on this device only (no database, no login).

   Job metadata lives in localStorage (one JSON list, newest first, the
   last MAX_JOBS jobs). Photos and the sound clip live in IndexedDB:
   before/after images are downscaled thumbnails, never the full still.
   Every read and write is wrapped: with storage unavailable (private
   browsing, quota, blocked) the app works normally, just without history. */

export const MAX_JOBS = 20;
const KEY = "handyman-history";
const DB = "handyman";
const STORE = "media";
const THUMB_SIDE = 320;

export type Outcome = "fixed" | "still broken" | "called a pro";
export type MediaKind = "before" | "after" | "clip";

export interface Job {
  id: string;
  date: string; // ISO
  device: string;
  issue: string;
  verdict: "diy" | "pro" | null;
  rule: string | null; // fired rule id
  ruleTitle: string | null; // in plain words
  headline: string;
  trade: string | null;
  steps: { check: string; how: string; caution?: string | null }[];
  answers: { ask: string; reply: string }[];
  outcome: Outcome | null;
  finding: string;
  sound: string | null;
  recheck?: { looksFixed: boolean | null; seen: string } | null;
  seconds?: number | null;
  media: Partial<Record<MediaKind, boolean>>;
}

function read(): Job[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function write(list: Job[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch (_) {
    // Storage full or unavailable: history is best-effort.
  }
}

export function listJobs(): Job[] {
  return read();
}

export function getJob(id: string): Job | null {
  return read().find((j) => j.id === id) || null;
}

export function newJobId(): string {
  try {
    return crypto.randomUUID();
  } catch (_) {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/* Insert or replace a job, keep the newest MAX_JOBS, drop the media of
   any job that falls off the end. */
export function saveJob(job: Job): void {
  const list = [job, ...read().filter((j) => j.id !== job.id)];
  const dropped = list.slice(MAX_JOBS);
  write(list.slice(0, MAX_JOBS));
  for (const j of dropped) void deleteMedia(j.id);
}

export function updateJob(id: string, patch: Partial<Job>): void {
  const list = read();
  const i = list.findIndex((j) => j.id === id);
  if (i < 0) return;
  list[i] = { ...list[i], ...patch, media: { ...list[i].media, ...(patch.media || {}) } };
  write(list);
}

export async function clearHistory(): Promise<void> {
  const ids = read().map((j) => j.id);
  try {
    window.localStorage.removeItem(KEY);
  } catch (_) {
    // Nothing to clear.
  }
  await Promise.all(ids.map((id) => deleteMedia(id)));
}

/* ---- IndexedDB media ------------------------------------------------ */

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
}

async function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | null
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => {
        db.close();
        resolve(req ? (req.result as T) : null);
      };
      t.onerror = t.onabort = () => {
        db.close();
        resolve(null);
      };
    } catch (_) {
      db.close();
      resolve(null);
    }
  });
}

/* Downscale an image to a small JPEG thumbnail (longest side 320px). */
async function thumbnail(blob: Blob): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, THUMB_SIDE / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext("2d")?.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b), "image/jpeg", 0.7));
  } catch (_) {
    return null;
  }
}

export async function putMedia(id: string, kind: MediaKind, blob: Blob | null | undefined): Promise<void> {
  if (!blob) return;
  const data = kind === "clip" ? blob : await thumbnail(blob);
  if (!data) return;
  const ok = await tx("readwrite", (s) => s.put(data, `${id}:${kind}`));
  if (ok !== null) updateJob(id, { media: { [kind]: true } });
}

export async function getMedia(id: string, kind: MediaKind): Promise<Blob | null> {
  const out = await tx<Blob>("readonly", (s) => s.get(`${id}:${kind}`));
  return out instanceof Blob ? out : null;
}

async function deleteMedia(id: string): Promise<void> {
  await tx("readwrite", (s) => {
    for (const kind of ["before", "after", "clip"]) s.delete(`${id}:${kind}`);
    return null;
  });
}
