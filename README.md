# Handyman

Fix what you can. Call for what you can't.

**Live:** https://<your-vercel-domain> (free to use, no login)

Point your phone at something broken and say what's wrong. Meta's models
look, listen and diagnose; a rules layer decides whether you can fix it
yourself. If you can, it walks you through it step by step and checks the
result with the camera. If not, it names the safety rule and shows nearby
pros with a ready-to-share brief.

## Stack

- Frontend: Next.js + TypeScript in `frontend/`, on Vercel. The browser
  only talks to its own origin; `frontend/middleware.ts` proxies `/api/*`
  to the backend.
- Backend: FastAPI in `backend/server.py`, served on Modal by
  `backend/modal_app.py`. Model calls go to Meta's hosted Model API; the safety
  rules are `backend/risk.py`; speech is local MMS-TTS.

| Role | Model | Where |
|---|---|---|
| Perception, diagnosis, decision, re-check | `muse-spark-1.3` (prod), `muse-spark-1.3-contributor` (local dev) | `backend/spark.py` |
| Part outlines | `sam-3.1` | `backend/sam31.py` |
| Hearing beeps and clicks | `muse-wonder-1.0` + measured audio features | `backend/wonder.py`, `backend/audiofeat.py` |
| Illustrative highlight (fallback when SAM finds nothing) | `muse-image-1.0` | `backend/muse_image.py` |
| Speech | MMS-TTS (English and Hindi voices baked into the image) | `backend/tts_local.py` |
| Speech-to-text | browser speech recognition | `frontend/app/page.tsx` |
| Nearby pros | Google Places API (New); without a key, a Google Maps search link | `backend/places.py`, `frontend/app/components/CallAPro.tsx` |

## Deploy

Backend on [Modal](https://modal.com), frontend on Vercel. No tunnels, no
login, no database. The checklist is `MY_TODO.md`.

- **Backend:** `modal deploy backend/modal_app.py`. It builds the image
  from `backend/requirements.txt` (CPU-only torch, both MMS voices baked in
  at build time), serves the FastAPI app with `@modal.asgi_app`, and
  speaks one warm-up line before a container takes traffic. Sizing (cores,
  memory, warm containers, max containers, request timeout) is one block
  at the top of that file. Production always runs `muse-spark-1.3`:
  `modal_app.py` sets `SPARK_MODEL=prod` and `HANDYMAN_ENV=production`
  itself.
- **Secrets:** one Modal secret named `handyman` with
  `MUSE_SPARK_API_URL`, `MUSE_SPARK_API_KEY`, `PROXY_SECRET`,
  `ALLOWED_ORIGINS` and, optionally, `GOOGLE_PLACES_API_KEY`. The backend
  refuses to start, naming each missing key. Vercel holds `BACKEND_URL`
  and the same `PROXY_SECRET`. Every variable is documented in
  `backend/.env.example` and `frontend/.env.example`.
- **Frontend:** Vercel builds `frontend/` from the repo. The browser only
  talks to the Vercel domain; `frontend/middleware.ts` forwards `/api/*`
  to Modal with the proxy secret, and the backend rejects calls without it.
- **CI:** `.github/workflows/checks.yml` runs ruff, the backend tests and
  the frontend typecheck on pull requests and pushes. It deploys nothing.
- **Protecting the bill:** per-IP limits on fixes and requests, a cap on
  Places lookups per session and per IP, at most 3 Modal containers, and
  one JSON usage line per request in the Modal logs (`"kind": "usage"`).
- **History:** past jobs stay in the browser (localStorage for the facts,
  IndexedDB for small before/after thumbnails and the sound clip, last 20
  jobs). Nothing is stored on the server.
- **Unused:** `infra/setup.sh` (the earlier Google Cloud Run setup) is no
  longer used and is kept for reference only. `backend/Dockerfile` is for
  running the backend as a container locally: `make container` (uses your
  `.env`).

## Languages

- Voice: all 999 MMS-TTS checkpoints, downloaded lazily on first use
  (`/api/languages` lists them; the UI has an Auto-detect + picker).
- Narration: the model's own replies (English; Hindi and Hinglish voices
  are baked in).
- Honest gaps: some languages have no MMS voice at all (verified absent:
  Mandarin, Japanese, Italian, Norwegian) — those reply in English with
  the recognizer still set to your language. Symptom matching runs
  against a reverse translation so it works in any narrated language.
- First use of a new narration language downloads the NLLB model once
  (~2.5GB) and is slow; every later turn is instant.

### Widely-spoken language coverage

| Language | Voice | Narration |
|---|---|---|
| English, Hindi, Hinglish | local MMS | authored (no translation needed) |
| Spanish, German, French, Portuguese, Dutch, Catalan, Korean, Marathi, Bengali, Tamil, Telugu, Urdu, Arabic, Persian, Russian, Polish, Ukrainian, Vietnamese, Thai, Indonesian, Swahili, Gujarati, Punjabi, Hebrew, Greek, Romanian, Hungarian, Finnish, Swedish | local MMS | NLLB-translated, cached |
| Mandarin, Japanese, Italian, Norwegian, Turkish, Czech, Danish, Standard Malay | — (no MMS checkpoint exists) | replies simply in English |

<details>
<summary>All 107 translated-narration languages</summary>

