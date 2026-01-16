import { Client, Connection } from '@temporalio/client';
import { env } from '../lib/env';
import { logger } from '../lib/logger';

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

  const workflowId = `payment-${input.orderId}`;

  const handle = await temporal.workflow.start('PaymentWorkflow', {
    taskQueue: 'payment-queue',
    workflowId,
    args: [input]
  });

  logger.info({ workflowId, orderId: input.orderId }, 'Started payment workflow');

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

  const workflowId = `webhook-${input.webhookEventId}`;

  const handle = await temporal.workflow.start('WebhookDeliveryWorkflow', {
    taskQueue: 'webhook-queue',
    workflowId,
    args: [input]
  });

  logger.info({ workflowId, webhookEventId: input.webhookEventId }, 'Started webhook delivery workflow');

  return handle.workflowId;
}
