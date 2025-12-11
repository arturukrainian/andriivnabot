🧭 /docs/ARCHITECTURE.md

# ⚙️ System Architecture

## 🔧 Основні компоненти

### 1. Ingest (Webhook)

- Приймає `update` від Telegram.
- Перевіряє секрет у `X-Telegram-Bot-Api-Secret-Token`.
- Валідує payload.
- Відповідає `200 OK` ≤ 150 мс.
- Надсилає подію в `Pub/Sub` (топік `telegram_updates`).

### 2. Pub/Sub

- Буфер між Telegram і воркерами.
- Гарантовано не губить події.
- Тригерить воркер `telegram_updates_worker`.

### 3. Workers

- Обробляють логіку бота (команди, ігри, профілі).
- Пишуть дані в Postgres і Redis.
- Відправляють повідомлення в Telegram API.
- Надсилають події в PostHog (аналітика).

### 4. Бази даних

- **Postgres:** Prisma-схема включає `User` (telegramId, username, level, xp), `Lesson` (slug, контент, публікація) і `UserProgress` (зв’язок user↔lesson, статус, score). Seed створює базові уроки `a1-*`.
- **Redis:** кеш, сесії, rate-limit, локи.

### 5. Edge / CDN

- **Cloudflare:** TLS, WAF, кеш, гео-розподіл.

### 6. Аналітика та адмінка

- **PostHog:** події `lesson_start`, `quiz_answer`, `purchase_success`.
- **Admin API:** Fastify plugin (`/admin/*`, guard по `X-Admin-Token`) дозволяє CRUD `Lesson`, пошук користувачів та керування `UserProgress`. Метрики `admin_requests_total` / `admin_errors_total` експортуються у `/metrics`.

---

## 🧱 Технологічний стек

| Категорія    | Інструмент           |
| ------------ | -------------------- |
| Мова         | Node.js + TypeScript |
| Telegram SDK | grammY               |
| Сервер       | Fastify              |
| ORM          | Prisma               |
| Черга        | GCP Pub/Sub          |
| БД           | Postgres             |
| Кеш          | Redis (Upstash)      |
| Аналітика    | PostHog              |
| Edge / WAF   | Cloudflare           |
| Хостинг      | GCP Cloud Run        |

---

## 🔄 Потік події

1. Telegram → Cloudflare (TLS, WAF)
2. → Cloud Run "Ingest" (валідація, enqueue)
3. → Pub/Sub → Worker
4. → Логіка (БД, Redis)
5. → Telegram API (`sendMessage`)
6. → PostHog (аналітика)

---

## 🧩 Майбутні модулі

- Payments (Stripe / Telegram)
- Admin dashboard
- Notifications worker
- Lesson scheduler
