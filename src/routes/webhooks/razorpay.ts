import { Hono } from 'hono';
import crypto from 'crypto';
import { db } from '../../db/client';
import { orders, transactions, webhookEvents, processorConfigs } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { decrypt } from '../../lib/crypto';
import { logger } from '@payloops/observability';
import { startWebhookDeliveryWorkflow, signalPaymentCompletion } from '../../services/temporal';

const app = new Hono();

interface RazorpayWebhookPayload {
  entity: string;
  account_id: string;
  event: string;
  contains: string[];
  payload: {
    payment?: {
      entity: {
        id: string;
        amount: number;
        currency: string;
        status: string;
        order_id: string;
        method: string;
        notes: Record<string, string>;
        error_code?: string;
        error_description?: string;
      };
    };
    refund?: {
      entity: {
        id: string;
        amount: number;
        payment_id: string;
        notes: Record<string, string>;
      };
    };
  };
  created_at: number;
}

app.post('/', async (c) => {
  const signature = c.req.header('x-razorpay-signature');
  const rawBody = await c.req.text();

  if (!signature) {
    return c.json({ code: 'missing_signature', message: 'Missing Razorpay signature' }, 400);
  }

  try {
    const payload: RazorpayWebhookPayload = JSON.parse(rawBody);

    // Extract merchant_id and order_id from notes
    let merchantId: string | null = null;
    let orderId: string | null = null;

    if (payload.payload.payment) {
      merchantId = payload.payload.payment.entity.notes?.merchant_id;
      orderId = payload.payload.payment.entity.notes?.order_id;
    } else if (payload.payload.refund) {
      merchantId = payload.payload.refund.entity.notes?.merchant_id;
      orderId = payload.payload.refund.entity.notes?.order_id;
    }

    if (!merchantId) {
      logger.warn({ event: payload.event }, 'Webhook without merchant_id in notes');
      return c.json({ received: true });
    }

    // Get merchant's Razorpay config for signature verification
    const config = await db.query.processorConfigs.findFirst({
      where: and(eq(processorConfigs.merchantId, merchantId), eq(processorConfigs.processor, 'razorpay'))
    });

    if (!config) {
      logger.warn({ merchantId }, 'No Razorpay config found for merchant');
      return c.json({ code: 'no_config', message: 'Merchant not configured for Razorpay' }, 400);
    }

    const credentials = JSON.parse(decrypt(config.credentialsEncrypted));
    const webhookSecret = credentials.webhookSecret;

    if (webhookSecret) {
      // Verify signature
      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex');

      if (signature !== expectedSignature) {
        logger.error({ merchantId }, 'Invalid webhook signature');
        return c.json({ code: 'invalid_signature', message: 'Invalid signature' }, 400);
      }
    }

    // Process the event
    await processRazorpayEvent(payload, merchantId, orderId);

    return c.json({ received: true });
  } catch (error) {
    logger.error({ error }, 'Failed to process Razorpay webhook');
    return c.json({ code: 'processing_error', message: 'Failed to process webhook' }, 500);
  }
});

