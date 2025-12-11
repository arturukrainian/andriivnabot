import { createRequire } from 'node:module';
import { logger } from './logger.js';
import { incrementAnalyticsEvent, incrementAnalyticsErrors } from './metrics.js';

type PosthogClient = {
  capture: (event: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
  }) => Promise<void> | void;
};

const require = createRequire(import.meta.url);

let enabled = false;
let analyticsDebug = false;
let client: PosthogClient | null = null;

export function initAnalytics(): void {
  analyticsDebug = process.env.ANALYTICS_DEBUG === '1';
  const shouldEnable = process.env.ANALYTICS_ENABLED === '1';
  const key = process.env.POSTHOG_API_KEY;
  const host = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

  if (!shouldEnable || !key) {
    enabled = false;
    client = null;
    logger.info('Analytics disabled or missing key; running in no-op mode');
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment
    const { PostHog } = require('posthog-node');
    client = new PostHog(key, { host, flushAt: 1 });
    enabled = true;
    logger.info({ host }, 'Analytics initialized (PostHog)');
  } catch (err) {
    enabled = false;
    client = null;
    incrementAnalyticsErrors();
    logger.warn({ err }, 'Analytics init failed; disabling');
  }
}

export async function trackEvent(
  name: string,
  props: Record<string, unknown> = {},
  userId?: string | number,
): Promise<void> {
  if (!enabled || !client) return;

  try {
    await client.capture({
      distinctId: userId != null ? String(userId) : 'anonymous',
      event: name,
      properties: props,
    });
    incrementAnalyticsEvent(name);
    if (analyticsDebug) {
      logger.debug({ name, props, userId }, 'Analytics event tracked');
    }
  } catch (err) {
    incrementAnalyticsErrors();
    logger.warn({ err, name }, 'Analytics send failed');
  }
}
