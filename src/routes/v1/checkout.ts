import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db } from '../../db/client';
import { checkoutSessions, orders } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import type { AuthContext } from '../../middleware/auth';
import { getMerchant } from '../../middleware/auth';
import { logger } from '@payloops/observability';
import { env } from '../../lib/env';

const app = new Hono<AuthContext>();

const createSessionSchema = z.object({
  amount: z.number().int().positive(),
  currency: z.string().length(3).default('USD'),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  customerId: z.string().max(255).optional(),
  customerEmail: z.string().email().optional(),
  metadata: z.record(z.unknown()).optional(),
  lineItems: z
    .array(
      z.object({
        name: z.string(),
        amount: z.number().int().positive(),
        quantity: z.number().int().positive()
      })
    )
    .optional()
});

// Create checkout session
app.post('/sessions', zValidator('json', createSessionSchema), async (c) => {
  const merchant = getMerchant(c);
  const body = c.req.valid('json');

  // Set expiration to 30 minutes from now
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  const session = await db
    .insert(checkoutSessions)
    .values({
      merchantId: merchant.id,
      amount: body.amount,
      currency: body.currency,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      customerId: body.customerId,
      customerEmail: body.customerEmail,
      metadata: body.metadata || {},
      lineItems: body.lineItems || [],
      expiresAt,
      status: 'pending'
    })
    .returning();

  logger.info({ sessionId: session[0].id, merchantId: merchant.id }, 'Checkout session created');

  // Generate checkout URL
  const baseUrl = env.CHECKOUT_BASE_URL || 'http://localhost:5173';
  const checkoutUrl = `${baseUrl}/checkout/${session[0].id}`;

  return c.json(
    {
      id: session[0].id,
      url: checkoutUrl,
      expiresAt: session[0].expiresAt.toISOString()
    },
    201
  );
});

// Get checkout session
app.get('/sessions/:id', async (c) => {
  const merchant = getMerchant(c);
  const sessionId = c.req.param('id');

  const session = await db.query.checkoutSessions.findFirst({
    where: and(eq(checkoutSessions.id, sessionId), eq(checkoutSessions.merchantId, merchant.id))
  });

  if (!session) {
    return c.json({ code: 'not_found', message: 'Checkout session not found' }, 404);
  }

  const baseUrl = env.CHECKOUT_BASE_URL || 'http://localhost:5173';
  const checkoutUrl = `${baseUrl}/checkout/${session.id}`;

  return c.json({
    id: session.id,
    url: checkoutUrl,
    amount: session.amount,
    currency: session.currency,
    status: session.status,
    orderId: session.orderId,
    customerId: session.customerId,
    customerEmail: session.customerEmail,
    metadata: session.metadata,
    lineItems: session.lineItems,
    expiresAt: session.expiresAt.toISOString(),
    completedAt: session.completedAt?.toISOString() || null,
    createdAt: session.createdAt.toISOString()
  });
});

export default app;
