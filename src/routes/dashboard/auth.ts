import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db } from '../../db/client';
import { merchants } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { signJWT } from '../../lib/jwt';
import { generateWebhookSecret } from '../../lib/crypto';
import { logger } from '@payloops/observability';

const app = new Hono();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

app.post('/login', zValidator('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json');

  const merchant = await db.query.merchants.findFirst({
    where: eq(merchants.email, email.toLowerCase())
  });

  if (!merchant || !(await bcrypt.compare(password, merchant.passwordHash))) {
    return c.json({ code: 'invalid_credentials', message: 'Invalid email or password' }, 401);
  }

  const token = await signJWT({ sub: merchant.id, email: merchant.email });

  logger.info({ merchantId: merchant.id }, 'Merchant logged in');

  return c.json({
    token,
    merchant: {
      id: merchant.id,
      name: merchant.name,
      email: merchant.email,
      webhookUrl: merchant.webhookUrl,
      createdAt: merchant.createdAt,
      updatedAt: merchant.updatedAt
    }
  });
});

const registerSchema = z.object({
  name: z.string().min(2).max(255),
  email: z.string().email(),
  password: z.string().min(8).max(100)
});

app.post('/register', zValidator('json', registerSchema), async (c) => {
  const { name, email, password } = c.req.valid('json');

  // Check if email exists
  const existing = await db.query.merchants.findFirst({
    where: eq(merchants.email, email.toLowerCase())
  });

  if (existing) {
    return c.json({ code: 'email_exists', message: 'Email already registered' }, 400);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const webhookSecret = generateWebhookSecret();

  const merchant = await db
    .insert(merchants)
    .values({
      name,
      email: email.toLowerCase(),
      passwordHash,
      webhookSecret
    })
    .returning();

  const token = await signJWT({ sub: merchant[0].id, email: merchant[0].email });

  logger.info({ merchantId: merchant[0].id }, 'Merchant registered');

  return c.json(
    {
      token,
      merchant: {
        id: merchant[0].id,
        name: merchant[0].name,
        email: merchant[0].email,
        webhookUrl: merchant[0].webhookUrl,
        createdAt: merchant[0].createdAt,
        updatedAt: merchant[0].updatedAt
      }
    },
    201
  );
});

export default app;
