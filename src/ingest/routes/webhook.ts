import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getPubSub } from '../../utils/pubsub.js';
import { logger } from '../../utils/logger.js';
import { incrementWebhookRequests, incrementWebhookUnauthorized, recordWebhookLatencyMs } from '../../utils/metrics.js';
import type { TelegramUpdate } from '../../types/telegram.js';
import { claimWebhookUpdate } from '../../utils/redis.js';
import { trackEvent } from '../../utils/analytics.js';

const UpdateSchema = z.object({ update_id: z.number() }).passthrough();

const WEBHOOK_DEDUP_SEC = Number(process.env.WEBHOOK_DEDUP_SEC ?? 0);

function computeLatencyMs(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1e6;
}

export async function registerWebhookRoute(app: FastifyInstance): Promise<void> {
  app.post(
    '/webhook',
    async (
      req: FastifyRequest<{ Body: unknown }>,
      reply: FastifyReply,
    ): Promise<FastifyReply> => {
      const started = process.hrtime.bigint();
      incrementWebhookRequests();

      const expected = (process.env.TELEGRAM_WEBHOOK_SECRET ?? process.env.TELEGRAM_SECRET)?.trim();
      const headerValue = req.headers['x-telegram-bot-api-secret-token'];
      const got =
        typeof headerValue === 'string'
          ? headerValue.trim()
          : Array.isArray(headerValue)
            ? headerValue[0]?.trim()
            : undefined;

      req.log.info({ expected, got }, 'webhook-secret-check');

      if (expected && got !== expected) {
        incrementWebhookUnauthorized();
        logger.warn({ reason: 'bad_secret' }, 'Unauthorized webhook');
        const latencyMs = computeLatencyMs(started);
        recordWebhookLatencyMs(latencyMs);
        return reply.status(401).send({ ok: false });
      }

      const parsed = UpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        logger.warn(
          { reason: 'invalid_payload', issues: parsed.error.issues },
          'Webhook validation failed',
        );
        const latencyMs = computeLatencyMs(started);
        recordWebhookLatencyMs(latencyMs);
        return reply.status(400).send({ ok: false, error: 'invalid_payload' });
      }

      const update = parsed.data as TelegramUpdate;
      const updateType = update.message ? 'message' : update.callback_query ? 'callback_query' : 'other';
      const hasText = Boolean(update.message?.text);
      const chatType =
        update.message?.chat?.type ??
        update.callback_query?.message?.chat?.type ??
        'unknown';
      const chatId =
        update.message?.chat?.id ??
        update.callback_query?.message?.chat?.id ??
        update.callback_query?.from?.id;

      void trackEvent(
        'webhook_received',
        {
          update_type: updateType,
          has_text: hasText,
          chat_type: chatType,
        },
        chatId,
      );

      if (WEBHOOK_DEDUP_SEC > 0) {
        const claimed = await claimWebhookUpdate(update.update_id, WEBHOOK_DEDUP_SEC);
        if (!claimed) {
          logger.info({ update_id: update.update_id }, 'Ingest dedup drop');
          const latencyMs = computeLatencyMs(started);
          recordWebhookLatencyMs(latencyMs);
          return reply.status(200).send({ ok: true, dedup: true, latency_ms: latencyMs });
        }
      }

      const topic = process.env.PUBSUB_TOPIC || 'telegram_updates';
      const pubsub = getPubSub();

      Promise.resolve()
        .then(() =>
          pubsub.publish(topic, update, {
            update_id: String(update.update_id),
            source: 'webhook',
          }),
        )
        .then(() => {
          logger.info({ update_id: update.update_id, topic }, 'Webhook enqueued');
        })
        .catch((err: unknown) => {
          logger.error({ err, update_id: update.update_id, topic }, 'Webhook enqueue failed');
        });

      const latencyMs = computeLatencyMs(started);
      recordWebhookLatencyMs(latencyMs);
      return reply.status(200).send({ ok: true, latency_ms: latencyMs });
    },
  );
}
