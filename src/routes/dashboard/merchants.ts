import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db } from '../../db/client';
import { merchants, apiKeys, processorConfigs, orders, transactions } from '../../db/schema';
import { eq, and, desc, sql, gte, count, sum } from 'drizzle-orm';
import type { AuthContext } from '../../middleware/auth';
import { getMerchant, authMiddleware } from '../../middleware/auth';
import { generateApiKey, hashApiKey, encrypt, decrypt } from '../../lib/crypto';
import { logger } from '@payloops/observability';

const app = new Hono<AuthContext>();

app.use('*', authMiddleware);

// Get current merchant
app.get('/me', async (c) => {
  const merchant = getMerchant(c);

  return c.json({
    id: merchant.id,
    name: merchant.name,
    email: merchant.email,
    webhookUrl: merchant.webhookUrl,
    createdAt: merchant.createdAt,
    updatedAt: merchant.updatedAt
  });
});

const updateMerchantSchema = z.object({
  name: z.string().min(2).max(255).optional(),
  webhookUrl: z.string().url().nullable().optional()
});

// Update merchant
app.put('/me', zValidator('json', updateMerchantSchema), async (c) => {
  const merchant = getMerchant(c);
  const body = c.req.valid('json');

  const updated = await db
    .update(merchants)
    .set({
      ...body,
      updatedAt: new Date()
    })
    .where(eq(merchants.id, merchant.id))
    .returning();

  return c.json({
    id: updated[0].id,
    name: updated[0].name,
    email: updated[0].email,
    webhookUrl: updated[0].webhookUrl,
    createdAt: updated[0].createdAt,
    updatedAt: updated[0].updatedAt
  });
});

// Dashboard stats
app.get('/dashboard/stats', async (c) => {
  const merchant = getMerchant(c);
  const fromParam = c.req.query('from');
  const toParam = c.req.query('to');

  const from = fromParam ? new Date(fromParam) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to = toParam ? new Date(toParam) : new Date();

  // Get aggregated stats
  const statsResult = await db
    .select({
      totalVolume: sum(orders.amount),
      totalTransactions: count(orders.id)
    })
    .from(orders)
    .where(
      and(
        eq(orders.merchantId, merchant.id),
        eq(orders.status, 'captured'),
        gte(orders.createdAt, from)
      )
    );

  const successCount = await db
    .select({ count: count() })
    .from(orders)
    .where(
      and(
        eq(orders.merchantId, merchant.id),
        eq(orders.status, 'captured'),
        gte(orders.createdAt, from)
      )
    );

  const totalCount = await db
    .select({ count: count() })
    .from(orders)
    .where(and(eq(orders.merchantId, merchant.id), gte(orders.createdAt, from)));

  const successRate =
    totalCount[0].count > 0 ? (successCount[0].count / totalCount[0].count) * 100 : 0;

  const totalVolume = Number(statsResult[0].totalVolume) || 0;
  const totalTransactions = Number(statsResult[0].totalTransactions) || 0;
  const averageTicket = totalTransactions > 0 ? totalVolume / totalTransactions : 0;

  // Transactions by status
  const byStatus = await db
    .select({
      status: orders.status,
      count: count()
    })
    .from(orders)
    .where(and(eq(orders.merchantId, merchant.id), gte(orders.createdAt, from)))
    .groupBy(orders.status);

  // Transactions by processor
  const byProcessor = await db
    .select({
      processor: orders.processor,
      count: count()
    })
    .from(orders)
    .where(and(eq(orders.merchantId, merchant.id), gte(orders.createdAt, from)))
    .groupBy(orders.processor);

  return c.json({
    totalVolume,
    totalTransactions,
    successRate,
    averageTicket,
    volumeByDay: [], // TODO: implement daily breakdown
    transactionsByStatus: byStatus.map((s) => ({ status: s.status, count: Number(s.count) })),
    transactionsByProcessor: byProcessor
      .filter((p) => p.processor)
      .map((p) => ({ processor: p.processor, count: Number(p.count) }))
  });
});

// List orders
app.get('/orders', async (c) => {
  const merchant = getMerchant(c);
  const page = parseInt(c.req.query('page') || '1');
  const limit = Math.min(parseInt(c.req.query('limit') || '25'), 100);
  const status = c.req.query('status');

  const offset = (page - 1) * limit;

  let whereClause = eq(orders.merchantId, merchant.id);
  if (status) {
    whereClause = and(whereClause, eq(orders.status, status)) as typeof whereClause;
  }

  const [ordersList, totalResult] = await Promise.all([
    db.query.orders.findMany({
      where: whereClause,
      orderBy: [desc(orders.createdAt)],
      limit,
      offset
    }),
    db.select({ count: count() }).from(orders).where(whereClause)
  ]);

  const total = totalResult[0].count;

  return c.json({
    data: ordersList.map((o) => ({
      id: o.id,
      externalId: o.externalId,
      amount: o.amount,
      currency: o.currency,
      status: o.status,
      processor: o.processor,
      processorOrderId: o.processorOrderId,
      metadata: o.metadata,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  });
});

// API Keys
app.get('/api-keys', async (c) => {
  const merchant = getMerchant(c);

  const keys = await db.query.apiKeys.findMany({
    where: eq(apiKeys.merchantId, merchant.id),
    orderBy: [desc(apiKeys.createdAt)]
  });

  return c.json(
    keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
      createdAt: k.createdAt
    }))
  );
});