- Achinese (`ace`)
- Akan (`aka`)
- Amharic (`amh`)
- Arabic (`ara`)
- Assamese (`asm`)
- Awadhi (`awa`)
- Central Aymara (`ayr`)
- South Azerbaijani (`azb`)
- North Azerbaijani (`azj-script_cyrillic`)
- North Azerbaijani (`azj-script_latin`)
- Bashkir (`bak`)
- Bambara (`bam`)
- Balinese (`ban`)
- Bemba (Zambia) (`bem`)
- Bengali (`ben`)
- Tibetan (`bod`)
- Bulgarian (`bul`)
- Catalan (`cat`)
- Welsh (`cym`)
- German (`deu`)
- Southwestern Dinka (`dik`)
- Dyula (`dyu`)
- Dzongkha (`dzo`)
- Modern Greek (1453-) (`ell`)
- English (`eng`)
- Basque (`eus`)
- Ewe (`ewe`)
- Faroese (`fao`)
- Persian (`fas`)
- Fijian (`fij`)
- Finnish (`fin`)
- Fon (`fon`)
- French (`fra`)
- Guarani (`grn`)
- Gujarati (`guj`)
- Haitian (`hat`)
- Hausa (`hau`)
- Hebrew (`heb`)
- Hindi (`hin`)
- Chhattisgarhi (`hne`)
- Hungarian (`hun`)
- Iloko (`ilo`)
- Indonesian (`ind`)
- Icelandic (`isl`)
- Javanese (`jav`)
- Kabyle (`kab`)
- Kachin (`kac`)
- Kannada (`kan`)
- Kazakh (`kaz`)
- Kabiyè (`kbp`)
- Khmer (`khm`)
- Kikuyu (`kik`)
- Kinyarwanda (`kin`)
- Kirghiz (`kir`)
- Northern Kurdish (`kmr-script_arabic`)
- Northern Kurdish (`kmr-script_cyrillic`)
- Northern Kurdish (`kmr-script_latin`)
- Korean (`kor`)
- Lao (`lao`)
- Ganda (`lug`)
- Maithili (`mai`)
- Malayalam (`mal`)
- Marathi (`mar`)
- Minangkabau (`min`)
- Dutch (`nld`)
- Nuer (`nus`)
- Chichewa (`nya`)
- Odia (`ory`)
- Pangasinan (`pag`)
- Panjabi (`pan`)
- Papiamento (`pap`)
- Polish (`pol`)
- Portuguese (`por`)
- Ayacucho Quechua (`quy`)
- Romanian (`ron`)
- Rundi (`run`)
- Russian (`rus`)
- Sango (`sag`)
- Shan (`shn`)
- Samoan (`smo`)
- Shona (`sna`)
- Somali (`som`)
- Spanish (`spa`)
- Sundanese (`sun`)
- Swedish (`swe`)
- Swahili (individual language) (`swh`)
- Tamil (`tam`)
- Tamasheq (`taq`)
- Tatar (`tat`)
- Telugu (`tel`)
- Tajik (`tgk`)
- Tagalog (`tgl`)
- Thai (`tha`)
- Tigrinya (`tir`)
- Tok Pisin (`tpi`)
- Tsonga (`tso`)
- Turkmen (`tuk-script_arabic`)
- Turkmen (`tuk-script_latin`)
- Uighur (`uig-script_arabic`)
- Uighur (`uig-script_cyrillic`)
- Ukrainian (`ukr`)
- Urdu (`urd-script_arabic`)
- Urdu (`urd-script_devanagari`)
- Urdu (`urd-script_latin`)
- Vietnamese (`vie`)
- Waray (Philippines) (`war`)
- Yoruba (`yor`)

</details>

## Run

One command does everything (setup + backend on :8000 + frontend on :3000):

```
make
```

Open http://127.0.0.1:3000 in a browser (camera/mic need localhost or
HTTPS). Ctrl-C stops both servers.

Useful extras:

```
make setup      # dependencies only (venv + pip + npm), idempotent
make backend    # FastAPI alone — HANDYMAN_MODAL=0 for local fallbacks
make frontend   # Next.js alone
make deploy     # deploy the backend to Modal (modal deploy backend/modal_app.py)
make auth       # authenticate this machine with Modal (opens browser)
make clean      # remove frontend build output
```

## Repair flow (real intelligence + highlights)

One flow: point the camera, Talk (or type) the issue, the system
captures a still itself and opens the repair overlay over the live
feed. `POST /api/repair/analyze` (+ `/api/repair/highlight` per step):
Muse Spark (`muse-spark-1.3-contributor`) identifies the appliance,
brand/model, and parts; a second call diagnoses causes, safety
warnings, and ordered check/how steps; Muse Image (`muse-image-1.0`)
highlights each step's part with an IKEA-style A/B/C legend while the
MMS voice talks you through it — one step at a time with Next/Back,
plus embedded tutorial videos, reference-picture links, and a closing
resolution check. Needs `MUSE_SPARK_API_URL` + `MUSE_SPARK_API_KEY` in
`.env` (see `backend/.env.example`). Hosted `sam-3.1` masks stay a hook point
until its dashboard request format lands.

## Flow (voice is the only trigger)

Tap Talk and speak — the system takes it from there: it captures a still
itself, detects your language (English, Hindi, Hinglish/code-mix), and
streams its thinking aloud while overlays land simultaneously — finding
the device, checking regional variants, searching the logo, marking
components, pinpointing the problem area. Each inference shows the spliced
image portion it came from. Then spoken repair steps with highlights.
Saying "next" (or अगला) advances a step. Tapping the still tags a part
the detector missed. The video stream is never recorded — only
system-captured stills.
