import { getProfileRepo, type ProfileRecord } from '../db/repos/profileRepo.js';

const profileRepo = getProfileRepo();

const XP_PER_CORRECT = 10;
const XP_PER_LEVEL = 100;

export async function getOrInitProfile(telegramId: number): Promise<ProfileRecord> {
  const existing = await profileRepo.getProfile(telegramId);
  if (existing) return existing;
  const fresh: ProfileRecord = { telegramId, level: 1, xp: 0 };
  await profileRepo.setProfile(telegramId, { level: fresh.level, xp: fresh.xp });
  return fresh;
}

export async function addQuizResult(
  telegramId: number,
  correct: boolean,
): Promise<ProfileRecord> {
  const profile = await getOrInitProfile(telegramId);
  if (correct) {
    let xp = profile.xp + XP_PER_CORRECT;
    let level = profile.level;
    if (xp >= XP_PER_LEVEL) {
      level += Math.floor(xp / XP_PER_LEVEL);
      xp = xp % XP_PER_LEVEL;
    }
    await profileRepo.setProfile(telegramId, { level, xp });
    return { telegramId, level, xp };
  }
  return profile;
}
