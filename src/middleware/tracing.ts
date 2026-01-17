import { createMiddleware } from 'hono/factory';
import { trace, SpanKind, SpanStatusCode, context } from '@opentelemetry/api';
import type { Logger } from 'pino';
import {
  extractCorrelationId,
  withCorrelationContext,
  CORRELATION_ID_HEADER,
  logger
} from '@payloops/observability';

const tracer = trace.getTracer('loop-backend');

export interface TracingContext {
  Variables: {
    correlationId: string;
    requestLogger: Logger;
  };
}

export const tracingMiddleware = createMiddleware<TracingContext>(async (c, next) => {
  const correlationId = extractCorrelationId({
    [CORRELATION_ID_HEADER.toLowerCase()]: c.req.header(CORRELATION_ID_HEADER)
  });

  c.header(CORRELATION_ID_HEADER, correlationId);

  const requestLogger = logger.child({ correlationId });
  c.set('correlationId', correlationId);
  c.set('requestLogger', requestLogger);

  const span = tracer.startSpan(`${c.req.method} ${c.req.path}`, {
    kind: SpanKind.SERVER,
    attributes: {
      'http.method': c.req.method,
      'http.url': c.req.url,
      'http.route': c.req.path,
      'http.user_agent': c.req.header('user-agent'),
      'correlation.id': correlationId
    }
  });

  const startTime = Date.now();

  try {
    await context.with(trace.setSpan(context.active(), span), async () => {
      await withCorrelationContext({ correlationId }, async () => {
        await next();
      });
    });

    span.setAttribute('http.status_code', c.res.status);

    if (c.res.status >= 400) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : 'Unknown error'
    });
    span.recordException(error as Error);
    throw error;
  } finally {
    span.setAttribute('http.response_time_ms', Date.now() - startTime);
    span.end();

    requestLogger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        duration: Date.now() - startTime
      },
      'Request completed'
    );
  }
});
