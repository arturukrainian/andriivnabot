import { config as loadEnv } from 'dotenv';
import http from 'node:http';
import { getPubSub } from '../../utils/pubsub.js';
import { logger } from '../../utils/logger.js';
import {
  incrementWorkerUpdatesReceived,
  incrementWorkerUpdatesProcessed,
  incrementWorkerErrors,
} from '../../utils/metrics.js';
import { handleUpdate } from './handler.js';
import type { TelegramUpdate } from '../../types/telegram.js';
import { initAnalytics } from '../../utils/analytics.js';

loadEnv();
initAnalytics();

function isTelegramUpdate(payload: unknown): payload is TelegramUpdate {
  return Boolean(payload && typeof (payload as TelegramUpdate).update_id === 'number');
}

async function startWorker(): Promise<void> {
  const topic = process.env.PUBSUB_TOPIC || 'telegram_updates';
  const pubsub = getPubSub();

  await pubsub.subscribe(topic, async (msg) => {
    const payload = msg.data;
    if (!isTelegramUpdate(payload)) {
      logger.warn({ payload }, 'Received non-telegram update');
      return;
    }

    incrementWorkerUpdatesReceived();
    try {
      await handleUpdate(payload);
      incrementWorkerUpdatesProcessed();
    } catch (err) {
      incrementWorkerErrors();
      logger.error({ err, update_id: payload.update_id }, 'Worker failed handling update');
    }
  });

  logger.info({ topic }, 'telegram-updates worker started');
}

async function main(): Promise<void> {
  startWorker().catch((err) => {
    logger.error({ err }, 'Worker init failed');
    console.error(err);
    process.exit(1);
  });

  const port = Number(process.env.PORT || 8080);
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('worker');
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'worker HTTP server listening');
    console.log(`Worker listening on ${port}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'Worker fatal error');
  process.exit(1);
});