const createApiKeySchema = z.object({
  name: z.string().min(1).max(255),
  expiresAt: z.string().datetime().optional()
});

app.post('/api-keys', zValidator('json', createApiKeySchema), async (c) => {
  const merchant = getMerchant(c);
  const { name, expiresAt } = c.req.valid('json');

  const { key, prefix } = generateApiKey();
  const keyHash = hashApiKey(key);

  const apiKey = await db
    .insert(apiKeys)
    .values({
      merchantId: merchant.id,
      name,
      keyHash,
      prefix,
      expiresAt: expiresAt ? new Date(expiresAt) : null
    })
    .returning();

  logger.info({ merchantId: merchant.id, apiKeyId: apiKey[0].id }, 'API key created');

  return c.json(
    {
      apiKey: {
        id: apiKey[0].id,
        name: apiKey[0].name,
        prefix: apiKey[0].prefix,
        expiresAt: apiKey[0].expiresAt,
        createdAt: apiKey[0].createdAt
      },
      secret: key
    },
    201
  );
});

app.delete('/api-keys/:id', async (c) => {
  const merchant = getMerchant(c);
  const id = c.req.param('id');

  await db.delete(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.merchantId, merchant.id)));

  logger.info({ merchantId: merchant.id, apiKeyId: id }, 'API key revoked');

  return c.body(null, 204);
});

// Processor configs
app.get('/processors', async (c) => {
  const merchant = getMerchant(c);

  const configs = await db.query.processorConfigs.findMany({
    where: eq(processorConfigs.merchantId, merchant.id)
  });

  return c.json(
    configs.map((config) => ({
      id: config.id,
      processor: config.processor,
      enabled: config.enabled,
      priority: config.priority,
      testMode: config.testMode,
      createdAt: config.createdAt
    }))
  );
});

const configureProcessorSchema = z.object({
  credentials: z.record(z.string()),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(1).max(100).default(1),
  testMode: z.boolean().default(true)
});

app.post('/processors/:processor', zValidator('json', configureProcessorSchema), async (c) => {
  const merchant = getMerchant(c);
  const processor = c.req.param('processor');
  const { credentials, enabled, priority, testMode } = c.req.valid('json');

  if (!['stripe', 'razorpay'].includes(processor)) {
    return c.json({ code: 'invalid_processor', message: 'Invalid processor' }, 400);
  }

  const encryptedCredentials = encrypt(JSON.stringify(credentials));

  // Upsert config
  const existing = await db.query.processorConfigs.findFirst({
    where: and(eq(processorConfigs.merchantId, merchant.id), eq(processorConfigs.processor, processor))
  });

  let config;
  if (existing) {
    config = await db
      .update(processorConfigs)
      .set({
        credentialsEncrypted: encryptedCredentials,
        enabled,
        priority,
        testMode,
        updatedAt: new Date()
      })
      .where(eq(processorConfigs.id, existing.id))
      .returning();
  } else {
    config = await db
      .insert(processorConfigs)
      .values({
        merchantId: merchant.id,
        processor,
        credentialsEncrypted: encryptedCredentials,
        enabled,
        priority,
        testMode
      })
      .returning();
  }

  logger.info({ merchantId: merchant.id, processor }, 'Processor configured');

  return c.json({
    id: config[0].id,
    processor: config[0].processor,
    enabled: config[0].enabled,
    priority: config[0].priority,
    testMode: config[0].testMode,
    createdAt: config[0].createdAt
  });
});

app.patch('/processors/:processor', async (c) => {
  const merchant = getMerchant(c);
  const processor = c.req.param('processor');
  const body = await c.req.json();

  await db
    .update(processorConfigs)
    .set({
      enabled: body.enabled,
      priority: body.priority,
      testMode: body.testMode,
      updatedAt: new Date()
    })
    .where(and(eq(processorConfigs.merchantId, merchant.id), eq(processorConfigs.processor, processor)));

  return c.json({ success: true });
});

app.delete('/processors/:processor', async (c) => {
  const merchant = getMerchant(c);
  const processor = c.req.param('processor');

  await db
    .delete(processorConfigs)
    .where(and(eq(processorConfigs.merchantId, merchant.id), eq(processorConfigs.processor, processor)));

  return c.body(null, 204);
});

export default app;
