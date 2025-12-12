import { fetch } from 'undici';
import { logger } from '../utils/logger.js';
import { incrementTelegramSent } from '../utils/metrics.js';

type SendOpts = { reply_markup?: unknown };
type OutboxItem = { chatId: number; text: string; opts?: SendOpts; ts: number };

const outbox: OutboxItem[] = [];
const OUTBOX_LIMIT = 50;

function pushOutbox(entry: OutboxItem) {
  outbox.push(entry);
  if (outbox.length > OUTBOX_LIMIT) {
    outbox.shift();
  }
}

export function getOutbox(): OutboxItem[] {
  return [...outbox];
}

export async function sendMessage(
  chatId: number,
  text: string,
  opts?: SendOpts,
): Promise<void> {
  const mock = process.env.TELEGRAM_MOCK === '1';
  if (mock) {
    logger.info({ chatId, text }, 'Telegram mock send');
    incrementTelegramSent();
    pushOutbox({ chatId, text, opts, ts: Date.now() });
    return;
  }

  const token =
    process.env.TELEGRAM_BOT_TOKEN ?? process.env.BOT_TOKEN ?? process.env.TOKEN;
  const api = process.env.TELEGRAM_API || 'https://api.telegram.org';
  if (!token) {
    logger.error('TELEGRAM_BOT_TOKEN (or BOT_TOKEN/TOKEN) is required to send Telegram messages');
    return;
  }

  const url = `${api}/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...opts }),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, 'Failed to send Telegram message');
    return;
  }

  incrementTelegramSent();
}
