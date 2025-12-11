import { Redis } from '@upstash/redis';
import IORedis from 'ioredis';

function log(msg) {
  console.log(msg);
}

const url = process.env.REDIS_URL;
const token = process.env.REDIS_TOKEN;

async function main() {
  if (!url) {
    console.error('REDIS_URL is missing');
    process.exit(1);
  }

  let client;
  let mode = 'upstash';

  if (url.startsWith('redis://') || url.startsWith('rediss://')) {
    mode = 'ioredis';
    client = new IORedis(url);
  } else {
    client = new Redis(token ? { url, token } : { url });
  }

  const key = `probe:${Date.now()}`;
  const value = 'ok';

  try {
    if (mode === 'ioredis') {
      await client.set(key, value, 'EX', 5);
      const res = await client.get(key);
      log(`redis ok: ${res === value ? 'YES' : 'NO'}`);
    } else {
      await client.set(key, value, { ex: 5 });
      const res = await client.get(key);
      log(`redis ok: ${res === value ? 'YES' : 'NO'}`);
    }
  } catch (err) {
    console.error('redis ok: NO', err);
    process.exit(1);
  } finally {
    if (mode === 'ioredis') {
      client.disconnect();
    }
  }
}

main().catch((err) => {
  console.error('redis ok: NO', err);
  process.exit(1);
});
