import fs from 'node:fs';
import crypto from 'node:crypto';
import { PubSub as GcpPubSub } from '@google-cloud/pubsub';
import type { PubSub, Subscription } from '@google-cloud/pubsub';
import { logger } from './logger.js';
import { incrementQueuePublished } from './metrics.js';

export interface PubSubMessage {
  data: unknown;
  attributes?: Record<string, string>;
}

export interface PubSubDriver {
  publish(topic: string, data: unknown, attrs?: Record<string, string>): Promise<void>;
}

export interface PubSubSubscriber {
  subscribe(topic: string, onMessage: (msg: PubSubMessage) => Promise<void>): Promise<void>;
}

type MemoryQueueItem = {
  id: string;
  topic: string;
  data: unknown;
  attributes?: Record<string, string>;
};

type Handler = (msg: PubSubMessage) => Promise<void> | void;

const subscribers: Record<string, Handler[]> = {};
const processedIds: Set<string> = new Set();
const MEMORY_QUEUE_FILE = process.env.PUBSUB_STORE || '.pubsub-memory.json';
const POLL_INTERVAL = Number(process.env.WORKER_POLL_INTERVAL_MS || 50);

function readQueue(): MemoryQueueItem[] {
  try {
    const raw = fs.readFileSync(MEMORY_QUEUE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as MemoryQueueItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: MemoryQueueItem[]) {
  try {
    fs.writeFileSync(MEMORY_QUEUE_FILE, JSON.stringify(queue), 'utf8');
  } catch {
    logger.warn({ file: MEMORY_QUEUE_FILE }, 'Failed to write memory pubsub queue');
  }
}

class MemoryDriver implements PubSubDriver, PubSubSubscriber {
  async publish(topic: string, data: unknown, attrs?: Record<string, string>): Promise<void> {
    incrementQueuePublished();
    const msg: MemoryQueueItem = {
      id: crypto.randomUUID(),
      topic,
      data,
      attributes: attrs,
    };

    const queue = readQueue();
    queue.push(msg);
    writeQueue(queue);

    const handlers = subscribers[topic] ?? [];
    for (const handler of handlers) {
      queueMicrotask(() => {
        Promise.resolve(handler({ data, attributes: attrs })).catch((err) => {
          logger.error({ err, topic }, 'memory pubsub handler error');
        });
      });
    }
  }

  async subscribe(topic: string, handler: Handler): Promise<void> {
    if (!subscribers[topic]) subscribers[topic] = [];
    subscribers[topic].push(handler);
    logger.info({ topic }, 'memory pubsub subscribed');

    setInterval(() => {
      const queue = readQueue();
      for (const item of queue) {
        if (item.topic !== topic || processedIds.has(item.id)) continue;
        processedIds.add(item.id);
        Promise.resolve(handler({ data: item.data, attributes: item.attributes })).catch((err) => {
          logger.error({ err, topic }, 'memory pubsub handler error');
        });
      }
    }, POLL_INTERVAL);
  }
}

class GcpDriver implements PubSubDriver, PubSubSubscriber {
  private client: PubSub;
  private subscriptionCache: Map<string, Subscription> = new Map();

  constructor() {
    this.client = new GcpPubSub({
      projectId: process.env.GCP_PROJECT,
    });
  }

  async publish(topic: string, data: unknown, attrs?: Record<string, string>): Promise<void> {
    incrementQueuePublished();
    await this.client.topic(topic).publishMessage({
      json: data as Record<string, unknown>,
      attributes: attrs,
    });
  }

  async subscribe(topic: string, onMessage: (msg: PubSubMessage) => Promise<void>): Promise<void> {
    const subscriptionName =
      process.env.PUBSUB_SUBSCRIPTION || `${topic}-subscription-memory-placeholder`;
    let subscription = this.subscriptionCache.get(subscriptionName);
    if (!subscription) {
      subscription = this.client.subscription(subscriptionName);
      this.subscriptionCache.set(subscriptionName, subscription);
    }

    subscription.on('message', async (message) => {
      try {
        const payload = message.data ? JSON.parse(message.data.toString()) : null;
        await onMessage({ data: payload, attributes: message.attributes as Record<string, string> });
        message.ack();
      } catch (err) {
        logger.error({ err }, 'GCP pubsub handler failed');
        message.nack();
      }
    });
  }
}

let memoryDriver: MemoryDriver | null = null;
let gcpDriver: GcpDriver | null = null;

function ensureMemoryDriver(): MemoryDriver {
  if (!memoryDriver) {
    memoryDriver = new MemoryDriver();
  }
  return memoryDriver;
}

function ensureGcpDriver(): GcpDriver {
  if (!gcpDriver) {
    gcpDriver = new GcpDriver();
    logger.info({ driver: 'gcp' }, 'Initialized GCP Pub/Sub driver');
  }
  return gcpDriver;
}

export function getPubSub(): PubSubDriver & PubSubSubscriber {
  const driver = (process.env.PUBSUB_DRIVER || 'memory').toLowerCase();
  if (driver === 'gcp') {
    return ensureGcpDriver();
  }

  return ensureMemoryDriver();
}

export function getMemoryPubCount(): number {
  const queue = readQueue();
  return queue.length;
}
