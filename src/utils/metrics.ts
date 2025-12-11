import fs from 'node:fs';

type Counters = {
  queuePublished: number;
  webhookRequests: number;
  webhookUnauthorized: number;
  workerUpdatesReceived: number;
  workerUpdatesProcessed: number;
  workerUpdatesDuplicate: number;
  workerLockContention: number;
  workerRateLimitDrop: number;
  workerErrors: number;
  telegramSentTotal: number;
  redisErrors: number;
  adminRequests: number;
  adminErrors: number;
  analyticsEvents: Record<string, number>;
  analyticsErrors: number;
};

const DEFAULT_COUNTERS: Counters = {
  queuePublished: 0,
  webhookRequests: 0,
  webhookUnauthorized: 0,
  workerUpdatesReceived: 0,
  workerUpdatesProcessed: 0,
  workerUpdatesDuplicate: 0,
  workerLockContention: 0,
  workerRateLimitDrop: 0,
  workerErrors: 0,
  telegramSentTotal: 0,
  redisErrors: 0,
  adminRequests: 0,
  adminErrors: 0,
  analyticsEvents: {},
  analyticsErrors: 0,
};

const METRICS_FILE = process.env.METRICS_STORE || '.metrics-store.json';
const CUSTOM_COUNTERS = new Map<string, number>();
type NumericCounterKey = 'adminRequests' | 'adminErrors';
const KNOWN_COUNTER_MAP: Record<string, NumericCounterKey> = {
  admin_requests_total: 'adminRequests',
  admin_errors_total: 'adminErrors',
};

