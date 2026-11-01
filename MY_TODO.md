# Deploying Handyman: your checklist

Everything below needs your accounts, consoles or secrets, so it's yours
to do. Do the steps in order. The code side (container, CI/CD, proxy,
limits, history) is already committed.

What you end up with:

- **Backend:** Cloud Run in asia-south1, deployed by GitHub Actions on every push to `main`.
- **Frontend:** Vercel. The browser only talks to the Vercel domain, which proxies `/api/*` to Cloud Run.
- **Secrets:** in Google Secret Manager and Vercel's encrypted env vars only. Never in the repo, never in build logs.

---

## 1. Install the tools (once)

```bash
brew install --cask google-cloud-sdk   # gcloud
gcloud components install beta         # setup.sh uses the beta monitoring commands
brew install gh gitleaks               # gh is already installed if `gh --version` works
gh auth login                          # GitHub CLI, for setting repo variables
```

## 2. Sign in to Google Cloud and find your billing account

```bash
gcloud auth login
gcloud billing accounts list           # copy the ACCOUNT_ID (XXXXXX-XXXXXX-XXXXXX)
```

No billing account? Console → **Billing** → **Create account**. Cloud Run, Secret Manager and Places all need billing enabled, even within the free tiers.

## 3. Run the one-time GCP setup

Pick a globally unique project id, e.g. `handyman-demo-1101`. The budget amount must be in your billing account's currency.

```bash
cd ~/Developer/handy-man
PROJECT_ID=handyman-demo-1101 \
BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX \
BUDGET_AMOUNT=1000INR \
ALERT_EMAIL=you@example.com \
bash infra/setup.sh
```

The script asks for two values at a hidden prompt:

- **Meta Model API key:** paste it.
- **Google Places API key:** press **Enter** to skip; you create it in step 4.

It ends by printing four `gh variable set ...` lines. **Keep them for step 6.**

Re-running the script is safe: every step checks whether it's already done. To see everything it creates, read the header of `infra/setup.sh`.

## 4. Create the Places API key and store it

The Places API (New) was enabled by step 3. In the Google Cloud console:

1. Top bar → select project **handyman-demo-1101**.
2. ☰ → **APIs & Services** → **Credentials**.
3. **+ Create credentials** → **API key**. Copy the key (starts with `AIza`).
4. Click the new key's name to edit it:
   - **Name:** `handyman-places`.
   - **Application restrictions:** **None**. It's only used server-side, from Cloud Run.
   - **API restrictions** → **Restrict key** → tick **Places API (New)** only → **OK** → **Save**.

Then store it. This reads the key from a hidden prompt, so it stays out of your shell history:

```bash
read -rsp "Places key: " K && printf %s "$K" | gcloud secrets versions add handyman-places-api-key --data-file=- && unset K
```

Do this before step 7: the first deploy needs a value in this secret.

## 5. Create the Vercel project (frontend)

1. Go to https://vercel.com/new → **Import Git Repository** → pick **the-pushh/handy-man**.
   - If it isn't listed: **Adjust GitHub App Permissions** → give Vercel access to the repo.
2. **Root Directory:** **Edit** → select `frontend` → **Continue**.
3. **Framework Preset:** Next.js (auto-detected). Leave the build settings as they are.
4. Don't add env vars yet → **Deploy**. It builds, but it can't diagnose anything until step 8.
5. Note the production domain: Project → **Settings** → **Domains**, e.g. `handy-man-xyz.vercel.app`.

## 6. Set the GitHub repository variables

These are not secrets: there are no keys among them. Paste the four lines step 3 printed, then add the two below. Use the same gateway URL as your local `.env`, and your Vercel domain from step 5 (with `https://`, no trailing slash).

```bash
cd ~/Developer/handy-man
gh variable set GCP_PROJECT_ID   --body "handyman-demo-1101"
gh variable set GCP_WIF_PROVIDER --body "projects/123.../providers/github-oidc"
gh variable set GCP_DEPLOY_SA    --body "handyman-deployer@handyman-demo-1101.iam.gserviceaccount.com"
gh variable set GCP_RUN_SA       --body "handyman-runtime@handyman-demo-1101.iam.gserviceaccount.com"
gh variable set MUSE_SPARK_API_URL --body "https://api.meta.ai/v1"
gh variable set ALLOWED_ORIGINS    --body "https://handy-man-xyz.vercel.app"
gh variable list                  # check all six are there
```

