import { Client, Connection } from '@temporalio/client';
import { context, propagation } from '@opentelemetry/api';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { getCorrelationContext } from '../lib/observability/context';

let client: Client | null = null;

export async function getTemporalClient(): Promise<Client> {
  if (client) return client;

  const connection = await Connection.connect({
    address: env.TEMPORAL_ADDRESS
  });

  client = new Client({
    connection,
    namespace: env.TEMPORAL_NAMESPACE
  });

  logger.info({ address: env.TEMPORAL_ADDRESS }, 'Connected to Temporal');

  return client;
}

export interface StartPaymentWorkflowInput {
  orderId: string;
  merchantId: string;
  amount: number;
  currency: string;
  processor: string;
  returnUrl?: string;
}

export async function startPaymentWorkflow(input: StartPaymentWorkflowInput): Promise<string> {
  const temporal = await getTemporalClient();
  const correlationCtx = getCorrelationContext();

  const workflowId = `payment-${input.orderId}`;

  // Propagate trace context
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  const handle = await temporal.workflow.start('PaymentWorkflow', {
    taskQueue: 'payment-queue',
    workflowId,
    args: [input],
    searchAttributes: {
      CorrelationId: [correlationCtx?.correlationId || ''],
      MerchantId: [input.merchantId],
      OrderId: [input.orderId]
    },
    memo: {
      traceContext: carrier,
      correlationId: correlationCtx?.correlationId
    }
  });

  logger.info(
    {
      workflowId,
      orderId: input.orderId,
      correlationId: correlationCtx?.correlationId
    },
    'Started payment workflow'
  );

  return handle.workflowId;
}

export interface StartWebhookDeliveryInput {
  webhookEventId: string;
  merchantId: string;
  webhookUrl: string;
  payload: Record<string, unknown>;
}

export async function startWebhookDeliveryWorkflow(input: StartWebhookDeliveryInput): Promise<string> {
  const temporal = await getTemporalClient();
  const correlationCtx = getCorrelationContext();

  const workflowId = `webhook-${input.webhookEventId}`;

  // Propagate trace context
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  const handle = await temporal.workflow.start('WebhookDeliveryWorkflow', {
    taskQueue: 'webhook-queue',
    workflowId,
    args: [input],
    searchAttributes: {
      CorrelationId: [correlationCtx?.correlationId || ''],
      MerchantId: [input.merchantId],
      WebhookEventId: [input.webhookEventId]
    },
    memo: {
      traceContext: carrier,
      correlationId: correlationCtx?.correlationId
    }
  });

  logger.info(
    {
      workflowId,
      webhookEventId: input.webhookEventId,
      correlationId: correlationCtx?.correlationId
    },
    'Started webhook delivery workflow'
  );

  return handle.workflowId;
}
