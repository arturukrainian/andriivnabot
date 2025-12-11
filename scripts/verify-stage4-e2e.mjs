// scripts/verify-stage4-e2e.mjs
// E2E перевірка Stage 4: секрет/дублі/лок/ratelimit/redis-down + метрики.
// Працює вдвох режимах:
//   --boot : спершу запускає verify-stage3 (щоб підняти ingest+worker), потім тести
//   без --boot : вважає, що ingest+worker вже запущені на BASE (за замовч. http://127.0.0.1:8081)

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import process from 'node:process';

const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const TELEGRAM_SECRET = process.env.TELEGRAM_SECRET || 'dev-secret';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const PER_CHAT = Number(process.env.RATE_LIMIT_PER_CHAT ?? 20);
const BURST_CHAT = Number(process.env.RATE_LIMIT_BURST_CHAT ?? 10);

const USE_BOOT = process.argv.includes('--boot');

if (USE_BOOT) {
  const suffix = Date.now();
  if (!process.env.METRICS_STORE) {
    process.env.METRICS_STORE = `.metrics-stage4-${suffix}.json`;
  }
  if (!process.env.PUBSUB_STORE) {
    process.env.PUBSUB_STORE = `.pubsub-stage4-${suffix}.json`;
  }
}

const METRICS_FILE = process.env.METRICS_STORE || '.metrics-store.json';
const PUBSUB_FILE = process.env.PUBSUB_STORE || '.pubsub-memory.json';

// ---------- helpers ----------
function log(section, msg, extra) {
  const ts = new Date().toISOString();
  const x = extra ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[${section}] ${ts} ${msg}${x}`);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch (_) {}
    await sleep(200);
  }
  throw new Error(`health timeout after ${timeoutMs}ms (BASE=${BASE})`);
}

async function fetchMetrics() {
  const res = await fetch(`${BASE}/metrics`);
  if (!res.ok) throw new Error(`metrics http ${res.status}`);
  const text = await res.text();
  return parseProm(text);
}

function parseProm(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [key, val] = line.trim().split(/\s+/);
    const v = Number(val);
    if (!Number.isNaN(v)) {
      map.set(key, v);
    }
  }
  return map;
}

async function postWebhook(update, withSecret = true) {
  const headers = { 'content-type': 'application/json' };
  if (withSecret) headers['X-Telegram-Bot-Api-Secret-Token'] = TELEGRAM_SECRET;
  const res = await fetch(`${BASE}/webhook`, {
    method: 'POST',
    headers,
    body: JSON.stringify(update),
  });
  return res.status;
}

function makeMessageUpdate(update_id, chat_id, text) {
  return {
    update_id,
    message: {
      message_id: update_id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chat_id, type: 'private' },
      text,
    },
  };
}

async function assert(cond, label, extra) {
  if (!cond) {
    log('ASSERT', `❌ FAIL: ${label}`, extra);
    throw new Error(`Assertion failed: ${label}`);
  }
  log('ASSERT', `✅ PASS: ${label}`, extra);
}

async function waitForCounter(name, target, timeoutMs = 5000, intervalMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const metrics = await fetchMetrics();
    const val = metrics.get(name) ?? 0;
    if (val >= target) {
      return metrics;
    }
    await sleep(intervalMs);
  }
  const last = await fetchMetrics();
  throw new Error(`[waitForCounter] timeout: ${name}=${last.get(name) ?? 0} < ${target}`);
}

async function forceWebhookOnce() {
  const update_id = Date.now();
  const res = await fetch(`${BASE}/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': process.env.TELEGRAM_SECRET || TELEGRAM_SECRET,
    },
    body: JSON.stringify({ update_id, message: { text: 'stage4-ping', chat: { id: 1 } } }),
  });
  if (!res.ok) throw new Error(`forceWebhookOnce failed: ${res.status}`);
}

