import { metrics, ValueType } from '@opentelemetry/api';

const meter = metrics.getMeter('loop-backend');

export const paymentCounter = meter.createCounter('payments_total', {
  description: 'Total number of payment attempts',
  valueType: ValueType.INT
});

export const paymentAmountHistogram = meter.createHistogram('payment_amount', {
  description: 'Distribution of payment amounts',
  unit: 'cents',
  valueType: ValueType.INT
});

export const paymentLatencyHistogram = meter.createHistogram('payment_latency_ms', {
  description: 'Payment processing latency',
  unit: 'ms',
  valueType: ValueType.DOUBLE
});

export const webhookDeliveryCounter = meter.createCounter('webhook_deliveries_total', {
  description: 'Total webhook delivery attempts',
  valueType: ValueType.INT
});

export const webhookLatencyHistogram = meter.createHistogram('webhook_latency_ms', {
  description: 'Webhook delivery latency',
  unit: 'ms',
  valueType: ValueType.DOUBLE
});

export const activeRequestsGauge = meter.createUpDownCounter('http_active_requests', {
  description: 'Number of active HTTP requests',
  valueType: ValueType.INT
});

export const dbQueryHistogram = meter.createHistogram('db_query_duration_ms', {
  description: 'Database query duration',
  unit: 'ms',
  valueType: ValueType.DOUBLE
});

export function recordPaymentAttempt(
  processor: string,
  currency: string,
  status: 'success' | 'failed' | 'pending'
) {
  paymentCounter.add(1, {
    processor,
    currency,
    status
  });
}

export function recordPaymentAmount(amount: number, processor: string, currency: string) {
  paymentAmountHistogram.record(amount, {
    processor,
    currency
  });
}

export function recordWebhookDelivery(status: 'success' | 'failed', attempt: number) {
  webhookDeliveryCounter.add(1, {
    status,
    attempt: String(attempt)
  });
}
