import { Hono } from 'hono';
import Stripe from 'stripe';
import { db } from '../../db/client';
import { orders, transactions, webhookEvents, processorConfigs } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { decrypt } from '../../lib/crypto';
import { logger } from '@payloops/observability';
import { startWebhookDeliveryWorkflow, signalPaymentCompletion } from '../../services/temporal';

const app = new Hono();

app.post('/', async (c) => {
  const signature = c.req.header('stripe-signature');
  const rawBody = await c.req.text();

  if (!signature) {
    return c.json({ code: 'missing_signature', message: 'Missing Stripe signature' }, 400);
  }

  // We need to find which merchant this webhook belongs to
  // In production, you'd use Connect webhooks or have separate endpoints per merchant
  // For now, we'll parse the event and find the merchant by the payment intent metadata

  try {
    // Parse without verification first to get metadata
    const event = JSON.parse(rawBody) as Stripe.Event;

    let merchantId: string | null = null;
    let orderId: string | null = null;

    // Extract metadata from various event types
    if (event.type.startsWith('payment_intent')) {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      merchantId = paymentIntent.metadata?.merchant_id;
      orderId = paymentIntent.metadata?.order_id;
    } else if (event.type.startsWith('charge')) {
      const charge = event.data.object as Stripe.Charge;
      merchantId = charge.metadata?.merchant_id;
      orderId = charge.metadata?.order_id;
    }

    if (!merchantId) {
      logger.warn({ eventId: event.id, type: event.type }, 'Webhook without merchant_id metadata');
      return c.json({ received: true });
    }

    // Get merchant's Stripe config for signature verification
    const config = await db.query.processorConfigs.findFirst({
      where: and(eq(processorConfigs.merchantId, merchantId), eq(processorConfigs.processor, 'stripe'))
    });

    if (!config) {
      logger.warn({ merchantId }, 'No Stripe config found for merchant');
      return c.json({ code: 'no_config', message: 'Merchant not configured for Stripe' }, 400);
    }

    const credentials = JSON.parse(decrypt(config.credentialsEncrypted));
    const webhookSecret = credentials.webhookSecret;

    if (webhookSecret) {
      // Verify signature
      const stripe = new Stripe(credentials.secretKey);
      try {
        stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
      } catch (err) {
        logger.error({ merchantId, error: err }, 'Invalid webhook signature');
        return c.json({ code: 'invalid_signature', message: 'Invalid signature' }, 400);
      }
    }

    // Process the event
    await processStripeEvent(event, merchantId, orderId);

    return c.json({ received: true });
  } catch (error) {
    logger.error({ error }, 'Failed to process Stripe webhook');
    return c.json({ code: 'processing_error', message: 'Failed to process webhook' }, 500);
  }
});

async function processStripeEvent(event: Stripe.Event, merchantId: string, orderId: string | null) {
  logger.info({ eventId: event.id, type: event.type, merchantId, orderId }, 'Processing Stripe event');

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      if (orderId) {
        // Check if order has an active workflow (requires_action status means waiting for 3DS)
        const order = await db.query.orders.findFirst({
          where: eq(orders.id, orderId)
        });

        if (order?.workflowId && order.status === 'requires_action') {
          // Signal the workflow to complete - workflow will handle DB updates
          try {
            await signalPaymentCompletion(orderId, {
              success: true,
              processorTransactionId: paymentIntent.id
            });
            logger.info({ orderId, workflowId: order.workflowId }, 'Signaled payment completion to workflow');
          } catch (error) {
            // Workflow might have already completed or timed out - update DB directly
            logger.warn({ orderId, error }, 'Failed to signal workflow, updating DB directly');
            await updateOrderStatusDirectly(orderId, 'captured', paymentIntent);
          }
        } else {
          // No active workflow waiting - update directly (e.g., direct charge without 3DS)
          await updateOrderStatusDirectly(orderId, 'captured', paymentIntent);
        }
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      if (orderId) {
        const order = await db.query.orders.findFirst({
          where: eq(orders.id, orderId)
        });

        if (order?.workflowId && order.status === 'requires_action') {
          // Signal the workflow to fail
          try {
            await signalPaymentCompletion(orderId, {
              success: false,
              processorTransactionId: paymentIntent.id
            });
            logger.info({ orderId, workflowId: order.workflowId }, 'Signaled payment failure to workflow');
          } catch (error) {
            logger.warn({ orderId, error }, 'Failed to signal workflow, updating DB directly');
            await updateOrderFailedDirectly(orderId, paymentIntent);
          }
        } else {
          await updateOrderFailedDirectly(orderId, paymentIntent);
        }
      }
      break;
    }

    case 'charge.refunded': {
      // Refunds don't use workflows - update directly
      const charge = event.data.object as Stripe.Charge;
      if (orderId) {
        const refundAmount = charge.amount_refunded;
        const isFullRefund = refundAmount >= charge.amount;

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
          amount: refundAmount,
          status: 'success',
          processorTransactionId: charge.id
        });
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
    const webhookEvent = await db
      .insert(webhookEvents)
      .values({
        merchantId,
        orderId,
        eventType: `payment.${event.type.replace('payment_intent.', '').replace('charge.', '')}`,
        payload: {
          orderId,
          externalId: order.externalId,
          amount: order.amount,
          currency: order.currency,
          status: order.status,
          processor: 'stripe',
          processorEventId: event.id,
          processorEventType: event.type
        },
        status: 'pending'
      })
      .returning();

    // Start webhook delivery workflow
    await startWebhookDeliveryWorkflow({
      webhookEventId: webhookEvent[0].id,
      merchantId,
      processor: 'stripe',
      webhookUrl: order.merchant.webhookUrl,
      payload: webhookEvent[0].payload as Record<string, unknown>
    });
  }
}

// Helper function for direct DB updates when no workflow is waiting
async function updateOrderStatusDirectly(
  orderId: string,
  status: string,
  paymentIntent: Stripe.PaymentIntent
) {
  await db
    .update(orders)
    .set({
      status,
      processorOrderId: paymentIntent.id,
      updatedAt: new Date()
    })
    .where(eq(orders.id, orderId));

  await db.insert(transactions).values({
    orderId,
    type: 'capture',
    amount: paymentIntent.amount,
    status: 'success',
    processorTransactionId: paymentIntent.id,
    processorResponse: paymentIntent as unknown as Record<string, unknown>
  });
}

async function updateOrderFailedDirectly(orderId: string, paymentIntent: Stripe.PaymentIntent) {
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
    amount: paymentIntent.amount,
    status: 'failed',
    processorTransactionId: paymentIntent.id,
    errorCode: paymentIntent.last_payment_error?.code,
    errorMessage: paymentIntent.last_payment_error?.message
  });
}

export default app;
