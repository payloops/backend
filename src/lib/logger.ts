import pino from 'pino';
import { trace } from '@opentelemetry/api';
import { env } from './env';

const traceMixin = () => {
  const span = trace.getActiveSpan();
  if (!span) return {};

  const spanContext = span.spanContext();
  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId
  };
};

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  mixin: traceMixin,
  base: {
    service: env.OTEL_SERVICE_NAME,
    env: env.NODE_ENV
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport:
    env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true
          }
        }
      : undefined
});
