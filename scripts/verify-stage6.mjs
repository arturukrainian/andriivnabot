import { spawn } from 'node:child_process';

const BASE = process.env.BASE || 'http://127.0.0.1:8526';
const PORT = process.env.PORT || '8526';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token';

let child;
const shouldBoot = process.argv.includes('--boot');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // ignore transient errors
    }
    await sleep(250);
  }
  throw new Error('health timeout');
}

async function request(path, init = {}) {
  const headers = {
    'content-type': 'application/json',
    'x-admin-token': ADMIN_TOKEN,
    ...(init.headers || {}),
  };
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function extractMetric(body, name) {
  const match = new RegExp(`${name}\\s+(\\d+)`).exec(body);
  return Number(match?.[1] ?? 0);
}

async function run() {
  if (shouldBoot) {
    child = spawn('node', ['dist/ingest/server.js'], {
      env: { ...process.env, PORT, ADMIN_TOKEN },
      stdio: 'inherit',
    });
    await sleep(500);
  }

  await waitForHealth();

  const initialMetrics = await fetch(`${BASE}/metrics`).then((res) => res.text());
  const initialRequestCount = extractMetric(initialMetrics, 'admin_requests_total');
  const initialErrorCount = extractMetric(initialMetrics, 'admin_errors_total');
  const initialAuthFailCount = extractMetric(initialMetrics, 'admin_auth_failures_total');

  const unauthorized = await fetch(`${BASE}/admin/lessons`);
  if (unauthorized.status !== 401) {
    throw new Error('expected 401 for unauthorized request');
  }

  const slug = `stage6-${Date.now()}`;
  const createBody = {
    slug,
    title: 'Stage6 Test',
    level: 1,
    isPublished: false,
  };
  const created = await request('/admin/lessons', {
    method: 'POST',
    body: JSON.stringify(createBody),
  });
  if (!created.res.ok || !created.data?.item?.id) {
    throw new Error('lesson create failed');
  }
  const lessonId = created.data.item.id;

  const listed = await request(`/admin/lessons?q=${slug}`);
  const found = (listed.data?.items || []).find((item) => item.slug === slug);
  if (!listed.res.ok || !found) {
    throw new Error('lesson listing failed');
  }

  const patched = await request(`/admin/lessons/${lessonId}`, {
    method: 'PATCH',
    body: JSON.stringify({ isPublished: true, title: 'Stage6 Updated' }),
  });
  if (!patched.res.ok || patched.data?.item?.isPublished !== true) {
    throw new Error('lesson patch failed');
  }

  const deleted = await request(`/admin/lessons/${lessonId}`, { method: 'DELETE' });
  if (!deleted.res.ok || deleted.data?.ok !== true) {
    throw new Error('lesson delete failed');
  }

  const metricsRes = await fetch(`${BASE}/metrics`);
  const metricsBody = await metricsRes.text();
  const requestCount = extractMetric(metricsBody, 'admin_requests_total');
  const errorCount = extractMetric(metricsBody, 'admin_errors_total');
  const authFailCount = extractMetric(metricsBody, 'admin_auth_failures_total');

  const requestDelta = requestCount - initialRequestCount;
  const errorDelta = errorCount - initialErrorCount;
  const authFailDelta = authFailCount - initialAuthFailCount;

  if (requestDelta < 4) {
    throw new Error('metrics admin_requests_total did not increment as expected');
  }
  if (errorDelta !== 0) {
    throw new Error('metrics admin_errors_total must remain zero');
  }
  if (authFailDelta < 1) {
    throw new Error('metrics admin_auth_failures_total did not increment as expected');
  }

  console.log('✅ Stage6 passed');
}

run()
  .catch((err) => {
    console.error('❌ Stage6 failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (child) {
      await sleep(200);
      try {
        child.kill('SIGINT');
      } catch {
        // ignore
      }
    }
  });
