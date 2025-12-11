import type { User as PrismaUser } from '@prisma/client';
import { prisma } from '../prisma.js';

export interface ProfileRecord {
  telegramId: number;
  level: number;
  xp: number;
}

export interface ProfileRepo {
  getProfile(telegramId: number): Promise<ProfileRecord | null>;
  setProfile(telegramId: number, profile: { level: number; xp: number }): Promise<void>;
}

const DB_MODE = process.env.DB_MODE ?? (process.env.DATABASE_URL ? 'prisma' : 'memory');

class MemoryProfileRepo implements ProfileRepo {
  private store: Map<number, ProfileRecord> = new Map();

  async getProfile(telegramId: number): Promise<ProfileRecord | null> {
    return this.store.get(telegramId) ?? null;
  }

  async setProfile(telegramId: number, profile: { level: number; xp: number }): Promise<void> {
    this.store.set(telegramId, { telegramId, ...profile });
  }
}

function mapProfile(user: PrismaUser): ProfileRecord {
  return {
    telegramId: Number(user.telegramId),
    level: user.level,
    xp: user.xp,
  };
}

class PrismaProfileRepo implements ProfileRepo {
  async getProfile(telegramId: number): Promise<ProfileRecord | null> {
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
    if (!user) return null;
    return mapProfile(user);
  }

  async setProfile(telegramId: number, profile: { level: number; xp: number }): Promise<void> {
    await prisma.user.upsert({
      where: { telegramId: BigInt(telegramId) },
      create: {
        telegramId: BigInt(telegramId),
        level: profile.level,
        xp: profile.xp,
      },
      update: {
        level: profile.level,
        xp: profile.xp,
      },
    });
  }
}

let profileRepoInstance: ProfileRepo | null = null;

export function getProfileRepo(): ProfileRepo {
  if (profileRepoInstance) return profileRepoInstance;
  profileRepoInstance = DB_MODE === 'prisma' ? new PrismaProfileRepo() : new MemoryProfileRepo();
  return profileRepoInstance;
}
