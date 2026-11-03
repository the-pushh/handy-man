/* Request history: on this device, and on the server for this browser.

   Job metadata lives in localStorage (one JSON list, newest first, the
   last MAX_JOBS jobs). Photos and the sound clip live in IndexedDB:
   before/after images are downscaled thumbnails, never the full still.
   Every read and write is wrapped: with storage unavailable (private
   browsing, quota, blocked) the app works normally, just without history.

   Server copy (backend/history_store.py, when the backend has a
   database): every job and its small images are also saved under this
   browser's random ID (lib/userId.ts; one browser is one user, no
   login). The server keeps more than MAX_JOBS, and an image missing
   here is fetched from it. Without a database the server answers "off"
   and this stays local-only. */

import { IS_PROD, resolveApiBase } from "./apiBase";
import { userId } from "./userId";

export const MAX_JOBS = 20;
const KEY = "handyman-history";
const DB = "handyman";
const STORE = "media";
const THUMB_SIDE = 320;

export type Outcome = "fixed" | "still broken" | "called a pro";
// Step pictures: the photo with that step's part outlined (SAM) or the
// illustrated highlight, as the owner saw it, under "step0", "step1"…
export type MediaKind = "before" | "after" | "clip" | `step${number}`;
const MAX_STEPS = 12;

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
  steps: { check: string; how: string; caution?: string | null; part?: string | null }[];
  answers: { ask: string; reply: string }[];
  outcome: Outcome | null;
  finding: string;
  sound: string | null;
  recheck?: { looksFixed: boolean | null; seen: string } | null;
  seconds?: number | null;
  media: Partial<Record<MediaKind, boolean>>;
  // The item the owner named ("air conditioner"): runs group under it.
  machine?: string;
  // Run number on that machine, and the run before it.
  attempt?: number;
  parentId?: string | null;
  // A scan-time warning the owner overrode, at their own risk.
  riskAccepted?: { rule: string; title: string } | null;
  // The technicians found for this diagnosis (as listed, with phones),
  // and who the owner called or texted from the list.
  pros?: SavedPro[];
  prosTrade?: string | null;
  contacted?: { name: string; phone: string | null; how: "call" | "text" | "whatsapp"; at: string } | null;
}

export interface SavedPro {
  id: string;
  name: string;
  address: string;
  distance_km: number;
  open_now: boolean | null;
  phone: string | null;
  rating: number | null;
  ratings: number | null;
  maps_url: string | null;
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
  // Only the local copy is trimmed: the server keeps the older runs.
  for (const j of dropped) void deleteMedia(j.id);
  pushSoon(job.id);
}

export function updateJob(id: string, patch: Partial<Job>): void {
  const list = read();
  const i = list.findIndex((j) => j.id === id);
  if (i < 0) return;
  list[i] = { ...list[i], ...patch, media: { ...list[i].media, ...(patch.media || {}) } };
  write(list);
  pushSoon(id);
}

export async function clearHistory(): Promise<void> {
  // Server first ("Delete my history": runs, images and feedback rows).
  await remote("/api/history", { method: "DELETE" });
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
async function thumbnail(blob: Blob, side = THUMB_SIDE): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
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
  const data = kind === "clip" ? blob : await thumbnail(blob, kind.startsWith("step") ? 480 : THUMB_SIDE);
  if (!data) return;
  const ok = await tx("readwrite", (s) => s.put(data, `${id}:${kind}`));
  if (ok !== null) updateJob(id, { media: { [kind]: true } });
  // The same small file to the server.
  const fd = new FormData();
  fd.append("file", data, kind === "clip" ? "clip.wav" : `${kind}.jpg`);
  void remote(`/api/history/media/${encodeURIComponent(id)}/${kind}`, { method: "PUT", body: fd });
}

export async function getMedia(id: string, kind: MediaKind): Promise<Blob | null> {
  const out = await tx<Blob>("readonly", (s) => s.get(`${id}:${kind}`));
  if (out instanceof Blob) return out;
  // Not on this phone (an older run, or cleared storage): the server copy.
  const r = await remote(`/api/history/media/${encodeURIComponent(id)}/${kind}`, { method: "GET" }, true);
  if (!(r instanceof Response) || !r.ok) return null;
  const blob = await r.blob();
  void tx("readwrite", (s) => s.put(blob, `${id}:${kind}`));
  return blob;
}

/* ---- Server copy ------------------------------------------------------ */

let remoteOff = false;

function base(): string {
  if (IS_PROD) return "";
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem("handyman-api-base");
  } catch (_) {
    // Storage unavailable.
  }
  return resolveApiBase(process.env.NEXT_PUBLIC_API_BASE, stored, window.location.hostname);
}

/* A request to the history API with this browser's ID. JSON replies are
   parsed (and "off" switches the server copy off for this session);
   `raw` returns the Response (images). Never throws. */
async function remote(path: string, init: RequestInit, raw = false): Promise<unknown> {
  if (remoteOff || typeof window === "undefined") return null;
  const user = userId();
  if (!user) return null;
  try {
    const r = await fetch(`${base()}${path}`, {
      ...init,
      headers: { ...(init.headers || {}), "x-handyman-user": user },
      signal: AbortSignal.timeout(15000),
    });
    if (raw) return r;
    const d = (await r.json()) as { status?: string };
    if (d?.status === "off") remoteOff = true;
    return d;
  } catch (_) {
    return null;
  }
}

const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/* Send a job to the server a moment after its last change (a run updates
   several times as it ends; one request carries them all). */
function pushSoon(id: string): void {
  if (remoteOff || typeof window === "undefined") return;
  const t = pushTimers.get(id);
  if (t) clearTimeout(t);
  pushTimers.set(
    id,
    setTimeout(() => {
      pushTimers.delete(id);
      const job = getJob(id);
      if (!job) return;
      void remote(`/api/history/runs/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(job),
      });
    }, 800)
  );
}

/* Every run for this browser: this phone's, plus older ones only the
   server still has. The phone's copy wins when both have a run. */
export async function listAllJobs(): Promise<Job[]> {
  const local = read();
  const d = (await remote("/api/history/runs", { method: "GET" })) as { status?: string; runs?: Job[] } | null;
  if (!d || d.status !== "ok" || !Array.isArray(d.runs)) return local;
  const seen = new Set(local.map((j) => j.id));
  const extra = d.runs.filter((j) => j && typeof j.id === "string" && !seen.has(j.id));
  return [...local, ...extra].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

async function deleteMedia(id: string): Promise<void> {
  await tx("readwrite", (s) => {
    const kinds = ["before", "after", "clip", ...Array.from({ length: MAX_STEPS }, (_, i) => `step${i}`)];
    for (const kind of kinds) s.delete(`${id}:${kind}`);
    return null;
  });
}
