/* Spoken lines, fetched once and kept for the session.

   Each line costs a round trip to the voice model (about 1.5-2 s from a
   phone). Lines we know are coming (every step of a fix, "Is it fixed
   now?") are fetched ahead with prefetchSpeech, so when the owner taps
   Next the audio is already here and starts at once. */

import { mark } from "./timeline";

const cache = new Map<string, Promise<Blob | null>>();
const MAX = 120;

// Prefetches run two at a time so they never crowd out a line the owner
// is waiting for (those skip this queue).
let active = 0;
const waiting: (() => void)[] = [];
function slot(): Promise<void> {
  if (active < 2) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((res) => waiting.push(() => { active += 1; res(); }));
}
function release(): void {
  active -= 1;
  waiting.shift()?.();
}

function key(text: string, lang: string, maxSeconds?: number | null): string {
  return `${lang}|${maxSeconds ?? ""}|${text}`;
}

async function fetchBlob(api: string, text: string, lang: string, maxSeconds?: number | null): Promise<Blob | null> {
  mark("tts request", JSON.stringify(text.slice(0, 40)));
  try {
    const r = await fetch(`${api}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang, max_seconds: maxSeconds ?? null }),
    });
    const data = await r.json();
    mark("tts audio received", data.audio_b64 ? "" : "fallback");
    if (!data.audio_b64) return null;
    const bytes = Uint8Array.from(atob(data.audio_b64), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: data.mime || "audio/wav" });
  } catch {
    return null;
  }
}

function remember(k: string, p: Promise<Blob | null>): Promise<Blob | null> {
  cache.set(k, p);
  // A failed fetch is not kept: the next ask tries again.
  void p.then((b) => { if (!b && cache.get(k) === p) cache.delete(k); });
  while (cache.size > MAX) cache.delete(cache.keys().next().value as string);
  return p;
}

/* The audio for a line now: from the cache when it was fetched before. */
export function getSpeech(api: string, text: string, lang = "en", maxSeconds?: number | null): Promise<Blob | null> {
  const k = key(text, lang, maxSeconds);
  const have = cache.get(k);
  if (have) {
    mark("tts cached", JSON.stringify(text.slice(0, 40)));
    return have;
  }
  return remember(k, fetchBlob(api, text, lang, maxSeconds));
}

/* Fetch lines in the background, in order, so they are ready later. */
export function prefetchSpeech(api: string, lines: string[], lang = "en"): void {
  for (const text of lines) {
    if (!text) continue;
    const k = key(text, lang);
    if (cache.has(k)) continue;
    remember(k, slot().then(() => fetchBlob(api, text, lang)).finally(release));
  }
}
