import { config as loadEnv } from 'dotenv';
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

async function main() {
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

main().catch((err) => {
  logger.error({ err }, 'Worker init failed');
  process.exit(1);
});
