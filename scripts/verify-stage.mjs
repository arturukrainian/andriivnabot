// scripts/verify-stage.mjs
// Комплексна перевірка Stage 3:
// ingest (webhook) → queue (memory) → worker (telegram_updates) → telegram_mock → /metrics

import { spawn } from 'node:child_process';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8081);
const BASE = `http://${HOST}:${PORT}`;
const TELEGRAM_SECRET = process.env.TELEGRAM_SECRET || 'testsecret';

const ok = (m) => console.log(`✅ ${m}`);
const warn = (m) => console.log(`⚠️  ${m}`);
const fail = (m) => console.log(`❌ ${m}`);

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function startProcess(label, args, extraEnv = {}) {
  const proc = spawn(process.execPath, args, {
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (d) => {
    const s = d.toString();
    console.log(`[${label}] ${s.trimEnd()}`);
  });

  proc.stderr.on('data', (d) => {
    const s = d.toString();
    console.error(`[${label} ERROR] ${s.trimEnd()}`);
  });

  proc.on('exit', (code) => {
    console.log(`[${label}] exited with code ${code}`);
  });

  return proc;
}

async function waitForHealth(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) {
        ok('/health is OK');
        return true;
      }
    } catch {
      // ignore
    }
    await sleep(300);
  }
  return false;
}

async function sendWebhookStart() {
  const payload = {
    update_id: Date.now() % 1_000_000,
    message: {
      chat: { id: 1 },
      text: '/start',
    },
  };

  try {
    const res = await fetch(`${BASE}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': TELEGRAM_SECRET,
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }

    console.log('Webhook HTTP status:', res.status);
    console.log('Webhook body:', text);

    const okStatus =
      res.status === 200 && json && json.ok === true && typeof json.latency_ms === 'number';

    if (okStatus) {
      ok(`/webhook /start accepted, latency ${json.latency_ms.toFixed(2)}ms`);
      return true;
    }

    fail('/webhook /start did not return ok:true with latency_ms');
    return false;
  } catch (e) {
    fail(`Error sending /start webhook: ${e.message}`);
    return false;
  }
}

async function readMetrics() {
  try {
    const res = await fetch(`${BASE}/metrics`);
    const text = await res.text();
    console.log('\n--- /metrics ---');
    console.log(text.trimEnd());
    console.log('----------------\n');

    if (!res.ok) {
      fail(`/metrics HTTP status ${res.status}`);
      return { ok: false, text };
    }

    const queueMatch = text.match(/queue_published_total\s+(\d+)/);
    const workerMatch =
      text.match(/worker_updates_.*total\s+(\d+)/) ||
      text.match(/worker_updates_total\s+(\d+)/);
    const telegramMatch = text.match(/telegram_sent_total\s+(\d+)/);

    const queueVal = queueMatch ? Number(queueMatch[1]) : NaN;
    const workerVal = workerMatch ? Number(workerMatch[1]) : NaN;
    const telegramVal = telegramMatch ? Number(telegramMatch[1]) : NaN;

    if (Number.isFinite(queueVal) && queueVal >= 1) {
      ok(`queue_published_total=${queueVal}`);
    } else {
      warn('queue_published_total not found or <1');
    }

    if (Number.isFinite(workerVal) && workerVal >= 1) {
      ok(`worker_updates_total≈${workerVal}`);
    } else {
      warn('worker_updates_total metric not found or <1 (check metric name)');
    }

    if (Number.isFinite(telegramVal) && telegramVal >= 1) {
      ok(`telegram_sent_total=${telegramVal}`);
    } else {
      warn('telegram_sent_total not found or <1 (check telegram mock metrics)');
    }

    const hardOk =
      Number.isFinite(queueVal) &&
      queueVal >= 1 &&
      Number.isFinite(workerVal) &&
      workerVal >= 1 &&
      Number.isFinite(telegramVal) &&
      telegramVal >= 1;

    return { ok: hardOk, text };
  } catch (e) {
    fail(`/metrics request error: ${e.message}`);
    return { ok: false, text: '' };
  }
}

async function main() {
  console.log('=== Stage 3 Verification (ingest + worker) ===');
  console.log(`Using BASE=${BASE}, TELEGRAM_SECRET=${TELEGRAM_SECRET}`);

  // 1) Start ingest
  console.log('\n→ Starting ingest server...');
  const ingest = startProcess(
    'INGEST',
    ['dist/ingest/server.js'],
    {
      HOST,
      PORT: String(PORT),
      TELEGRAM_MOCK: '1',
      PUBSUB_DRIVER: 'memory',
      TELEGRAM_SECRET,
    },
  );

  // 2) Wait for /health
  const healthOk = await waitForHealth();
  if (!healthOk) {
    fail('Ingest /health did not become ready');
    ingest.kill('SIGINT');
    process.exit(1);
  }

  // 3) Start worker
  console.log('\n→ Starting worker...');
  const worker = startProcess(
    'WORKER',
    ['dist/workers/telegram-updates/index.js'],
    {
      TELEGRAM_MOCK: '1',
      PUBSUB_DRIVER: 'memory',
      TELEGRAM_SECRET,
    },
  );

  // Дамо воркеру стартанути
  await sleep(1500);

  // 4) Надсилаємо /start
  console.log('\n→ Sending /start webhook...');
  const webhookOk = await sendWebhookStart();

  // Чекаємо, поки воркер забере з черги
  await sleep(1500);

  // 5) Читаємо метрики
  console.log('\n→ Reading /metrics...');
  const metricsResult = await readMetrics();

  // 6) Гасимо процеси
  ingest.kill('SIGINT');
  worker.kill('SIGINT');

  await sleep(500);

  console.log('\n=== SUMMARY ===');
  if (webhookOk && metricsResult.ok) {
    ok('Stage 3 checks passed. Ingest + Worker + telegram_mock працюють як очікується.');
    console.log('Готово до переходу на етап 4 (Redis / кеш / локи).');
    process.exit(0);
  } else {
    fail('Stage 3 має проблеми. Перевір логи INGEST/WORKER, метрики і секретний токен.');
    process.exit(1);
  }
}

main().catch((e) => {
  fail(`Unexpected error: ${e.message}`);
  process.exit(1);
});
