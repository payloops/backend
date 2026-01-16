import { AsyncLocalStorage } from 'async_hooks';
import { nanoid } from 'nanoid';
import { context, propagation } from '@opentelemetry/api';

export interface CorrelationContext {
  correlationId: string;
  merchantId?: string;
  orderId?: string;
  workflowId?: string;
}

const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

export const CORRELATION_ID_HEADER = 'X-Correlation-ID';
export const REQUEST_ID_HEADER = 'X-Request-ID';

export function getCorrelationContext(): CorrelationContext | undefined {
  return correlationStorage.getStore();
}

export function withCorrelationContext<T>(ctx: CorrelationContext, fn: () => T): T {
  return correlationStorage.run(ctx, fn);
}

export function generateCorrelationId(): string {
  return nanoid(21);
}

export function extractCorrelationId(headers: Record<string, string | undefined>): string {
  return (
    headers[CORRELATION_ID_HEADER.toLowerCase()] ||
    headers[REQUEST_ID_HEADER.toLowerCase()] ||
    generateCorrelationId()
  );
}

export function createPropagationHeaders(correlationId: string): Record<string, string> {
  const headers: Record<string, string> = {
    [CORRELATION_ID_HEADER]: correlationId
  };

  propagation.inject(context.active(), headers);

  return headers;
}
