// Initialize OpenTelemetry FIRST, before any other imports
import { initTelemetry, logger } from '@payloops/observability';
initTelemetry(process.env.OTEL_SERVICE_NAME || 'loop-backend', '0.0.1');

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { prettyJSON } from 'hono/pretty-json';

import { env } from './lib/env';
import { authMiddleware, type AuthContext } from './middleware/auth';
import { tracingMiddleware, type TracingContext } from './middleware/tracing';

// Routes
import authRoutes from './routes/dashboard/auth';
import merchantRoutes from './routes/dashboard/merchants';
import orderRoutes from './routes/v1/orders';
import stripeWebhooks from './routes/webhooks/stripe';
import razorpayWebhooks from './routes/webhooks/razorpay';

type AppContext = TracingContext & AuthContext;

const app = new Hono<AppContext>();

// Global middleware - tracing first for correlation IDs
app.use('*', tracingMiddleware);
app.use('*', prettyJSON());
app.use(
  '*',
  cors({
    origin: env.CORS_ORIGINS.split(','),
    credentials: true
  })
);

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    correlationId: c.get('correlationId')
  });
});

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
  const log = c.get('requestLogger') || logger;
  log.warn({ path: c.req.path }, 'Endpoint not found');
  return c.json({ code: 'not_found', message: 'Endpoint not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  const log = c.get('requestLogger') || logger;
  log.error({ error: err, stack: err.stack }, 'Unhandled error');
  return c.json({ code: 'internal_error', message: 'Internal server error' }, 500);
});

// Start server
const port = parseInt(env.PORT);

logger.info({ port, env: env.NODE_ENV }, 'Starting PayLoops API server');

serve({
  fetch: app.fetch,
  port
});

export default app;