function readCountersFromDisk(): Counters {
  try {
    const raw = fs.readFileSync(METRICS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Counters>;
    return {
      ...DEFAULT_COUNTERS,
      ...parsed,
      analyticsEvents: {
        ...(DEFAULT_COUNTERS.analyticsEvents || {}),
        ...(parsed.analyticsEvents || {}),
      },
    };
  } catch {
    return {
      ...DEFAULT_COUNTERS,
      analyticsEvents: { ...(DEFAULT_COUNTERS.analyticsEvents || {}) },
    };
  }
}

function writeCountersToDisk(counters: Counters) {
  try {
    fs.writeFileSync(METRICS_FILE, JSON.stringify(counters), 'utf8');
  } catch {
    /* ignore write failures */
  }
}

let counters: Counters = readCountersFromDisk();

function updateCounters(mutator: (c: Counters) => void) {
  counters = readCountersFromDisk();
  mutator(counters);
  writeCountersToDisk(counters);
}

const webhookLatencies: number[] = [];
const workerHandleLatencies: number[] = [];
const MAX_LATENCY_SAMPLES = 200;

function recordLatency(bucket: number[], ms: number) {
  bucket.push(ms);
  if (bucket.length > MAX_LATENCY_SAMPLES) {
    bucket.shift();
  }
}

export function incrementQueuePublished(): void {
  updateCounters((c) => {
    c.queuePublished += 1;
  });
}

export function incrementWebhookRequests(): void {
  updateCounters((c) => {
    c.webhookRequests += 1;
  });
}

export function incrementWebhookUnauthorized(): void {
  updateCounters((c) => {
    c.webhookUnauthorized += 1;
  });
}

export function incrementWorkerUpdatesReceived(): void {
  updateCounters((c) => {
    c.workerUpdatesReceived += 1;
  });
}

export function incrementWorkerUpdatesProcessed(): void {
  updateCounters((c) => {
    c.workerUpdatesProcessed += 1;
  });
}

export function incrementWorkerErrors(): void {
  updateCounters((c) => {
    c.workerErrors += 1;
  });
}

export function incrementWorkerUpdatesDuplicate(): void {
  updateCounters((c) => {
    c.workerUpdatesDuplicate += 1;
  });
}

export function incrementWorkerLockContention(): void {
  updateCounters((c) => {
    c.workerLockContention += 1;
  });
}

export function incrementWorkerRateLimitDrop(): void {
  updateCounters((c) => {
    c.workerRateLimitDrop += 1;
  });
}

export function incrementTelegramSent(): void {
  updateCounters((c) => {
    c.telegramSentTotal += 1;
  });
}

export function incrementRedisErrors(): void {
  updateCounters((c) => {
    c.redisErrors += 1;
  });
}

export function incrementAdminRequests(): void {
  updateCounters((c) => {
    c.adminRequests += 1;
  });
}

export function incrementAdminErrors(): void {
  updateCounters((c) => {
    c.adminErrors += 1;
  });
}

export function incCounter(name: string, by = 1): void {
  const mapped = KNOWN_COUNTER_MAP[name];
  if (mapped) {
    updateCounters((c) => {
      c[mapped] += by;
    });
    return;
  }
  const current = CUSTOM_COUNTERS.get(name) ?? 0;
  CUSTOM_COUNTERS.set(name, current + by);
}

export function incrementAnalyticsEvent(name: string): void {
  updateCounters((c) => {
    if (!c.analyticsEvents[name]) {
      c.analyticsEvents[name] = 0;
    }
    c.analyticsEvents[name] += 1;
  });
}

export function incrementAnalyticsErrors(): void {
  updateCounters((c) => {
    c.analyticsErrors += 1;
  });
}
export function recordWebhookLatencyMs(ms: number): void {
  recordLatency(webhookLatencies, ms);
}

export function recordWorkerHandleDurationMs(ms: number): void {
  recordLatency(workerHandleLatencies, ms);
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return Number(sorted[idx].toFixed(2));
}

export function getMetricsSnapshot() {
  const diskCounters = readCountersFromDisk();
  return {
    queuePublished: diskCounters.queuePublished,
    webhookRequests: diskCounters.webhookRequests,
    webhookUnauthorized: diskCounters.webhookUnauthorized,
    workerUpdatesReceived: diskCounters.workerUpdatesReceived,
    workerUpdatesProcessed: diskCounters.workerUpdatesProcessed,
    workerUpdatesDuplicate: diskCounters.workerUpdatesDuplicate,
    workerLockContention: diskCounters.workerLockContention,
    workerRateLimitDrop: diskCounters.workerRateLimitDrop,
    workerErrors: diskCounters.workerErrors,
    telegramSentTotal: diskCounters.telegramSentTotal,
    redisErrors: diskCounters.redisErrors,
    adminRequests: diskCounters.adminRequests,
    adminErrors: diskCounters.adminErrors,
    analyticsEvents: diskCounters.analyticsEvents,
    analyticsErrors: diskCounters.analyticsErrors,
    webhookLatencyP95: percentile95(webhookLatencies),
    workerHandleP95: percentile95(workerHandleLatencies),
  };
}

type MetricsTextOptions = {
  memoryPubCount?: number;
};

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const DEFAULT_METRIC_NAMES = new Set([
  'queue_published_total',
  'webhook_requests_total',
  'webhook_unauthorized_total',
  'webhook_latency_ms_p95',
  'worker_updates_received_total',
  'worker_updates_processed_total',
  'worker_updates_total',
  'worker_updates_duplicate_total',
  'worker_lock_contention_total',
  'worker_ratelimit_drop_total',
  'worker_errors_total',
  'worker_handle_duration_ms_p95',
  'telegram_sent_total',
  'redis_errors_total',
  'admin_requests_total',
  'admin_errors_total',
  'analytics_errors_total',
  'memory_pubsub_published_total',
]);

export async function getMetricsText(options: MetricsTextOptions = {}): Promise<string> {
  const metrics = getMetricsSnapshot();
  const analyticsEventLines = Object.entries(metrics.analyticsEvents || {}).map(
    ([name, value]) => `analytics_events_total{name="${escapeLabelValue(name)}"} ${value}`,
  );
  const lines = [
    `queue_published_total ${metrics.queuePublished}`,
    `webhook_requests_total ${metrics.webhookRequests}`,
    `webhook_unauthorized_total ${metrics.webhookUnauthorized}`,
    `webhook_latency_ms_p95 ${metrics.webhookLatencyP95}`,
    `worker_updates_received_total ${metrics.workerUpdatesReceived}`,
    `worker_updates_processed_total ${metrics.workerUpdatesProcessed}`,
    `worker_updates_total ${metrics.workerUpdatesProcessed}`,
    `worker_updates_duplicate_total ${metrics.workerUpdatesDuplicate}`,
    `worker_lock_contention_total ${metrics.workerLockContention}`,
    `worker_ratelimit_drop_total ${metrics.workerRateLimitDrop}`,
    `worker_errors_total ${metrics.workerErrors}`,
    `worker_handle_duration_ms_p95 ${metrics.workerHandleP95}`,
    `telegram_sent_total ${metrics.telegramSentTotal}`,
    `redis_errors_total ${metrics.redisErrors}`,
    `admin_requests_total ${metrics.adminRequests}`,
    `admin_errors_total ${metrics.adminErrors}`,
    ...analyticsEventLines,
    `analytics_errors_total ${metrics.analyticsErrors}`,
  ];
  if (typeof options.memoryPubCount === 'number') {
    lines.push(`memory_pubsub_published_total ${options.memoryPubCount}`);
  }
  CUSTOM_COUNTERS.forEach((value, key) => {
    if (KNOWN_COUNTER_MAP[key] || DEFAULT_METRIC_NAMES.has(key)) return;
    lines.push(`${key} ${value}`);
  });
  return lines.join('\n');
}
