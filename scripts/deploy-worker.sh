#!/bin/bash
set -e

echo "🚀 Starting worker deploy for andriivnabot..."

# --- Load environment variables ---
source ./scripts/local-env.sh

# --- Verify gcloud context ---
echo "✅ Current project: $(gcloud config get-value project)"
echo "✅ Authenticated account: $(gcloud auth list --filter=status:ACTIVE --format='value(account)')"

# --- Prepare Pub/Sub ---
echo "🪄 Ensuring Pub/Sub topic and subscription exist..."
gcloud pubsub topics create telegram-updates --quiet || true
gcloud pubsub subscriptions create telegram-updates-sub \
  --topic telegram-updates --quiet || true

# --- Define image digest (replace if you push new one) ---
IMAGE="europe-west1-docker.pkg.dev/andriivnabot/andriivnabot/andriivnabot@sha256:6dd256c72d764c35af331a917a91f6f4f71debdcab7f960a8cce34761296911a"

# --- Deploy worker ---
echo "🧠 Deploying worker service..."
gcloud run deploy andriivnabot-worker \
  --image "$IMAGE" \
  --region europe-west1 \
  --platform managed \
  --no-allow-unauthenticated \
  --cpu 1 --memory 512Mi --max-instances 5 \
  --command "node" \
  --args "dist/workers/telegram-updates/index.js" \
  --set-env-vars "NODE_ENV=production" \
  --set-env-vars "PUBSUB_DRIVER=${PUBSUB_DRIVER}" \
  --set-env-vars "GCP_PROJECT=${GCP_PROJECT}" \
  --set-env-vars "PUBSUB_TOPIC=telegram-updates" \
  --set-env-vars "PUBSUB_SUBSCRIPTION=telegram-updates-sub" \
  --set-env-vars "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}" \
  --set-env-vars "TELEGRAM_WEBHOOK_SECRET=${TELEGRAM_WEBHOOK_SECRET}" \
  --set-env-vars "DATABASE_URL=${DATABASE_URL}" \
  --set-env-vars "REDIS_URL=${REDIS_URL}" \
  --set-env-vars "REDIS_TOKEN=${REDIS_TOKEN}"

echo "✅ Deployment completed!"
echo ""
echo "📜 Fetching recent worker logs..."
gcloud logs read --region=europe-west1 --limit=50 \
  --format='value(textPayload)' \
  "resource.type=cloud_run_revision AND resource.labels.service_name=andriivnabot-worker" || true
