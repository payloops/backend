import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../../db/client';
import { orders, transactions, processorConfigs } from '../../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import type { AuthContext } from '../../middleware/auth';
import { getMerchant } from '../../middleware/auth';
import { startPaymentWorkflow } from '../../services/temporal';
import { logger } from '../../lib/logger';

const app = new Hono<AuthContext>();

const createOrderSchema = z.object({
  amount: z.number().int().positive(),
  currency: z.string().length(3).default('USD'),
  externalId: z.string().max(255).optional(),
  customerId: z.string().max(255).optional(),
  customerEmail: z.string().email().optional(),
  description: z.string().max(1000).optional(),
  metadata: z.record(z.unknown()).optional(),
  returnUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional()
});

// Create order
app.post('/', zValidator('json', createOrderSchema), async (c) => {
  const merchant = getMerchant(c);
  const body = c.req.valid('json');

  const order = await db
    .insert(orders)
    .values({
      merchantId: merchant.id,
      externalId: body.externalId || nanoid(12),
      amount: body.amount,
      currency: body.currency,
      customerId: body.customerId,
      customerEmail: body.customerEmail,
      description: body.description,
      metadata: body.metadata || {},
      returnUrl: body.returnUrl,
      cancelUrl: body.cancelUrl,
      status: 'pending'
    })
    .returning();

  logger.info({ orderId: order[0].id, merchantId: merchant.id }, 'Order created');

  return c.json({
    id: order[0].id,
    externalId: order[0].externalId,
    amount: order[0].amount,
    currency: order[0].currency,
    status: order[0].status,
    createdAt: order[0].createdAt
  }, 201);
});

// Get order
app.get('/:id', async (c) => {
  const merchant = getMerchant(c);
  const orderId = c.req.param('id');

  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, orderId), eq(orders.merchantId, merchant.id))
  });

  if (!order) {
    return c.json({ code: 'not_found', message: 'Order not found' }, 404);
  }

  return c.json({
    id: order.id,
    externalId: order.externalId,
    amount: order.amount,
    currency: order.currency,
    status: order.status,
    processor: order.processor,
    processorOrderId: order.processorOrderId,
    metadata: order.metadata,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  });
});

const payOrderSchema = z.object({
  processor: z.enum(['stripe', 'razorpay']).optional(),
  paymentMethod: z.object({
    type: z.enum(['card', 'upi', 'netbanking', 'wallet']),
    token: z.string().optional(), // Processor token/payment method id
    card: z
      .object({
        number: z.string(),
        expMonth: z.number(),
        expYear: z.number(),
        cvc: z.string()
      })
      .optional()
  })
});

// Process payment
app.post('/:id/pay', zValidator('json', payOrderSchema), async (c) => {
  const merchant = getMerchant(c);
  const orderId = c.req.param('id');
  const body = c.req.valid('json');

  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, orderId), eq(orders.merchantId, merchant.id))
  });

  if (!order) {
    return c.json({ code: 'not_found', message: 'Order not found' }, 404);
  }

  if (order.status !== 'pending') {
    return c.json({ code: 'invalid_status', message: `Cannot process order in ${order.status} status` }, 400);
  }

  // Determine processor (routing logic)
  let processor = body.processor;

  if (!processor) {
    // Get enabled processor configs for merchant
    const configs = await db.query.processorConfigs.findMany({
      where: and(eq(processorConfigs.merchantId, merchant.id), eq(processorConfigs.enabled, true)),
      orderBy: [processorConfigs.priority]
    });

    if (configs.length === 0) {
      return c.json({ code: 'no_processor', message: 'No payment processor configured' }, 400);
    }

    // Simple routing: INR -> Razorpay, else -> Stripe
    if (order.currency === 'INR') {
      const razorpayConfig = configs.find((c) => c.processor === 'razorpay');
      processor = razorpayConfig ? 'razorpay' : configs[0].processor;
    } else {
      const stripeConfig = configs.find((c) => c.processor === 'stripe');
      processor = stripeConfig ? 'stripe' : configs[0].processor;
    }
  }

  // Update order with processor
  await db
    .update(orders)
    .set({ processor, status: 'processing', updatedAt: new Date() })
    .where(eq(orders.id, orderId));

  // Start payment workflow
  try {
    const workflowId = await startPaymentWorkflow({
      orderId: order.id,
      merchantId: merchant.id,
      amount: order.amount,
      currency: order.currency,
      processor: processor as string,
      returnUrl: order.returnUrl || undefined
    });

    await db.update(orders).set({ workflowId }).where(eq(orders.id, orderId));

    logger.info({ orderId, workflowId, processor }, 'Payment workflow started');

    return c.json({
      orderId: order.id,
      status: 'processing',
      processor,
      workflowId
    });
  } catch (error) {
    logger.error({ orderId, error }, 'Failed to start payment workflow');

    await db.update(orders).set({ status: 'failed', updatedAt: new Date() }).where(eq(orders.id, orderId));

    return c.json({ code: 'workflow_error', message: 'Failed to process payment' }, 500);
  }
});

// Get order transactions
app.get('/:id/transactions', async (c) => {
  const merchant = getMerchant(c);
  const orderId = c.req.param('id');

  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, orderId), eq(orders.merchantId, merchant.id))
  });

  if (!order) {
    return c.json({ code: 'not_found', message: 'Order not found' }, 404);
  }

  const txns = await db.query.transactions.findMany({
    where: eq(transactions.orderId, orderId),
    orderBy: [desc(transactions.createdAt)]
  });

  return c.json(
    txns.map((t) => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      status: t.status,
      processorTransactionId: t.processorTransactionId,
      errorCode: t.errorCode,
      errorMessage: t.errorMessage,
      createdAt: t.createdAt
    }))
  );
});

const refundSchema = z.object({
  amount: z.number().int().positive().optional(),
  reason: z.string().max(500).optional()
});

// Refund order
app.post('/:id/refund', zValidator('json', refundSchema), async (c) => {
  const merchant = getMerchant(c);
  const orderId = c.req.param('id');
  const body = c.req.valid('json');

  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, orderId), eq(orders.merchantId, merchant.id))
  });

  if (!order) {
    return c.json({ code: 'not_found', message: 'Order not found' }, 404);
  }

  if (!['captured', 'partially_refunded'].includes(order.status)) {
    return c.json({ code: 'invalid_status', message: `Cannot refund order in ${order.status} status` }, 400);
  }

  const refundAmount = body.amount || order.amount;

  // Create refund transaction
  const refundTxn = await db
    .insert(transactions)
    .values({
      orderId: order.id,
      type: 'refund',
      amount: refundAmount,
      status: 'pending'
    })
    .returning();

  logger.info({ orderId, refundAmount, transactionId: refundTxn[0].id }, 'Refund initiated');

  // TODO: Start refund workflow

  return c.json({
    refundId: refundTxn[0].id,
    orderId: order.id,
    amount: refundAmount,
    status: 'pending'
  }, 201);
});

export default app;