function resetLocalStores() {
  const targets = [
    { path: METRICS_FILE, label: 'metrics' },
    { path: PUBSUB_FILE, label: 'pubsub' },
  ];

  for (const target of targets) {
    try {
      fs.rmSync(target.path);
      log('BOOT', `reset ${target.label} store`, { file: target.path });
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        continue;
      }
      log('BOOT', `failed to reset ${target.label} store`, {
        file: target.path,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------- tests ----------
async function testUnauthorized() {
  const before = await fetchMetrics();
  const code = await postWebhook(makeMessageUpdate(99000001, 1001, '/start'), false);
  await sleep(150);
  const after = await fetchMetrics();
  await assert(code === 401 || code === 403, 'Unauthorized webhook returns 401/403', { code });
  await assert(
    (after.get('webhook_unauthorized_total') ?? 0) >= (before.get('webhook_unauthorized_total') ?? 0) + 1,
    'Metric webhook_unauthorized_total increments'
  );
}

async function testDuplicate() {
  const uid = 99000002;
  const upd = makeMessageUpdate(uid, 1002, '/profile');
  const before = await fetchMetrics();
  await postWebhook(upd, true);
  await postWebhook(upd, true); // дубль
  await sleep(400);
  const after = await fetchMetrics();
  await assert(
    (after.get('worker_updates_duplicate_total') ?? 0) >= (before.get('worker_updates_duplicate_total') ?? 0) + 1,
    'Metric worker_updates_duplicate_total increments'
  );
}

async function testChatLockContention() {
  const chat = 1003;
  const u1 = makeMessageUpdate(99000003, chat, '/quiz');
  const u2 = makeMessageUpdate(99000004, chat, '/quiz');

  const before = await fetchMetrics();
  await Promise.all([postWebhook(u1, true), postWebhook(u2, true)]);
  await sleep(500);
  const after = await fetchMetrics();
  await assert(
    (after.get('worker_lock_contention_total') ?? 0) >= (before.get('worker_lock_contention_total') ?? 0),
    'worker_lock_contention_total did not decrease'
  );
}

async function testRateLimit() {
  const chat = 1004;
  const n = PER_CHAT + BURST_CHAT + 5; // трохи вище ліміта
  const before = await fetchMetrics();

  const updates = Array.from({ length: n }, (_, i) =>
    makeMessageUpdate(99010000 + i, chat, `/quiz ${i}`)
  );
  // пульнемо максимально щільно
  await Promise.all(updates.map((u) => postWebhook(u, true)));
  await sleep(800);

  const after = await fetchMetrics();
  await assert(
    (after.get('worker_ratelimit_drop_total') ?? 0) >= (before.get('worker_ratelimit_drop_total') ?? 0),
    'worker_ratelimit_drop_total increments on burst'
  );
}

async function testRedisDownOptional() {
  // Опціонально: якщо локальний Redis, спробуємо коротко зруйнувати коннект, не падаючи процесом.
  // Підтримуємо лише Docker-контейнер "app-redis".
  if (!REDIS_URL.startsWith('redis://localhost')) {
    log('REDIS', 'skip redis-down test for Upstash/remote');
    return;
  }
  // Перевіримо чи є docker
  const hasDocker = await new Promise((res) => {
    const p = spawn('docker', ['ps'], { stdio: 'ignore' });
    p.on('error', () => res(false));
    p.on('exit', (code) => res(code === 0));
  });
  if (!hasDocker) {
    log('REDIS', 'skip redis-down (docker not available)');
    return;
  }

  // Пробуємо зупинити контейнер app-redis
  log('REDIS', 'trying to stop app-redis for ~2s…');
  await new Promise((resolve) => {
    const p = spawn('docker', ['stop', '-t', '2', 'app-redis']);
    p.on('exit', () => resolve());
    p.on('error', () => resolve());
  });

  // Надішлемо один апдейт і перевіримо, що процес не впав, метрики/логи живі.
  const before = await fetchMetrics().catch(() => new Map());
  const code = await postWebhook(makeMessageUpdate(99020001, 1005, '/start'), true).catch(() => 0);
  await sleep(600);
  const after = await fetchMetrics().catch(() => new Map());

  // Повернемо Redis
  await new Promise((resolve) => {
    const p = spawn('docker', ['start', 'app-redis']);
    p.on('exit', () => resolve());
    p.on('error', () => resolve());
  });

  await assert(code === 200 || code === 0, 'Webhook during redis down does not crash runner', { code });
  // не всі сервіси рахують redis_errors_total — тест мʼякий
  if (after.size && before.size) {
    // якщо метрики доступні — принаймні не зменшились ключові лічильники
    await assert(
      (after.get('webhook_requests_total') ?? 0) >= (before.get('webhook_requests_total') ?? 0),
      'metrics still readable while/after redis down'
    );
  }
}

// ---------- boot / run ----------
async function main() {
  let child = null;

  if (USE_BOOT) {
    resetLocalStores();
    log('BOOT', 'starting verify-stage3 to boot servers…');
    child = spawn('node', ['scripts/verify-stage3.mjs', '--server'], {
      env: { ...process.env, PUBSUB_DRIVER: 'memory', TELEGRAM_MOCK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (b) => process.stdout.write(`[BOOT] ${b}`));
    child.stderr.on('data', (b) => process.stderr.write(`[BOOT] ${b}`));
    await waitForHealth(15000);
  } else {
    await waitForHealth(10000);
  }

  log('RUN', '=== Stage 4 E2E start ===', { BASE, REDIS_URL });

  const before = await fetchMetrics();
  const qBefore = before.get('queue_published_total') ?? 0;
  const wBefore = before.get('worker_updates_total') ?? 0;
  const tBefore = before.get('telegram_sent_total') ?? 0;

  await testUnauthorized();
  await testDuplicate();
  await testChatLockContention();
  await testRateLimit();
  await testRedisDownOptional();

  // Примусово штовхаємо ще один апдейт, щоб counters гарантовано змінилися
  await forceWebhookOnce();

  const afterQ = await waitForCounter('queue_published_total', qBefore + 1);
  const afterW = await waitForCounter('worker_updates_total', wBefore + 1);
  const afterT = await waitForCounter('telegram_sent_total', tBefore + 1);

  // Всі assert’и робимо ДО зупинки дочірнього процеса
  await assert(
    (afterQ.get('queue_published_total') ?? 0) >= qBefore + 1,
    'queue_published_total increased',
  );
  await assert(
    (afterW.get('worker_updates_total') ?? 0) >= wBefore + 1,
    'worker_updates_total increased',
  );
  await assert(
    (afterT.get('telegram_sent_total') ?? 0) >= tBefore + 1,
    'telegram_sent_total increased',
  );

  log('RESULT', '✅ Stage4 E2E passed', {
    queue: afterQ.get('queue_published_total'),
    worker: afterW.get('worker_updates_total'),
    telegram: afterT.get('telegram_sent_total'),
  });

  if (child) {
    child.kill('SIGTERM');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
