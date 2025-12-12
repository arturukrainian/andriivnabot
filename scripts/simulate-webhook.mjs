import { fetch } from 'undici';

const port = process.env.PORT ?? '8080';
const host = process.env.HOST ?? '127.0.0.1';
const secret =
  process.env.TELEGRAM_WEBHOOK_SECRET ?? process.env.TELEGRAM_SECRET ?? 'dev-secret';

const update = {
  update_id: Date.now(),
  message: {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    text: '/start',
    chat: {
      id: Number(process.env.TEST_CHAT_ID ?? 123456),
      type: 'private',
      username: 'test_user',
    },
  },
};

const url = `http://${host}:${port}/webhook`;
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Telegram-Bot-Api-Secret-Token': secret,
  },
  body: JSON.stringify(update),
});

const text = await res.text();
console.log(`Webhook responded with ${res.status}: ${text}`);
