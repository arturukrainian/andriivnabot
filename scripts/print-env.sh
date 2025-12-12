#!/usr/bin/env bash

mask() {
  if [ -n "$1" ]; then
    echo "${1:0:4}****${1: -4}"
  else
    echo ""
  fi
}

echo "GCP_PROJECT=$GCP_PROJECT"
echo "BASE_URL=$BASE_URL"
echo "PUBSUB_DRIVER=$PUBSUB_DRIVER"
echo "TELEGRAM_WEBHOOK_SECRET=$(mask "$TELEGRAM_WEBHOOK_SECRET")"
echo "TELEGRAM_BOT_TOKEN=$(mask "$TELEGRAM_BOT_TOKEN")"
echo "DATABASE_URL=$(mask "$DATABASE_URL")"
echo "REDIS_URL=$REDIS_URL"
echo "REDIS_TOKEN=$(mask "$REDIS_TOKEN")"
