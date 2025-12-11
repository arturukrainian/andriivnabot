import { Redis as UpstashRedis } from '@upstash/redis';
import { Redis as IORedis } from 'ioredis';
import crypto from 'node:crypto';
import { logger } from './logger.js';
import { incrementRedisErrors } from './metrics.js';

type RedisClient = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, opts?: { ex?: number; px?: number; nx?: boolean }) => Promise<unknown>;
  del: (key: string) => Promise<number | void>;
  eval?: (script: string, keys: string[], args: string[]) => Promise<unknown>;
  incr?: (key: string) => Promise<number>;
};

const redisUrl = process.env.REDIS_URL;
const redisToken = process.env.REDIS_TOKEN;
const namespace = process.env.REDIS_NAMESPACE || 'engbot';

let client: RedisClient | null = null;
let mode: 'upstash' | 'ioredis' | 'memory' = 'memory';

const memoryStore = new Map<string, { value: unknown; expiresAt: number | null }>();

function buildKey(key: string): string {
  return `${namespace}:${key}`;
}

function ensureClient(): RedisClient {
  if (client) return client;
  if (!redisUrl) {
    logger.warn('REDIS_URL not set; falling back to in-memory store');
    mode = 'memory';
    return {
      async get(key: string) {
        const entry = memoryStore.get(key);
        if (!entry) return null;
        if (entry.expiresAt && entry.expiresAt < Date.now()) {
          memoryStore.delete(key);
          return null;
        }
        return entry.value;
      },
      async set(key: string, value: unknown, opts?: { ex?: number; px?: number; nx?: boolean }) {
        if (opts?.nx && memoryStore.has(key)) return null;
        const ttlMs = opts?.px ?? (opts?.ex ? opts.ex * 1000 : null);
        const expiresAt = ttlMs ? Date.now() + ttlMs : null;
        memoryStore.set(key, { value, expiresAt });
        return 'OK';
      },
      async del(key: string) {
        memoryStore.delete(key);
      },
    };
  }

  if (redisUrl.startsWith('redis://') || redisUrl.startsWith('rediss://')) {
    mode = 'ioredis';
    const io = new IORedis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableAutoPipelining: true,
    });

    io.on('error', (err) => {
      incrementRedisErrors();
      logger.warn({ err }, 'Redis connection error');
    });

    io.connect().catch((err) => {
      incrementRedisErrors();
      logger.warn({ err }, 'Redis connect failed; continuing (ops will safeCall/fallback)');
    });

    client = {
      async get(key: string) {
        return io.get(key);
      },
      async set(key: string, value: unknown, opts?: { ex?: number; px?: number; nx?: boolean }) {
        if (opts?.nx && opts?.px) {
          return io.set(key, value as string, 'PX', opts.px, 'NX');
        }
        if (opts?.nx && opts?.ex) {
          return io.set(key, value as string, 'EX', opts.ex, 'NX');
        }
        if (opts?.px) {
          return io.set(key, value as string, 'PX', opts.px);
        }
        if (opts?.ex) {
          return io.set(key, value as string, 'EX', opts.ex);
        }
        return io.set(key, value as string);
      },
      async del(key: string) {
        return io.del(key);
      },
      async eval(script: string, keys: string[], args: string[]) {
        return io.eval(script, keys.length, ...keys, ...args);
      },
      incr: (k: string) => io.incr(k),
    };
    return client;
  }

  if (!redisToken) {
    if (!process.env.REDIS_SILENT) {
      logger.warn('REDIS_TOKEN missing for Upstash; falling back to in-memory store');
    }
    mode = 'memory';
    return ensureClient();
  }

  mode = 'upstash';
  const upstash = new UpstashRedis({ url: redisUrl, token: redisToken });
  client = {
    async get(key: string) {
      return upstash.get(key);
    },
    async set(key: string, value: unknown, opts?: { ex?: number; px?: number; nx?: boolean }) {
      const options: { ex?: number; px?: number; nx?: boolean } = {};
      if (opts?.ex) options.ex = opts.ex;
      if (opts?.px) options.px = opts.px;
      if (opts?.nx) options.nx = opts.nx;
      // @upstash/redis set signature: set(key, value, opts)
      return upstash.set(key, value as string, options as never);
    },
    async del(key: string) {
      return upstash.del(key);
    },
    // Upstash REST does not support eval; omit.
  };
  return client;
}

async function safeCall<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    incrementRedisErrors();
    logger.error({ err, mode }, 'Redis operation failed');
    return null;
  }
}

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    const c = ensureClient();
    const namespaced = buildKey(`cache:${key}`);
    const res = await safeCall(() => c.get(namespaced));
    if (res == null) return null;
    try {
      return typeof res === 'string' ? (JSON.parse(res) as T) : (res as T);
    } catch {
      return null;
    }
  },
  async set<T>(key: string, value: T, ttlSec?: number): Promise<void> {
    const c = ensureClient();
    const namespaced = buildKey(`cache:${key}`);
    const payload = JSON.stringify(value);
    const opts = ttlSec ? { ex: ttlSec } : undefined;
    await safeCall(() => c.set(namespaced, payload, opts));
  },
  async del(key: string): Promise<void> {
    const c = ensureClient();
    const namespaced = buildKey(`cache:${key}`);
    await safeCall(() => c.del(namespaced));
  },
};

