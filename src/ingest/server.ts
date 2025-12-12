import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import underPressure from '@fastify/under-pressure';
import { config as loadEnv } from 'dotenv';
import { registerWebhookRoute } from './routes/webhook.js';
import { logger } from '../utils/logger.js';
import { getMetricsText } from '../utils/metrics.js';
import { getMemoryPubCount } from '../utils/pubsub.js';
import { initAnalytics, trackEvent } from '../utils/analytics.js';
import adminPlugin from './plugins/admin.js';

loadEnv();
initAnalytics();

const app = Fastify({
  logger,
});

app.get('/health', (_req, reply) => {
  try {
    reply.status(200).type('text/plain').send('ok');
  } catch {
    reply.status(200).type('text/plain').send('ok');
  }
});

app.register(helmet);
app.register(underPressure);

app.get('/metrics', async (_req, reply) => {
  const lines = await getMetricsText({ memoryPubCount: getMemoryPubCount() });
  return reply.type('text/plain').send(lines);
});

app.register(registerWebhookRoute);
app.register(adminPlugin);

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';

app
  .listen({ port, host })
  .then(() => {
    logger.info({ port, host }, 'Ingest server listening');
    void trackEvent('app_start', {
      version: process.env.npm_package_version ?? 'dev',
      env: process.env.NODE_ENV ?? 'dev',
      redis_mode: process.env.REDIS_URL ? 'external' : 'memory',
    });
  })
  .catch((err: unknown) => {
    logger.error({ err }, 'Failed to start ingest server');
    process.exit(1);
  });
