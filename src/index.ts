import Fastify from 'fastify';
import { config as loadEnv } from 'dotenv';
import { logger } from './utils/logger.js';

loadEnv();

const PORT = Number(process.env.PORT || 8080);

async function startServer() {
  const app = Fastify({ logger: false });

  app.get('/health', async (_req, reply) => {
    return reply.send({ status: 'ok' });
  });

  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    logger.info(`Server listening on port ${PORT}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error(error);
    process.exit(1);
  }
}

startServer();
