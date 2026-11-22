#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

PROJECT_ID="${1:-${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}}"
REGION="${2:-${REGION:-us-central1}}"
SERVICE_NAME="${SERVICE_NAME:-apac-ai-expert-kahoot}"

if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "Usage: ./deploy.sh <GCP_PROJECT_ID> [REGION]"
  exit 1
fi

GCS_BUCKET_NAME="${GCS_BUCKET:-${PROJECT_ID}-quizarena-data}"
SUPERADMIN_EMAIL_VAL="${SUPERADMIN_EMAIL:-$(gcloud config get-value account 2>/dev/null || echo admin@example.com)}"

ACCOUNT_ARGS=()
if [[ -n "${DEPLOY_ACCOUNT:-}" ]]; then
  ACCOUNT_ARGS=(--account "$DEPLOY_ACCOUNT")
fi

ENV_VARS="GCS_BUCKET=${GCS_BUCKET_NAME},GOOGLE_CLOUD_PROJECT=${PROJECT_ID},SUPERADMIN_EMAIL=${SUPERADMIN_EMAIL_VAL}"
if [[ -n "${ADMIN_PASSWORD:-}" ]]; then
  ENV_VARS="${ENV_VARS},ADMIN_PASSWORD=${ADMIN_PASSWORD}"
fi

echo "Deploying $SERVICE_NAME to Cloud Run ($PROJECT_ID / $REGION) with GCS_BUCKET=$GCS_BUCKET_NAME..."
# Single instance with concurrency=250 + session-affinity keeps all 100+ WebSocket players in one shared room,
# while GCS_BUCKET persists creator accounts, custom quizzes, and session reports across Cloud Run revisions.
gcloud run deploy "$SERVICE_NAME" \
  "${ACCOUNT_ARGS[@]}" \
  --source . \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 1 \
  --concurrency 250 \
  --cpu 2 \
  --memory 1Gi \
  --timeout 3600 \
  --session-affinity \
  --set-env-vars "$ENV_VARS"
