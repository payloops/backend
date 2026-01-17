import { createClient, type TFNClient } from '@astami/temporal-functions/client';
import { context, propagation } from '@opentelemetry/api';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { getCorrelationContext } from '../lib/observability/context';

let tfnClient: TFNClient | null = null;

// Get or create the TFN client (singleton)
export function getTemporalClient(): TFNClient {
  if (tfnClient) return tfnClient;

  tfnClient = createClient({
    temporal: {
      address: env.TEMPORAL_ADDRESS,
      namespace: env.TEMPORAL_NAMESPACE
    }
  });

  logger.info({ address: env.TEMPORAL_ADDRESS }, 'Created Temporal Functions client');

  return tfnClient;
}

// Map processor names to their task queues
const PROCESSOR_TASK_QUEUES: Record<string, string> = {
  stripe: 'stripe-payments',
  razorpay: 'razorpay-payments'
};

export interface StartPaymentWorkflowInput {
  orderId: string;
  merchantId: string;
  amount: number;
  currency: string;
  processor: string;
  returnUrl?: string;
}

export async function startPaymentWorkflow(input: StartPaymentWorkflowInput): Promise<string> {
  const client = getTemporalClient();
  const correlationCtx = getCorrelationContext();

  const workflowId = `payment-${input.orderId}`;
  const taskQueue = PROCESSOR_TASK_QUEUES[input.processor] || 'stripe-payments';

  // Propagate trace context
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  // Start workflow using TFN client
  const handle = await client.start(
    {
      name: 'PaymentWorkflow',
      handler: async () => {}, // Placeholder - actual implementation is in the worker
      options: { taskQueue },
      __type: 'workflow' as const
    },
    {
      orderId: input.orderId,
      merchantId: input.merchantId,
      amount: input.amount,
      currency: input.currency,
      returnUrl: input.returnUrl
    },
    {
      workflowId,
      taskQueue,
      memo: {
        traceContext: carrier,
        correlationId: correlationCtx?.correlationId
      }
    }
  );

  logger.info(
    {
      workflowId: handle.workflowId,
      orderId: input.orderId,
      processor: input.processor,
      taskQueue,
      correlationId: correlationCtx?.correlationId
    },
    'Started payment workflow'
  );

  return handle.workflowId;
}

export interface StartWebhookDeliveryInput {
  webhookEventId: string;
  merchantId: string;
  processor: string;
  webhookUrl: string;
  payload: Record<string, unknown>;
}

export async function startWebhookDeliveryWorkflow(input: StartWebhookDeliveryInput): Promise<string> {
  const client = getTemporalClient();
  const correlationCtx = getCorrelationContext();

  const workflowId = `webhook-${input.webhookEventId}`;
  const taskQueue = PROCESSOR_TASK_QUEUES[input.processor] || 'stripe-payments';

  // Propagate trace context
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  // Start workflow using TFN client
  const handle = await client.start(
    {
      name: 'WebhookDeliveryWorkflow',
      handler: async () => {}, // Placeholder - actual implementation is in the worker
      options: { taskQueue },
      __type: 'workflow' as const
    },
    {
      webhookEventId: input.webhookEventId,
      merchantId: input.merchantId,
      webhookUrl: input.webhookUrl,
      payload: input.payload
    },
    {
      workflowId,
      taskQueue,
      memo: {
        traceContext: carrier,
        correlationId: correlationCtx?.correlationId
      }
    }
  );

  logger.info(
    {
      workflowId: handle.workflowId,
      webhookEventId: input.webhookEventId,
      processor: input.processor,
      taskQueue,
      correlationId: correlationCtx?.correlationId
    },
    'Started webhook delivery workflow'
  );

  return handle.workflowId;
}

// Signal a payment workflow (e.g., for 3DS completion)
export async function signalPaymentCompletion(
  orderId: string,
  result: { success: boolean; processorTransactionId?: string }
): Promise<void> {
  const client = getTemporalClient();
  const workflowId = `payment-${orderId}`;

  await client.signal(workflowId, 'completePayment', result);

  logger.info(
    {
      workflowId,
      orderId,
      success: result.success
    },
    'Signaled payment completion'
  );
}

// Cancel a payment workflow
export async function cancelPaymentWorkflow(orderId: string): Promise<void> {
  const client = getTemporalClient();
  const workflowId = `payment-${orderId}`;

  await client.signal(workflowId, 'cancelPayment', {});

  logger.info(
    {
      workflowId,
      orderId
    },
    'Signaled payment cancellation'
  );
}
