import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';

import { env } from './lib/env';
import { logger } from './lib/logger';
import { authMiddleware } from './middleware/auth';

// Routes
import authRoutes from './routes/dashboard/auth';
import merchantRoutes from './routes/dashboard/merchants';
import orderRoutes from './routes/v1/orders';
import stripeWebhooks from './routes/webhooks/stripe';
import razorpayWebhooks from './routes/webhooks/razorpay';

const app = new Hono();

// Global middleware
app.use('*', honoLogger());
app.use('*', prettyJSON());
app.use(
  '*',
  cors({
    origin: env.CORS_ORIGINS.split(','),
    credentials: true
  })
);

// Health check
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Auth routes (public)
app.route('/api/auth', authRoutes);

// Dashboard routes (JWT auth)
app.route('/api', merchantRoutes);

// Public API routes (API key auth)
app.use('/v1/*', authMiddleware);
app.route('/v1/orders', orderRoutes);

// Webhook routes (signature verification)
app.route('/webhooks/stripe', stripeWebhooks);
app.route('/webhooks/razorpay', razorpayWebhooks);

// 404 handler
app.notFound((c) => {
  return c.json({ code: 'not_found', message: 'Endpoint not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  logger.error({ error: err }, 'Unhandled error');
  return c.json({ code: 'internal_error', message: 'Internal server error' }, 500);
});

// Start server
const port = parseInt(env.PORT);

logger.info({ port, env: env.NODE_ENV }, 'Starting Loop API server');

serve({
  fetch: app.fetch,
  port
});

export default app;
