# Telegram Updates Worker

## Потік події
`Pub/Sub (telegram_updates)` → Worker → обробка команд/квізів → Telegram API (або mock) → PostHog (якщо увімкнено).

## ENV
| Key | Description | Default |
| --- | --- | --- |
| `PUBSUB_DRIVER` | `memory` \| `gcp` | `memory` |
| `PUBSUB_TOPIC` | Топік з оновленнями | `telegram_updates` |
| `WORKER_POLL_INTERVAL_MS` | Інтервал полінгу memory-драйвера | `50` |
| `WORKER_CONCURRENCY` | Макс. одночасних обробок | `5` |
| `BOT_TOKEN` | Telegram бот токен | — |
| `TELEGRAM_API` | Базовий URL Telegram | `https://api.telegram.org` |
| `TELEGRAM_MOCK` | `1` → не викликати API, лише лог/outbox | `0` |
| `ANALYTICS_ENABLED` | `1` → надсилати івенти у PostHog | `0` |
| `POSTHOG_API_KEY` | Ключ PostHog | — |
| `POSTHOG_HOST` | Хост PostHog | `https://us.i.posthog.com` |
| `ANALYTICS_DEBUG` | `1` → логувати кожну подію | `0` |

## Команди/сценарії
- `/start` → вітання + підказки.
- `/profile` → показ рівня/XP (in-memory профіль).
- `/quiz` → відправка питання з inline-кнопками (`callback_data: quiz:<qid>:<choice>`).
- `/video` → лінк на відео (плейсхолдер).
- Інше → повідомлення про невідому команду.
- `callback_query quiz::*` → перевірка відповіді, +10 XP за правильну (level up при 100 XP).

## Метрики
- `worker_updates_received_total`, `worker_errors_total`, `worker_handle_duration_ms_p95`
- `telegram_sent_total`
- (із ingest) `queue_published_total`, `webhook_*`

## Логи
- info: отримано update_id, тип події, успішно надіслано відповідь.
- warn: невалідний payload.
- error: помилки обробки/відправки.

## Запуск локально (memory + mock)
```bash
TELEGRAM_MOCK=1 PUBSUB_DRIVER=memory npm run build
node dist/workers/telegram-updates/index.js
```
Публікацію тестового update можна зробити із ingress або вручну через memory driver (додайте publish у REPL).

## Обмеження / TODO
- Redis idempotency та зовнішня черга.
- Retry/backoff для Telegram 429/5xx.
- Реальна Prisma-інтеграція замість in-memory репозиторіїв.