## 7. Push, and let GitHub Actions deploy the backend

I ran gitleaks over the full history and the working tree before handing over (0 findings). Run it once more yourself if you've changed anything, then push:

```bash
bash infra/scan-secrets.sh        # full history + the files git would commit; must end with "== clean"
git push origin main
gh run watch                      # follows the "backend" workflow
```

The workflow:

1. Runs the checks: ruff, the 4 test files, frontend typecheck.
2. Builds the image and pushes it to Artifact Registry.
3. Deploys to Cloud Run.
4. Smoke-tests: the `/api/health` endpoint, plus one tiny live `muse-spark-1.3` call.
5. Only then moves traffic to the new revision.

The first build takes ~8–12 min (torch and the voices); later ones are faster.

When it's green, open the run's **Summary**. It shows the backend URL, e.g. `https://handyman-backend-abc123-el.a.run.app`. You can also get it with:

```bash
gcloud run services describe handyman-backend --region asia-south1 --format='value(status.url)'
```

## 8. Connect Vercel to the backend

Get the proxy secret that step 3 generated:

```bash
gcloud secrets versions access latest --secret=handyman-proxy-secret; echo
```

In Vercel: Project → **Settings** → **Environment Variables**. Add both for the **Production** environment:

| Key | Value | Options |
|---|---|---|
| `BACKEND_URL` | the Cloud Run URL from step 7 (no trailing slash) | — |
| `PROXY_SECRET` | the 64-character value printed above | tick **Sensitive** |

Then **Deployments** → the latest production deployment → **⋯** → **Redeploy**. Vercel applies env var changes only to new deployments, so this redeploy is required.

## 9. Test on your phone (mobile data, not Wi-Fi)

Open `https://<your-vercel-domain>` and allow the camera and microphone when asked. Then check:

- [ ] **AC case:** confirm card → one question → "You can fix this" → steps → "Done, check it" → re-check passes.
- [ ] **Scooter case:** verdict "Call a pro", with the rule named; "Find a two-wheeler mechanic" lists nearby pros.
- [ ] **Inverter case:** listens to the beep → two questions → top-up or technician.
- [ ] **Trace drawer:** pull it up; the calls show `muse-spark-1.3`, `sam-3.1`, `muse-wonder-1.0`.
- [ ] **History:** reload the page → **History** (top right) → the jobs are there and each one reopens.

If something fails, the logs are here:

```bash
gcloud run services logs read handyman-backend --region asia-south1 --limit 100
```

To see what a turn costs in model usage, filter the logs to the per-request usage lines:

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND jsonPayload.kind="usage"' --limit 50 --format json
```

## 10. Check the bill guard

1. Console → **Billing** → **Budgets & alerts**: a budget named **Handyman** exists, with alerts at 50/90/100%.
   - Alerts only email you; they don't stop spending. The hard limits are max 3 instances and the per-IP limits.
2. The Cloud Run service keeps **1 warm instance** (2 vCPU / 4 GiB), so the first spoken line is instant. That idle instance is billed around the clock at Cloud Run's idle rate.
   - After the hackathon, scale it to zero: `gcloud run services update handyman-backend --region asia-south1 --min-instances 0`. Speech will then be slow on a cold start.

## 11. Put the live URL in the README

Replace `https://<your-vercel-domain>` in the README's **Deploy** section, and commit.

---

### If you ever need to rotate a secret

Store the new value at a hidden prompt (it stays out of your shell history):

```bash
read -rsp "new value: " V && printf %s "$V" | gcloud secrets versions add handyman-meta-api-key --data-file=- && unset V
```

Then roll a new revision to pick it up:

```bash
gcloud run services update handyman-backend --region asia-south1 --update-labels rotated=$(date +%s)
```

For the proxy secret, update Vercel's `PROXY_SECRET` and redeploy Vercel at the same time.
