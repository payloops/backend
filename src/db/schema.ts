import { pgTable, text, timestamp, integer, boolean, jsonb, varchar, index, uuid } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const merchants = pgTable('merchants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  webhookUrl: text('webhook_url'),
  webhookSecret: text('webhook_secret'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    keyHash: text('key_hash').notNull(),
    prefix: varchar('prefix', { length: 12 }).notNull(),
    lastUsedAt: timestamp('last_used_at'),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').defaultNow().notNull()
  },
  (table) => [index('api_keys_merchant_id_idx').on(table.merchantId)]
);

export const processorConfigs = pgTable(
  'processor_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    processor: varchar('processor', { length: 50 }).notNull(), // stripe, razorpay
    credentialsEncrypted: text('credentials_encrypted').notNull(),
    priority: integer('priority').notNull().default(1),
    enabled: boolean('enabled').notNull().default(true),
    testMode: boolean('test_mode').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull()
  },
  (table) => [index('processor_configs_merchant_id_idx').on(table.merchantId)]
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    externalId: varchar('external_id', { length: 255 }).notNull(),
    amount: integer('amount').notNull(), // in smallest currency unit (cents, paise)
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    status: varchar('status', { length: 50 }).notNull().default('pending'),
    processor: varchar('processor', { length: 50 }),
    processorOrderId: varchar('processor_order_id', { length: 255 }),
    metadata: jsonb('metadata').default({}),
    customerId: varchar('customer_id', { length: 255 }),
    customerEmail: varchar('customer_email', { length: 255 }),
    description: text('description'),
    returnUrl: text('return_url'),
    cancelUrl: text('cancel_url'),
    workflowId: varchar('workflow_id', { length: 255 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull()
  },
  (table) => [
    index('orders_merchant_id_idx').on(table.merchantId),
    index('orders_external_id_idx').on(table.externalId),
    index('orders_status_idx').on(table.status),
    index('orders_created_at_idx').on(table.createdAt)
  ]
);

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 50 }).notNull(), // authorization, capture, refund, void
    amount: integer('amount').notNull(),
    status: varchar('status', { length: 50 }).notNull().default('pending'),
    processorTransactionId: varchar('processor_transaction_id', { length: 255 }),
    processorResponse: jsonb('processor_response'),
    errorCode: varchar('error_code', { length: 100 }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at').defaultNow().notNull()
  },
  (table) => [index('transactions_order_id_idx').on(table.orderId)]
);

export const checkoutSessions = pgTable(
  'checkout_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    amount: integer('amount').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    status: varchar('status', { length: 50 }).notNull().default('pending'),
    successUrl: text('success_url').notNull(),
    cancelUrl: text('cancel_url').notNull(),
    customerId: varchar('customer_id', { length: 255 }),
    customerEmail: varchar('customer_email', { length: 255 }),
    metadata: jsonb('metadata').default({}),
    lineItems: jsonb('line_items').default([]),
    expiresAt: timestamp('expires_at').notNull(),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull()
  },
  (table) => [
    index('checkout_sessions_merchant_id_idx').on(table.merchantId),
    index('checkout_sessions_status_idx').on(table.status)
  ]
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    payload: jsonb('payload').notNull(),
    status: varchar('status', { length: 50 }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at'),
    nextRetryAt: timestamp('next_retry_at'),
    deliveredAt: timestamp('delivered_at'),
    workflowId: varchar('workflow_id', { length: 255 }),
    createdAt: timestamp('created_at').defaultNow().notNull()
  },
  (table) => [
    index('webhook_events_merchant_id_idx').on(table.merchantId),
    index('webhook_events_status_idx').on(table.status),
    index('webhook_events_next_retry_at_idx').on(table.nextRetryAt)
  ]
);

// Relations
export const merchantsRelations = relations(merchants, ({ many }) => ({
  apiKeys: many(apiKeys),
  processorConfigs: many(processorConfigs),
  orders: many(orders),
  webhookEvents: many(webhookEvents)
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  merchant: one(merchants, {
    fields: [apiKeys.merchantId],
    references: [merchants.id]
  })
}));

export const processorConfigsRelations = relations(processorConfigs, ({ one }) => ({
  merchant: one(merchants, {
    fields: [processorConfigs.merchantId],
    references: [merchants.id]
  })
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  merchant: one(merchants, {
    fields: [orders.merchantId],
    references: [merchants.id]
  }),
  transactions: many(transactions),
  webhookEvents: many(webhookEvents),
  checkoutSessions: many(checkoutSessions)
}));

export const checkoutSessionsRelations = relations(checkoutSessions, ({ one }) => ({
  merchant: one(merchants, {
    fields: [checkoutSessions.merchantId],
    references: [merchants.id]
  }),
  order: one(orders, {
    fields: [checkoutSessions.orderId],
    references: [orders.id]
  })
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  order: one(orders, {
    fields: [transactions.orderId],
    references: [orders.id]
  })
}));

export const webhookEventsRelations = relations(webhookEvents, ({ one }) => ({
  merchant: one(merchants, {
    fields: [webhookEvents.merchantId],
    references: [merchants.id]
  }),
  order: one(orders, {
    fields: [webhookEvents.orderId],
    references: [orders.id]
  })
}));

// Types
export type Merchant = typeof merchants.$inferSelect;
export type NewMerchant = typeof merchants.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type ProcessorConfig = typeof processorConfigs.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type CheckoutSession = typeof checkoutSessions.$inferSelect;
export type NewCheckoutSession = typeof checkoutSessions.$inferInsert;
