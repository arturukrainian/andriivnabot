import { spawn } from 'node:child_process';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8081);
const BASE = `http://${HOST}:${PORT}`;
const TELEGRAM_SECRET = process.env.TELEGRAM_SECRET || 'dev-secret';
const RUN_SERVER_MODE = process.argv.includes('--server');

const ok = (m) => console.log(`✅ ${m}`);
const warn = (m) => console.log(`⚠️  ${m}`);
const fail = (m) => console.log(`❌ ${m}`);

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function start(label, args, env) {
  const proc = spawn(process.execPath, args, {
    env: {
      ...process.env,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (d) => console.log(`[${label}] ${d.toString().trimEnd()}`));
  proc.stderr.on('data', (d) => console.error(`[${label} ERROR] ${d.toString().trimEnd()}`));
  proc.on('exit', (code) => console.log(`[${label}] exited ${code}`));
  return proc;
}

async function waitHealth(timeoutMs = 8000) {
  const startTs = Date.now();
  while (Date.now() - startTs < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      // ignore
    }
    await sleep(200);
  }
  return false;
}

async function sendWebhook() {
  const payload = {
    update_id: Date.now() % 1_000_000,
    message: { chat: { id: 1 }, text: '/start' },
  };
  const res = await fetch(`${BASE}/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': TELEGRAM_SECRET,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  console.log(`[WEBHOOK] status=${res.status} body=${text}`);
  return res.ok;
}

async function readMetrics() {
  const res = await fetch(`${BASE}/metrics`);
  const text = await res.text();
  console.log('\n--- /metrics ---\n' + text.trimEnd() + '\n--------------\n');
  const q = text.match(/queue_published_total\s+(\d+)/);
  const w =
    text.match(/worker_updates_processed_total\s+(\d+)/) ||
    text.match(/worker_updates_received_total\s+(\d+)/);
  const t = text.match(/telegram_sent_total\s+(\d+)/);
  const queueVal = q ? Number(q[1]) : NaN;
  const workerVal = w ? Number(w[1]) : NaN;
  const teleVal = t ? Number(t[1]) : NaN;
  return { queueVal, workerVal, teleVal, text };
}

async function runServerMode() {
  console.log('=== Stage 3 Verify — server mode (boot only) ===');
  console.log(`BASE=${BASE} PUBSUB_DRIVER=memory TELEGRAM_MOCK=1`);

  const ingest = start('INGEST', ['dist/ingest/server.js'], {
    HOST,
    PORT: String(PORT),
    TELEGRAM_SECRET,
    TELEGRAM_MOCK: '1',
    PUBSUB_DRIVER: 'memory',
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  });

  const healthOk = await waitHealth(15000);
  if (!healthOk) {
    fail('/health not ready');
    ingest.kill('SIGINT');
    process.exit(1);
  }
  ok('ingest /health ready');

  const worker = start('WORKER', ['dist/workers/telegram-updates/index.js'], {
    TELEGRAM_SECRET,
    TELEGRAM_MOCK: '1',
    PUBSUB_DRIVER: 'memory',
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  });

  console.log('[SERVER] ingest + worker up; waiting for SIGINT/SIGTERM to stop');

  await new Promise((resolve) => {
    let stopped = false;
    const stop = (reason) => {
      if (stopped) return;
      stopped = true;
      console.log(`[SERVER] stopping (${reason})`);
      if (!ingest.killed) ingest.kill('SIGINT');
      if (!worker.killed) worker.kill('SIGINT');
      resolve();
    };

    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
    ingest.once('exit', (code) => stop(`ingest exit ${code}`));
    worker.once('exit', (code) => stop(`worker exit ${code}`));
  });
}

async function main() {
  if (RUN_SERVER_MODE) {
    await runServerMode();
    return;
  }

  console.log('=== Stage 3 Verify (ingest + worker + redis/mock) ===');
  console.log(`BASE=${BASE} PUBSUB_DRIVER=memory TELEGRAM_MOCK=1`);

  const ingest = start('INGEST', ['dist/ingest/server.js'], {
    HOST,
    PORT: String(PORT),
    TELEGRAM_SECRET,
    TELEGRAM_MOCK: '1',
    PUBSUB_DRIVER: 'memory',
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  });

  const healthOk = await waitHealth();
  if (!healthOk) {
    fail('/health not ready');
    ingest.kill('SIGINT');
    process.exit(1);
  }
  ok('ingest /health ready');

  const worker = start('WORKER', ['dist/workers/telegram-updates/index.js'], {
    TELEGRAM_SECRET,
    TELEGRAM_MOCK: '1',
    PUBSUB_DRIVER: 'memory',
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  });

  await sleep(800);
  await sendWebhook();
  await sleep(1500);

  const metrics = await readMetrics();

  ingest.kill('SIGINT');
  worker.kill('SIGINT');
  await sleep(300);

  const pass =
    Number.isFinite(metrics.queueVal) &&
    metrics.queueVal > 0 &&
    Number.isFinite(metrics.workerVal) &&
    metrics.workerVal > 0 &&
    Number.isFinite(metrics.teleVal) &&
    metrics.teleVal > 0;

  if (pass) {
    ok(`Stage3 verify passed — queue=${metrics.queueVal}, worker=${metrics.workerVal}, telegram=${metrics.teleVal}`);
    process.exit(0);
  } else {
    fail('Stage3 verify failed — missing metrics');
    process.exit(1);
  }
}

main().catch((err) => {
  fail(`Unexpected error: ${err.message}`);
  process.exit(1);
});