const IDEMPOTENCY_TTL_SEC = Number(process.env.IDEMPOTENCY_TTL_SEC || 3600);
const CHAT_LOCK_TTL_MS = Number(process.env.CHAT_LOCK_TTL_MS || 8000);

export async function seenUpdate(updateId: number): Promise<boolean> {
  const c = ensureClient();
  const key = buildKey(`update:${updateId}`);
  try {
    const res = await c.set(key, '1', { nx: true, ex: IDEMPOTENCY_TTL_SEC });
    return res === null;
  } catch (err) {
    incrementRedisErrors();
    logger.error({ err }, 'seenUpdate failed; allowing processing');
    return false;
  }
}

export async function claimWebhookUpdate(updateId: number, ttlSec: number): Promise<boolean> {
  if (ttlSec <= 0) return true;
  const c = ensureClient();
  const key = buildKey(`ingest:dedup:${updateId}`);
  try {
    const res = await c.set(key, '1', { nx: true, ex: ttlSec });
    return res !== null;
  } catch (err) {
    incrementRedisErrors();
    logger.warn({ err }, 'Webhook dedup check failed; processing update');
    return true;
  }
}

function pickReleaseScript(): string {
  // Lua script for compare-and-del
  return `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
}

export async function withChatLock<T>(chatId: number | string, fn: () => Promise<T>): Promise<T | null> {
  const c = ensureClient();
  const key = buildKey(`lock:chat:${chatId}`);
  const token = crypto.randomUUID();

  const acquired = await safeCall(() => c.set(key, token, { nx: true, px: CHAT_LOCK_TTL_MS }));
  if (acquired === null) {
    return null;
  }

  try {
    return await fn();
  } finally {
    if (c.eval) {
      await safeCall(() => c.eval!(pickReleaseScript(), [key], [token]));
    } else {
      const current = await safeCall(() => c.get(key));
      if (current === token) {
        await safeCall(() => c.del(key));
      }
    }
  }
}

export type RateVerdict = { allowed: boolean; retryAfterMs?: number; scope?: 'chat' | 'global' };

const WINDOW_SEC = 60;
const RATE_LIMIT_PER_CHAT = Number(process.env.RATE_LIMIT_PER_CHAT || 20);
const RATE_LIMIT_BURST_CHAT = Number(process.env.RATE_LIMIT_BURST_CHAT || 10);
const RATE_LIMIT_GLOBAL = Number(process.env.RATE_LIMIT_GLOBAL || 300);
const RATE_LIMIT_BURST_GLOBAL = Number(process.env.RATE_LIMIT_BURST_GLOBAL || 50);

async function incrementCounter(key: string): Promise<{ count: number; ttlSec: number | null } | null> {
  const c = ensureClient();
  if (mode === 'memory') {
    const entry = memoryStore.get(key);
    const now = Date.now();
    let expiresAt = entry?.expiresAt ?? now + WINDOW_SEC * 1000;
    let count = typeof entry?.value === 'number' ? (entry?.value as number) : 0;
    if (entry?.expiresAt && entry.expiresAt < now) {
      count = 0;
      expiresAt = now + WINDOW_SEC * 1000;
    }
    count += 1;
    memoryStore.set(key, { value: count, expiresAt });
    const ttlSec = Math.max(0, Math.ceil((expiresAt - now) / 1000));
    return { count, ttlSec };
  }

  // ioredis / upstash increment with expiry
  const ttlSec = WINDOW_SEC;
  try {
    const newCount = await c.set(key, 1, { nx: true, ex: ttlSec });
    if (newCount === 'OK') {
      return { count: 1, ttlSec };
    }
    // already exists -> increment
    let count = 1;
    if (typeof (c as RedisClient & { incr?: (k: string) => Promise<number> }).incr === 'function') {
      count = await (c as RedisClient & { incr?: (k: string) => Promise<number> }).incr!(key);
    } else {
      // Upstash fallback: get + set
      const current = await c.get(key);
      const next = (typeof current === 'number' ? current : Number(current) || 0) + 1;
      await c.set(key, next, { ex: ttlSec });
      count = next;
    }
    return { count, ttlSec };
  } catch (err) {
    incrementRedisErrors();
    logger.error({ err }, 'Rate limit increment failed');
    return null;
  }
}

function allowed(count: number, limit: number, burst: number): boolean {
  return count <= limit + burst;
}

export async function checkRate(chatId?: number | string): Promise<RateVerdict> {
  const globalKey = buildKey('rate:global');
  const global = await incrementCounter(globalKey);
  if (global && !allowed(global.count, RATE_LIMIT_GLOBAL, RATE_LIMIT_BURST_GLOBAL)) {
    return { allowed: false, retryAfterMs: (global.ttlSec ?? WINDOW_SEC) * 1000, scope: 'global' };
  }

  if (chatId == null) {
    return { allowed: true };
  }

  const chatKey = buildKey(`rate:chat:${chatId}`);
  const perChat = await incrementCounter(chatKey);
  if (perChat && !allowed(perChat.count, RATE_LIMIT_PER_CHAT, RATE_LIMIT_BURST_CHAT)) {
    return { allowed: false, retryAfterMs: (perChat.ttlSec ?? WINDOW_SEC) * 1000, scope: 'chat' };
  }

  return { allowed: true };
}
