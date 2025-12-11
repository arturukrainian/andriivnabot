🧭 /docs/DEVELOPMENT_PLAN.md

# 🧭 Development Plan — Phase 1 (Core MVP)

## 🎯 Ціль

Запустити мінімально-життєздатного Telegram-бота, який:

- реєструє користувачів;
- показує профіль і прогрес;
- проводить квіз-ігри;
- надсилає YouTube-відео;
- пише аналітику в PostHog.

---

## 🧱 Етапи

### **Етап 1 — Ініціалізація**

- [ ] Створити структуру репозиторію (`src/`, `prisma/`, `docs/`).
- [ ] Налаштувати `package.json`, `tsconfig.json`.
- [ ] Ініціалізувати Prisma + схему БД.
- [ ] Підключити Postgres (Neon або локально).
- [ ] Створити `.env` (BOT_TOKEN, DB_URL, REDIS_URL, POSTHOG_API_KEY, GCP_PROJECT).

### **Етап 2 — Webhook Ingest**

- [ ] Fastify сервер `/webhook`.
- [ ] Перевірка секрету.
- [ ] Публікація події в Pub/Sub.
- [ ] Відповідь `200 OK` ≤ 150 мс.

### **Етап 3 — Worker (telegram_updates_worker)**

- [ ] Підписатися на Pub/Sub.
- [ ] Обробляти `message`, `callback_query`.
- [ ] Реалізувати `/start`, `/profile`, `/quiz`, `/video`.
- [ ] Надсилати відповіді через Telegram API.
- [ ] Оновлювати профіль у БД.

### **Етап 4 — Redis**

- [ ] Кеш користувачів.
- [ ] Локи на `chat_id`.
- [ ] Rate-limiter для відправки повідомлень.

### **Етап 5 — Аналітика**

- [x] Підключити PostHog SDK.
- [x] Надсилати події `lesson_start`, `quiz_answer`.
- [x] Створити дашборд у PostHog.

### **Етап 6 — Адмінка**

- [x] Оновити Prisma схему (User, Lesson, UserProgress) + міграції/seed.
- [x] Увімкнути Prisma-репозиторії (feature-flag) для user/profile сервісів.
- [x] Реалізувати Admin Fastify plugin (`/admin/*`, auth по `ADMIN_TOKEN`) з CRUD Lesson/User/Progress.
- [x] Додати лічильники `admin_requests_total`, `admin_errors_total`, `admin_auth_failures_total` у `/metrics`.
- [x] Документація + скрипти `stage6:db`, verify (curl/Retool) — `verify:stage6 -- --boot` стабільно проходить.

**Як перевірити Stage 6 локально**

1. DB: `docker run -d --name andrii-pg -e POSTGRES_PASSWORD=pass -p 5433:5432 postgres:16`
2. `DATABASE_URL="postgresql://postgres:pass@127.0.0.1:5433/postgres" npm run stage6:db`
3. Verify: `PORT=8526 BASE=http://127.0.0.1:8526 ADMIN_TOKEN=dev-admin-token DATABASE_URL="postgresql://postgres:pass@127.0.0.1:5433/postgres" npm run verify:stage6 -- --boot`
4. Очікування: `✅ Stage6 passed`; `/metrics` → `admin_requests_total ≥ 4`, `admin_errors_total = 0`, `admin_auth_failures_total ≥ 1`.
5. Feature-flag:
   - Prisma: `DB_MODE=prisma DATABASE_URL=... DEBUG=prisma:* npm run verify:stage4 -- --boot` → видно `prisma:query`.
   - Memory: `DB_MODE=memory DEBUG=prisma:* npm run verify:stage4 -- --boot | grep "prisma:query" || echo "OK: no prisma queries"`.
6. curl:
   - 401: `curl -i http://127.0.0.1:8526/admin/lessons`
   - Create: `curl -s -H "x-admin-token: dev-admin-token" -H "content-type: application/json" -d '{"slug":"demo-a1","title":"Demo A1","level":1,"isPublished":false}' http://127.0.0.1:8526/admin/lessons`
   - Metrics: `curl -s http://127.0.0.1:8526/metrics`

**Retool / HTTP чек**

- Base URL: `http://<host>:8526`
- Auth header: `X-Admin-Token: dev-admin-token`
- Endpoints: `GET /admin/lessons?q=demo`, `POST /admin/lessons`, `PATCH /admin/lessons/:id`, `DELETE /admin/lessons/:id`, `GET /metrics`

### **Етап 7 — CI/CD**

- [ ] GitHub Actions: build → deploy на Cloud Run.
- [ ] Тест вебхука на доступність.
- [ ] Моніторинг логів.

**CI/CD pipeline**

- Secrets: `GCP_PROJECT_ID`, `GCP_SA_KEY` (JSON), `CLOUD_RUN_SERVICE`, `CLOUD_RUN_REGION`, `WEBHOOK_BASE_URL` (опц.).  
- Workflow: `.github/workflows/deploy-cloud-run.yml` ― lint + build → Docker → push `gcr.io/$PROJECT_ID/...` → `gcloud run deploy`.  
- Smoke-test: `WEBHOOK_BASE_URL/health` після деплою (нульовий `admin_errors_total` очікується).  
- Cloud Run env: перед деплоєм налаштувати `BOT_TOKEN`, `DATABASE_URL`, `REDIS_URL`, `ADMIN_TOKEN`, `POSTHOG_*`, тощо через `gcloud run services update`.

**Моніторинг логів**

- Tail: `gcloud run services logs tail $SERVICE --project $PROJECT_ID --region $REGION`.  
- Запит (90 днів): `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="$SERVICE"' --limit=100`.

---

## 🔁 Після MVP

- [ ] Stripe інтеграція.
- [ ] Lesson scheduler.
- [ ] Notifications worker.
- [ ] Unit + e2e тести.

---

## 🧠 Принципи

- Відповідь вебхука ≤ 150 мс (ack-fast).
- Idempotency по `update_id`.
- Stateless сервіси.
- Безпека (Telegram secret, IP allow-list).
- Метрики + логи на кожному кроці.
