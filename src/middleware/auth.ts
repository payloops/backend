import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { db } from '../db/client';
import { merchants, apiKeys } from '../db/schema';
import { eq, and, gt, isNull, or } from 'drizzle-orm';
import { verifyJWT } from '../lib/jwt';
import { hashApiKey } from '../lib/crypto';

export interface AuthContext {
  Variables: {
    merchant: typeof merchants.$inferSelect;
    authType: 'jwt' | 'api_key';
  };
}

export const authMiddleware = createMiddleware<AuthContext>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  const apiKeyHeader = c.req.header('X-API-Key');

  // Try API Key authentication first
  if (apiKeyHeader) {
    const keyHash = hashApiKey(apiKeyHeader);
    const now = new Date();

    const apiKey = await db.query.apiKeys.findFirst({
      where: and(
        eq(apiKeys.keyHash, keyHash),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now))
      ),
      with: { merchant: true }
    });

    if (apiKey) {
      // Update last used timestamp
      await db
        .update(apiKeys)
        .set({ lastUsedAt: now })
        .where(eq(apiKeys.id, apiKey.id));

      c.set('merchant', apiKey.merchant);
      c.set('authType', 'api_key');
      return next();
    }

    return c.json({ code: 'invalid_api_key', message: 'Invalid or expired API key' }, 401);
  }

  // Try JWT authentication
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = await verifyJWT(token);

    if (payload) {
      const merchant = await db.query.merchants.findFirst({
        where: eq(merchants.id, payload.sub)
      });

      if (merchant) {
        c.set('merchant', merchant);
        c.set('authType', 'jwt');
        return next();
      }
    }

    return c.json({ code: 'invalid_token', message: 'Invalid or expired token' }, 401);
  }

  return c.json({ code: 'unauthorized', message: 'Authentication required' }, 401);
});

// Helper to get merchant from context
export function getMerchant(c: Context<AuthContext>) {
  return c.get('merchant');
}
