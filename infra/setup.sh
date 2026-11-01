#!/usr/bin/env bash
# UNUSED: the backend now deploys to Modal (backend/modal_app.py, see
# the README). Kept for reference only; nothing runs this script.
#
# One-time Google Cloud setup for the Handyman backend.
#
# Run it yourself, once, from the repo root, after `gcloud auth login`:
#   PROJECT_ID=my-handyman BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX \
#   BUDGET_AMOUNT=1000INR ALERT_EMAIL=you@example.com bash infra/setup.sh
#
# Safe to re-run: every step checks whether it is already done.
# Secret values are typed at a hidden prompt (never echoed, never put on a
# command line, never written to disk or shell history).
#
# What it creates, all in asia-south1 (Mumbai):
#   - the project (if missing), linked to your billing account
#   - APIs: Cloud Run, Artifact Registry, Secret Manager, IAM, STS,
#     Places API (New), Billing Budgets, Monitoring
#   - Artifact Registry repo "handyman" (Docker), keeping the last 10 images
#   - service accounts:
#       handyman-runtime   what Cloud Run runs as: reads the 3 secrets only
#       handyman-deployer  what GitHub Actions acts as: push images, deploy,
#                          read the proxy secret for the smoke test
#   - Workload Identity Federation pool "github" + provider "github-oidc",
#     trusting only pushes to main of $GITHUB_REPO (no JSON keys anywhere)
#   - secrets: handyman-meta-api-key, handyman-places-api-key,
#     handyman-proxy-secret (generated here, 64 hex chars)
#   - a budget with email alerts at 50%, 90% and 100%
#
# At the end it prints the GitHub repository variables to set.

set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID, e.g. PROJECT_ID=handyman-demo-123}"
: "${BILLING_ACCOUNT:?set BILLING_ACCOUNT (gcloud billing accounts list)}"
: "${BUDGET_AMOUNT:?set BUDGET_AMOUNT with your billing currency, e.g. 1000INR or 15USD}"
: "${ALERT_EMAIL:?set ALERT_EMAIL for budget alerts}"
REGION="${REGION:-asia-south1}"
GITHUB_REPO="${GITHUB_REPO:-the-pushh/handy-man}"
REPO=handyman
RUN_SA_NAME=handyman-runtime
DEPLOY_SA_NAME=handyman-deployer
POOL=github
PROVIDER=github-oidc

say() { printf '\n==> %s\n' "$*"; }

say "Project $PROJECT_ID"
if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud projects create "$PROJECT_ID" --name="Handyman"
fi
gcloud config set project "$PROJECT_ID" >/dev/null
gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT" >/dev/null
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

say "Enabling APIs (takes a minute the first time)"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com \
  places.googleapis.com \
  billingbudgets.googleapis.com \
  monitoring.googleapis.com \
  logging.googleapis.com

say "Artifact Registry repo $REPO ($REGION)"
if ! gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPO" --repository-format=docker \
    --location="$REGION" --description="Handyman backend images"
fi
# Keep storage small: only the 10 newest images.
cat > /tmp/handyman-cleanup.json <<'JSON'
[{"name": "keep-10", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 10}},
 {"name": "delete-rest", "action": {"type": "Delete"}, "condition": {"tagState": "ANY"}}]
JSON
gcloud artifacts repositories set-cleanup-policies "$REPO" --location="$REGION" \
  --policy=/tmp/handyman-cleanup.json --no-dry-run >/dev/null
rm -f /tmp/handyman-cleanup.json

say "Service accounts"
for sa in "$RUN_SA_NAME" "$DEPLOY_SA_NAME"; do
  if ! gcloud iam service-accounts describe "$sa@$PROJECT_ID.iam.gserviceaccount.com" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$sa" --display-name="$sa"
  fi
done
RUN_SA="$RUN_SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
DEPLOY_SA="$DEPLOY_SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"

say "Secrets (values are typed at a hidden prompt)"
put_secret() { # name, prompt, [optional]
  local name="$1" prompt="$2" optional="${3:-}" value
  if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
    gcloud secrets create "$name" --replication-policy=automatic >/dev/null
  fi
  if gcloud secrets versions list "$name" --filter="state=ENABLED" --limit=1 \
       --format='value(name)' | grep -q .; then
    echo "$name already has a value (to replace it: gcloud secrets versions add $name --data-file=-)"
    return
  fi
  read -rsp "$prompt: " value; echo
  if [ -z "$value" ]; then
    [ -n "$optional" ] && { echo "skipped $name"; return; }
    echo "empty value, aborting"; exit 1
  fi
  printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
}
put_secret handyman-meta-api-key "Meta Model API key (MUSE_SPARK_API_KEY)"
put_secret handyman-places-api-key "Google Places API key (Enter to skip)" optional
if ! gcloud secrets describe handyman-proxy-secret >/dev/null 2>&1; then
  gcloud secrets create handyman-proxy-secret --replication-policy=automatic >/dev/null
fi
if ! gcloud secrets versions list handyman-proxy-secret --filter="state=ENABLED" \
     --limit=1 --format='value(name)' | grep -q .; then
  openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add handyman-proxy-secret --data-file=- >/dev/null
  echo "handyman-proxy-secret generated (Vercel needs the same value)"
fi

say "Secret access"
for s in handyman-meta-api-key handyman-places-api-key handyman-proxy-secret; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$RUN_SA" \
    --role=roles/secretmanager.secretAccessor >/dev/null
done
# The deploy job reads the proxy secret for the smoke test, nothing else.
gcloud secrets add-iam-policy-binding handyman-proxy-secret \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/secretmanager.secretAccessor >/dev/null

say "Deployer roles"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/run.admin --condition=None >/dev/null
gcloud artifacts repositories add-iam-policy-binding "$REPO" --location="$REGION" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/artifactregistry.writer >/dev/null
# Deploying a service that runs as handyman-runtime requires actAs on it.
gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser >/dev/null

say "Workload Identity Federation for $GITHUB_REPO (main branch only)"
if ! gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL" --location=global \
    --display-name="GitHub Actions"
fi
if ! gcloud iam workload-identity-pools providers describe "$PROVIDER" \
     --workload-identity-pool="$POOL" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --workload-identity-pool="$POOL" --location=global \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository=='$GITHUB_REPO' && assertion.ref=='refs/heads/main'"
fi
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$GITHUB_REPO" \
  >/dev/null
WIF_PROVIDER="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"

say "Budget alert ($BUDGET_AMOUNT, emails to $ALERT_EMAIL)"
CHANNEL=$(gcloud beta monitoring channels list --filter="labels.email_address=$ALERT_EMAIL" \
  --format='value(name)' --limit=1 2>/dev/null || true)
if [ -z "$CHANNEL" ]; then
  CHANNEL=$(gcloud beta monitoring channels create --display-name="Handyman budget" \
    --type=email --channel-labels="email_address=$ALERT_EMAIL" --format='value(name)')
fi
if ! gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" \
     --format='value(displayName)' | grep -qx "Handyman"; then
  gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" \
    --display-name="Handyman" --budget-amount="$BUDGET_AMOUNT" \
    --filter-projects="projects/$PROJECT_ID" \
    --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 \
    --notifications-rule-monitoring-notification-channels="$CHANNEL"
fi

say "Done. Set these GitHub repository variables:"
cat <<EOF
gh variable set GCP_PROJECT_ID   --body "$PROJECT_ID"
gh variable set GCP_WIF_PROVIDER --body "$WIF_PROVIDER"
gh variable set GCP_DEPLOY_SA    --body "$DEPLOY_SA"
gh variable set GCP_RUN_SA       --body "$RUN_SA"
EOF
