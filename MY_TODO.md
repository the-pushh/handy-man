# Deploy checklist

1. **Modal CLI**
   ```bash
   pip install modal
   modal token new
   ```

2. **Modal secret.** Modal dashboard → **Secrets** → **Create new secret** → **Custom**. Name it `handyman` and add these keys:

   | Key | Value |
   |---|---|
   | `MUSE_SPARK_API_URL` | the Meta gateway URL from your `.env` (`https://…`) |
   | `MUSE_SPARK_API_KEY` | your Meta Model API key |
   | `PROXY_SECRET` | output of `openssl rand -hex 32` (keep it for step 4) |
   | `ALLOWED_ORIGINS` | your Vercel URL, e.g. `https://handy-man.vercel.app` (no trailing slash) |
   | `GOOGLE_PLACES_API_KEY` | optional; without it "call a pro" shows a Find nearby (Google Maps) button |

   `SPARK_MODEL=prod` and `HANDYMAN_ENV=production` are set by `backend/modal_app.py`; don't add them.

3. **Deploy the backend.** From the repo root:
   ```bash
   modal deploy backend/modal_app.py
   ```
   Copy the URL it prints: `https://<workspace>--handyman-backend.modal.run`.

4. **Vercel.** https://vercel.com/new → import `the-pushh/handy-man` → **Root Directory** `frontend` → **Environment Variables**:
   - `BACKEND_URL` = the Modal URL from step 3 (no trailing slash)
   - `PROXY_SECRET` = the same value as in step 2 (tick **Sensitive**)

   → **Deploy**. If the Vercel URL differs from the `ALLOWED_ORIGINS` you entered, fix it in the Modal secret and re-run step 3.

5. **After judging ends**, stop the always-warm container:
   ```bash
   sed -i '' 's/^MIN_CONTAINERS = 1 /MIN_CONTAINERS = 0 /' backend/modal_app.py && modal deploy backend/modal_app.py
   ```
