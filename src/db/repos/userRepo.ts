import type { User as PrismaUser } from '@prisma/client';
import { prisma } from '../prisma.js';

export interface UserRecord {
  id: number;
  telegramId: number;
  username?: string;
  name?: string;
}

export interface UserRepo {
  findOrCreateByTelegramId(
    telegramId: number,
    defaults?: { username?: string; name?: string },
  ): Promise<UserRecord>;
  findByTelegramId(telegramId: number): Promise<UserRecord | null>;
}

const DB_MODE = process.env.DB_MODE ?? (process.env.DATABASE_URL ? 'prisma' : 'memory');

function mapUser(record: PrismaUser): UserRecord {
  return {
    id: record.id,
    telegramId: Number(record.telegramId),
    username: record.username ?? undefined,
    name: record.fullName ?? undefined,
  };
}

class MemoryUserRepo implements UserRepo {
  private store: Map<number, UserRecord> = new Map();
  private seq = 1;

  async findOrCreateByTelegramId(
    telegramId: number,
    defaults?: { username?: string; name?: string },
  ): Promise<UserRecord> {
    const existing = this.store.get(telegramId);
    if (existing) return existing;
    const record: UserRecord = {
      id: this.seq++,
      telegramId,
      username: defaults?.username,
      name: defaults?.name,
    };
    this.store.set(telegramId, record);
    return record;
  }

  async findByTelegramId(telegramId: number): Promise<UserRecord | null> {
    return this.store.get(telegramId) ?? null;
  }
}

class PrismaUserRepo implements UserRepo {
  async findOrCreateByTelegramId(
    telegramId: number,
    defaults?: { username?: string; name?: string },
  ): Promise<UserRecord> {
    const user = await prisma.user.upsert({
      where: { telegramId: BigInt(telegramId) },
      create: {
        telegramId: BigInt(telegramId),
        username: defaults?.username,
        fullName: defaults?.name,
      },
      update: {
        ...(defaults?.username ? { username: defaults.username } : {}),
        ...(defaults?.name ? { fullName: defaults.name } : {}),
      },
    });
    return mapUser(user);
  }

  async findByTelegramId(telegramId: number): Promise<UserRecord | null> {
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
    });
    return user ? mapUser(user) : null;
  }
}

let userRepoInstance: UserRepo | null = null;

export function getUserRepo(): UserRepo {
  if (userRepoInstance) return userRepoInstance;
  userRepoInstance = DB_MODE === 'prisma' ? new PrismaUserRepo() : new MemoryUserRepo();
  return userRepoInstance;
}
