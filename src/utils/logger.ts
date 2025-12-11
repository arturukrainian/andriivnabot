// eslint-disable-next-line import/no-named-as-default
import pino from 'pino';

const transport =
  process.env.NODE_ENV === 'production'
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          singleLine: true,
          translateTime: 'SYS:standard',
        },
      };

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport,
  base: undefined,
});
