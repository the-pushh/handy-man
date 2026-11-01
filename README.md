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
- Backend: FastAPI in `backend/server.py`, a container on Cloud Run
  (asia-south1). Model calls go to Meta's hosted Model API; the safety
  rules are `backend/risk.py`; speech is local MMS-TTS.

| Role | Model | Where |
|---|---|---|
| Perception, diagnosis, decision, re-check | `muse-spark-1.3` (prod), `muse-spark-1.3-contributor` (local dev) | `backend/spark.py` |
| Part outlines | `sam-3.1` | `backend/sam31.py` |
| Hearing beeps and clicks | `muse-wonder-1.0` + measured audio features | `backend/wonder.py`, `backend/audiofeat.py` |
| Illustrative highlight (fallback when SAM finds nothing) | `muse-image-1.0` | `backend/muse_image.py` |
| Speech | MMS-TTS (English and Hindi voices baked into the image) | `backend/tts_local.py` |
| Speech-to-text | browser speech recognition | `frontend/app/page.tsx` |
| Nearby pros | Google Places API (New) | `backend/places.py` |

## Deploy

Backend on Google Cloud Run with CI/CD from GitHub Actions, frontend on
Vercel. No tunnels, no login, no database.

- **One-time setup:** follow `MY_TODO.md` in order. It runs
  `infra/setup.sh` (project, APIs, Artifact Registry, Secret Manager,
  Workload Identity Federation, budget alert) and walks through the
  Vercel and GitHub settings.
- **Every push to `main`:** `.github/workflows/backend.yml` runs the
  checks (ruff, `backend/test_*.py`, frontend typecheck), builds
  `backend/Dockerfile`, deploys a Cloud Run revision with no traffic,
  smoke-tests it (health + one tiny live Spark call), then moves traffic
  to it. Pull requests run the checks only. GCP auth is Workload Identity
  Federation; there are no service-account keys.
- **Configuration:** every variable is documented in
  `backend/.env.example` and `frontend/.env.example`. The backend refuses
  to start if a required one is missing. Secrets (Meta key, Places key,
  proxy secret) live in Secret Manager and Vercel only.
- **Protecting the bill:** per-IP limits on fixes and requests, a cap on
  Places lookups per session and per IP, at most 3 Cloud Run instances,
  a budget alert, and one JSON usage line per request in Cloud Logging
  (`jsonPayload.kind="usage"`).
- **History:** past jobs stay in the browser (localStorage for the facts,
  IndexedDB for small before/after thumbnails and the sound clip, last 20
  jobs). Nothing is stored on the server.

Run the production container locally: `make container` (uses your `.env`).

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
make deploy     # redeploy Glimmer + mms-tts to Modal after model changes
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