async function processRazorpayEvent(
  payload: RazorpayWebhookPayload,
  merchantId: string,
  orderId: string | null
) {
  logger.info({ event: payload.event, merchantId, orderId }, 'Processing Razorpay event');

  switch (payload.event) {
    case 'payment.captured': {
      const payment = payload.payload.payment!.entity;
      if (orderId) {
        // Check if order has an active workflow (requires_action status means waiting for 3DS/redirect)
        const order = await db.query.orders.findFirst({
          where: eq(orders.id, orderId)
        });

        if (order?.workflowId && order.status === 'requires_action') {
          // Signal the workflow to complete - workflow will handle DB updates
          try {
            await signalPaymentCompletion(orderId, {
              success: true,
              processorTransactionId: payment.id
            });
            logger.info({ orderId, workflowId: order.workflowId }, 'Signaled payment completion to workflow');
          } catch (error) {
            // Workflow might have already completed or timed out - update DB directly
            logger.warn({ orderId, error }, 'Failed to signal workflow, updating DB directly');
            await updateOrderStatusDirectly(orderId, 'captured', payment);
          }
        } else {
          // No active workflow waiting - update directly (e.g., direct charge without 3DS)
          await updateOrderStatusDirectly(orderId, 'captured', payment);
        }
      }
      break;
    }

    case 'payment.failed': {
      const payment = payload.payload.payment!.entity;
      if (orderId) {
        const order = await db.query.orders.findFirst({
          where: eq(orders.id, orderId)
        });

        if (order?.workflowId && order.status === 'requires_action') {
          // Signal the workflow to fail
          try {
            await signalPaymentCompletion(orderId, {
              success: false,
              processorTransactionId: payment.id
            });
            logger.info({ orderId, workflowId: order.workflowId }, 'Signaled payment failure to workflow');
          } catch (error) {
            logger.warn({ orderId, error }, 'Failed to signal workflow, updating DB directly');
            await updateOrderFailedDirectly(orderId, payment);
          }
        } else {
          await updateOrderFailedDirectly(orderId, payment);
        }
      }
      break;
    }

    case 'refund.processed': {
      const refund = payload.payload.refund!.entity;
      if (orderId) {
        const order = await db.query.orders.findFirst({
          where: eq(orders.id, orderId)
        });

        if (order) {
          const isFullRefund = refund.amount >= order.amount;

          await db
            .update(orders)
            .set({
              status: isFullRefund ? 'refunded' : 'partially_refunded',
              updatedAt: new Date()
            })
            .where(eq(orders.id, orderId));

          await db.insert(transactions).values({
            orderId,
            type: 'refund',
            amount: refund.amount,
            status: 'success',
            processorTransactionId: refund.id
          });
        }
      }
      break;
    }
  }

  // Create webhook event for merchant notification
  const order = orderId
    ? await db.query.orders.findFirst({
        where: eq(orders.id, orderId),
        with: { merchant: true }
      })
    : null;

  if (order?.merchant.webhookUrl) {
    const eventType = payload.event.replace('payment.', '').replace('refund.', 'refund_');

    const webhookEvent = await db
      .insert(webhookEvents)
      .values({
        merchantId,
        orderId,
        eventType: `payment.${eventType}`,
        payload: {
          orderId,
          externalId: order.externalId,
          amount: order.amount,
          currency: order.currency,
          status: order.status,
          processor: 'razorpay',
          processorEvent: payload.event
        },
        status: 'pending'
      })
      .returning();

    // Start webhook delivery workflow
    await startWebhookDeliveryWorkflow({
      webhookEventId: webhookEvent[0].id,
      merchantId,
      processor: 'razorpay',
      webhookUrl: order.merchant.webhookUrl,
      payload: webhookEvent[0].payload as Record<string, unknown>
    });
  }
}

// Helper function for direct DB updates when no workflow is waiting
interface RazorpayPaymentEntity {
  id: string;
  amount: number;
  error_code?: string;
  error_description?: string;
}

async function updateOrderStatusDirectly(
  orderId: string,
  status: string,
  payment: RazorpayPaymentEntity
) {
  await db
    .update(orders)
    .set({
      status,
      processorOrderId: payment.id,
      updatedAt: new Date()
    })
    .where(eq(orders.id, orderId));

  await db.insert(transactions).values({
    orderId,
    type: 'capture',
    amount: payment.amount,
    status: 'success',
    processorTransactionId: payment.id,
    processorResponse: payment as unknown as Record<string, unknown>
  });
}

async function updateOrderFailedDirectly(orderId: string, payment: RazorpayPaymentEntity) {
  await db
    .update(orders)
    .set({
      status: 'failed',
      updatedAt: new Date()
    })
    .where(eq(orders.id, orderId));

  await db.insert(transactions).values({
    orderId,
    type: 'authorization',
    amount: payment.amount,
    status: 'failed',
    processorTransactionId: payment.id,
    errorCode: payment.error_code,
    errorMessage: payment.error_description
  });
}

export default app;
