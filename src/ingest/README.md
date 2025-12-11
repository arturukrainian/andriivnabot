# Ingest Service (/webhook → Pub/Sub)

## Що робить
- Приймає Telegram updates на `POST /webhook`.
- Перевіряє секретний заголовок `X-Telegram-Bot-Api-Secret-Token`.
- Валідую payload через Zod (`update_id: number`, решта пропускається).
- Відповідає одразу (ack-fast, latency_ms у відповіді), кладучи подію в чергу (memory або GCP Pub/Sub).
- Додає технічні ендпоїнти: `/health`, `/metrics`.

## Ендпоїнти
- `GET /health` → `{ status: 'ok', ts }`
- `GET /metrics` (text/plain):
  - `queue_published_total`, `webhook_requests_total`, `webhook_unauthorized_total`, `webhook_latency_ms_p95`, `memory_pubsub_published_total`
- `POST /webhook`
  - Headers: `Content-Type: application/json`, `X-Telegram-Bot-Api-Secret-Token: <TELEGRAM_SECRET>`
  - Body (мінімум): `{"update_id": 123}`
  - 401 — якщо секрет не співпадає; 400 — невалідний payload; 200 — `{ ok: true, latency_ms, dedup? }`

Приклади curl:
```bash
curl -i -X POST http://localhost:8080/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: wrong' \
  -d '{"update_id":1}'

curl -i -X POST http://localhost:8080/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: supersecret' \
  -d '{"update_id":2,"message":{"chat":{"id":1},"text":"hi"}}'
```

## ENV
| Key | Description | Default |
| --- | --- | --- |
| `PORT` | Порт Fastify | `8080` |
| `TELEGRAM_SECRET` | Значення заголовка `X-Telegram-Bot-Api-Secret-Token` | — |
| `PUBSUB_DRIVER` | `memory` \| `gcp` | `memory` |
| `PUBSUB_TOPIC` | Топік публікації | `telegram_updates` |
| `GCP_PROJECT` | GCP projectId (для gcp) | — |
| `PUBSUB_EMULATOR_HOST` | Опц. для емулювальника | — |
| `DATABASE_URL`, `BOT_TOKEN`, `REDIS_URL` | інші сервіси | — |
| `ANALYTICS_ENABLED`, `POSTHOG_API_KEY`, `POSTHOG_HOST`, `ANALYTICS_DEBUG` | PostHog аналітика | `0`, ``, `https://us.i.posthog.com`, `0` |

## Черга (pubsub driver)
- `memory` (за замовчуванням): лічильник публікацій для метрик/локальних тестів.
- `gcp`: використовує `@google-cloud/pubsub` з атрибутами `update_id`, `source=webhook`.

## Ідемпотентність
- Простий in-memory TTL (5 хв) по `update_id`.  
- TODO: замінити на Redis lock для multi-instance.

## Метрики
- `queue_published_total` — успішні публікації.
- `webhook_requests_total` — усі запити.
- `webhook_unauthorized_total` — відхилені за секретом.
- `webhook_latency_ms_p95` — p95 latency останніх запитів.
- `memory_pubsub_published_total` — лічильник memory-драйвера.

## Запуск локально
```bash
npm run build && node dist/ingest/server.js
# або
npm run dev
```

## Обмеження / майбутні покращення
- Redis-based idempotency та rate-limit секрету.
- Retry/backoff для публікації в чергу.
- Розширити метрики (status codes, publish failures).
