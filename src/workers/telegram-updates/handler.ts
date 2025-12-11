import { logger } from '../../utils/logger.js';
import {
  recordWorkerHandleDurationMs,
  incrementWorkerErrors,
  incrementWorkerUpdatesDuplicate,
  incrementWorkerLockContention,
  incrementWorkerRateLimitDrop,
} from '../../utils/metrics.js';
import { sendMessage } from '../../services/telegram.js';
import { ensureUser } from '../../services/user.js';
import { getOrInitProfile, addQuizResult } from '../../services/profile.js';
import { getQuestion, buildInlineKeyboard, checkAnswer } from '../../services/quiz.js';
import type { TelegramUpdate, TelegramMessage } from '../../types/telegram.js';
import { checkRate, seenUpdate, withChatLock } from '../../utils/redis.js';
import { trackEvent } from '../../utils/analytics.js';

function getCommand(text: string): string {
  return text.trim().split(/\s+/)[0].toLowerCase();
}

async function handleMessage(message: TelegramMessage): Promise<void> {
  if (!message.chat?.id || !message.text) return;
  const chatId = message.chat.id;
  const command = getCommand(message.text);
  const username = typeof message.chat.username === 'string' ? message.chat.username : undefined;
  await ensureUser(chatId, { username, name: username });

  switch (command) {
    case '/start': {
      const text =
        'Привіт! Я бот для практики англійської.\n' +
        'Команди: /profile, /quiz, /video';
      await sendMessage(chatId, text);
      break;
    }
    case '/profile': {
      const profile = await getOrInitProfile(chatId);
      await sendMessage(chatId, `Level ${profile.level}, XP ${profile.xp}`);
      break;
    }
    case '/quiz': {
      const q = getQuestion();
      await sendMessage(chatId, q.text, { reply_markup: buildInlineKeyboard(q) });
      void trackEvent('lesson_start', { chat_id: chatId, lesson_type: 'quiz' }, chatId);
      break;
    }
    case '/video': {
      await sendMessage(chatId, 'Переглянь відео: https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      void trackEvent('lesson_start', { chat_id: chatId, lesson_type: 'video' }, chatId);
      break;
    }
    default: {
      await sendMessage(
        chatId,
        'Команда не розпізнана. Доступні: /start, /profile, /quiz, /video.',
      );
    }
  }
}

async function handleCallback(update: TelegramUpdate): Promise<void> {
  const cb = update.callback_query;
  if (!cb || !cb.data) return;
  const { message, from } = cb;
  const chatId = message?.chat?.id ?? from.id;
  if (!chatId) return;

  const parts = cb.data.split(':');
  if (parts[0] !== 'quiz' || parts.length < 3) {
    await sendMessage(chatId, 'Невідома дія.');
    return;
  }

  const [, qid, choice] = parts;
  const correct = checkAnswer(qid, choice);
  const profile = await addQuizResult(chatId, correct);
  const text = correct ? 'Правильно! +10 XP' : 'Невірно. Спробуй ще!';
  await sendMessage(chatId, `${text}\nLevel ${profile.level}, XP ${profile.xp}`);
  void trackEvent(
    'quiz_answer',
    { chat_id: chatId, correct, question_id: qid },
    chatId,
  );
}

export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const started = process.hrtime.bigint();
  try {
    const chatId =
      update.message?.chat?.id ??
      update.callback_query?.message?.chat?.id ??
      update.callback_query?.from?.id;

    if (await seenUpdate(update.update_id)) {
      incrementWorkerUpdatesDuplicate();
      logger.info({ update_id: update.update_id }, 'Duplicate update skipped');
      void trackEvent('update_dropped_duplicate', { update_id: update.update_id }, chatId);
      return;
    }

    const processUpdate = async () => {
      const rate = await checkRate(chatId);
      if (!rate.allowed) {
        incrementWorkerRateLimitDrop();
        logger.warn({ update_id: update.update_id, chatId, retryAfterMs: rate.retryAfterMs }, 'Rate limit drop');
        const scope = rate.scope ?? (chatId == null ? 'global' : 'chat');
        const props: Record<string, unknown> = chatId == null ? { scope } : { scope, chat_id: chatId };
        void trackEvent('ratelimit_drop', props, chatId);
        return;
      }

      if (update.message?.text) {
        await handleMessage(update.message);
        logger.info({ update_id: update.update_id, type: 'message' }, 'Handled update');
      } else if (update.callback_query?.data) {
        await handleCallback(update);
        logger.info({ update_id: update.update_id, type: 'callback' }, 'Handled update');
      } else {
        logger.info({ update_id: update.update_id, type: 'noop' }, 'Ignored update');
      }
    };

    if (chatId == null) {
      await processUpdate();
      return;
    }

    const locked = await withChatLock(chatId, processUpdate);
    if (locked === null) {
      incrementWorkerLockContention();
      logger.info({ update_id: update.update_id, chatId }, 'Lock contention, update skipped');
      void trackEvent('chat_lock_contention', { chat_id: chatId }, chatId);
    }

  } catch (err) {
    incrementWorkerErrors();
    logger.error({ err, update_id: update.update_id }, 'Failed to handle update');
  } finally {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    recordWorkerHandleDurationMs(durationMs);
  }
}
