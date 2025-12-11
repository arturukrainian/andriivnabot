import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { incCounter } from '../../utils/metrics.js';

const AUTH_HEADER = 'x-admin-token';

const LessonCreateSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  contentUrl: z.string().url().optional(),
  level: z.number().int().min(1).max(6).default(1),
  isPublished: z.boolean().default(false),
});

const LessonPatchSchema = z.object({
  slug: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  contentUrl: z.string().url().nullable().optional(),
  level: z.number().int().min(1).max(6).optional(),
  isPublished: z.boolean().optional(),
});

const UsersQuerySchema = z.object({
  telegramId: z.string().optional(),
  username: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

const LessonsQuerySchema = z.object({
  q: z.string().optional(),
  published: z.enum(['true', 'false']).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

const ProgressQuerySchema = z.object({
  userId: z.string().optional(),
  lessonId: z.string().optional(),
  status: z.enum(['NOT_STARTED', 'STARTED', 'COMPLETED']).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

const ProgressPatchSchema = z.object({
  status: z.enum(['NOT_STARTED', 'STARTED', 'COMPLETED']).optional(),
  score: z.number().int().min(0).max(100).optional(),
});

function sendError(reply: FastifyReply, code: number, msg: string, details?: unknown) {
  return reply.code(code).send({ error: msg, code, details });
}

function ensureAuthorized(
  req: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
) {
  try {
    const token = req.headers[AUTH_HEADER] as string | undefined;
    if (!token || token !== process.env.ADMIN_TOKEN) {
      incCounter('admin_auth_failures_total', 1);
      sendError(reply, 401, 'unauthorized');
      return;
    }
    done();
  } catch (err) {
    incCounter('admin_errors_total', 1);
    sendError(reply, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
}

async function routes(app: FastifyInstance) {
  app.addHook('onRequest', (req, reply, done) => {
    if (req.url.startsWith('/admin/')) {
      ensureAuthorized(req, reply, done);
      return;
    }
    done();
  });

  app.addHook('preHandler', (req, _reply, done) => {
    if (req.url.startsWith('/admin/')) {
      incCounter('admin_requests_total', 1);
    }
    done();
  });

  app.get('/admin/lessons', async (req, reply) => {
    try {
      const { q, published, limit = '50', offset = '0' } = LessonsQuerySchema.parse(req.query);
      const where: Record<string, unknown> = {};
      if (q) {
        where.OR = [
          { slug: { contains: q, mode: 'insensitive' } },
          { title: { contains: q, mode: 'insensitive' } },
        ];
      }
      if (published === 'true') where.isPublished = true;
      if (published === 'false') where.isPublished = false;

      const items = await prisma.lesson.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Number(limit),
        skip: Number(offset),
      });
      reply.send({ items });
    } catch (err) {
      incCounter('admin_errors_total', 1);
      const details = err instanceof Error ? err.message : String(err);
      sendError(reply, 400, 'bad_request', details);
    }
  });

  app.post('/admin/lessons', async (req, reply) => {
    try {
      const data = LessonCreateSchema.parse(req.body);
      const item = await prisma.lesson.create({ data });
      reply.send({ item });
    } catch (err) {
      incCounter('admin_errors_total', 1);
      const details = err instanceof Error ? err.message : String(err);
      sendError(reply, 400, 'bad_request', details);
    }
  });

  app.patch('/admin/lessons/:id', async (req, reply) => {
    try {
      const id = Number((req.params as { id: string }).id);
      const data = LessonPatchSchema.parse(req.body);
      const item = await prisma.lesson.update({ where: { id }, data });
      reply.send({ item });
    } catch (err) {
      incCounter('admin_errors_total', 1);
      const isNotFound = typeof err === 'object' && err && (err as { code?: string }).code === 'P2025';
      const details = err instanceof Error ? err.message : String(err);
      sendError(reply, isNotFound ? 404 : 400, isNotFound ? 'not_found' : 'bad_request', details);
    }
  });

  app.delete('/admin/lessons/:id', async (req, reply) => {
    try {
      const id = Number((req.params as { id: string }).id);
      const item = await prisma.lesson.delete({ where: { id } });
      reply.send({ ok: true, item });
    } catch (err) {
      incCounter('admin_errors_total', 1);
      const isNotFound = typeof err === 'object' && err && (err as { code?: string }).code === 'P2025';
      const details = err instanceof Error ? err.message : String(err);
      sendError(reply, isNotFound ? 404 : 400, isNotFound ? 'not_found' : 'bad_request', details);
    }
  });

  app.get('/admin/users', async (req, reply) => {
    try {
      const { telegramId, username, limit = '50', offset = '0' } = UsersQuerySchema.parse(req.query);
      const where: Record<string, unknown> = {};
      if (telegramId) where.telegramId = BigInt(telegramId);
      if (username) where.username = { contains: username, mode: 'insensitive' };

      const items = await prisma.user.findMany({
        where,
        orderBy: { id: 'desc' },
        take: Number(limit),
        skip: Number(offset),
      });
      reply.send({ items });
    } catch (err) {
      incCounter('admin_errors_total', 1);
      const details = err instanceof Error ? err.message : String(err);
      sendError(reply, 400, 'bad_request', details);
    }
  });

  app.get('/admin/progress', async (req, reply) => {
    try {
      const { userId, lessonId, status, limit = '50', offset = '0' } =
        ProgressQuerySchema.parse(req.query);
      const where: Record<string, unknown> = {};
      if (userId) where.userId = Number(userId);
      if (lessonId) where.lessonId = Number(lessonId);
      if (status) where.status = status;

      const items = await prisma.userProgress.findMany({
        where,
        orderBy: { id: 'desc' },
        take: Number(limit),
        skip: Number(offset),
        include: { user: true, lesson: true },
      });
      reply.send({ items });
    } catch (err) {
      incCounter('admin_errors_total', 1);
      const details = err instanceof Error ? err.message : String(err);
      sendError(reply, 400, 'bad_request', details);
    }
  });

  app.patch('/admin/progress/:id', async (req, reply) => {
    try {
      const id = Number((req.params as { id: string }).id);
      const data = ProgressPatchSchema.parse(req.body);
      const item = await prisma.userProgress.update({ where: { id }, data });
      reply.send({ item });
    } catch (err) {
      incCounter('admin_errors_total', 1);
      const isNotFound = typeof err === 'object' && err && (err as { code?: string }).code === 'P2025';
      const details = err instanceof Error ? err.message : String(err);
      sendError(reply, isNotFound ? 404 : 400, isNotFound ? 'not_found' : 'bad_request', details);
    }
  });
}

export default fp(routes, { name: 'admin-plugin' });
