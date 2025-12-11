import { getUserRepo, type UserRecord } from '../db/repos/userRepo.js';

const userRepo = getUserRepo();

export async function ensureUser(telegramId: number, defaults?: { username?: string; name?: string }): Promise<UserRecord> {
  return userRepo.findOrCreateByTelegramId(telegramId, defaults);
}
