# PayLoops Backend

The **backend** service is the API gateway for the PayLoops platform. It handles all incoming HTTP requests from merchants, the dashboard, and external payment processors.

## Role in the Platform

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   Merchant App          Dashboard           Stripe/Razorpay Webhooks   │
│        │                    │                        │                  │
│        └────────────────────┼────────────────────────┘                  │
│                             │                                           │
│                             ▼                                           │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │                    ★ BACKEND (this repo) ★                       │  │
│   │                                                                  │  │
│   │  • Validates and authenticates requests                         │  │
│   │  • Persists orders and transactions to PostgreSQL               │  │
│   │  • Triggers Temporal workflows for payment processing           │  │
│   │  • Receives webhooks from payment processors                    │  │
│   │  • Serves dashboard API endpoints                               │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                             │                                           │
│                             ▼                                           │
│                    Temporal (processor-core)                            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## What This Service Does

### For Merchants (via SDK)
- **Create payment orders** with amount, currency, and metadata
- **Process payments** using tokenized payment methods
- **Handle refunds** (full or partial)
- **Query order status** and transaction history

### For the Dashboard
- **Authentication** via JWT tokens
- **Merchant management** (profile, settings)
- **API key generation** and revocation
- **Processor configuration** (Stripe, Razorpay credentials)
- **Analytics endpoints** for charts and reports

### For Payment Processors
- **Webhook receivers** for Stripe and Razorpay events
- **Signature verification** to ensure webhook authenticity
- **Event forwarding** to Temporal for processing

## Tech Stack

| Component | Technology | Why |
|-----------|------------|-----|
| Framework | [Hono](https://hono.dev) | Fast, lightweight, great TypeScript support |
| Database | PostgreSQL + [Drizzle ORM](https://orm.drizzle.team) | Type-safe queries, excellent migrations |
| Validation | [Zod](https://zod.dev) | Runtime validation with TypeScript inference |
| Auth | [jose](https://github.com/panva/jose) + bcryptjs | Standards-compliant JWT, secure password hashing |
| Encryption | Node.js crypto (AES-256-GCM) | Encrypt processor credentials at rest |

## API Overview

### Merchant API (`/v1/*`)

Authenticated via `X-API-Key` header.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/orders` | POST | Create a new payment order |
| `/v1/orders/:id` | GET | Get order details and status |
| `/v1/orders/:id/pay` | POST | Process payment for an order |
| `/v1/orders/:id/refund` | POST | Initiate a refund |
| `/v1/checkout/sessions` | POST | Create hosted checkout session |

### Dashboard API (`/api/*`)

Authenticated via `Authorization: Bearer <jwt>` header.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/login` | POST | Authenticate and get JWT |
| `/api/auth/register` | POST | Create merchant account |
| `/api/merchants/me` | GET/PUT | Get or update merchant profile |
| `/api/api-keys` | GET/POST/DELETE | Manage API keys |
| `/api/processors` | GET/POST | Configure payment processors |

### Webhooks (`/webhooks/*`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhooks/stripe` | POST | Receive Stripe events |
| `/webhooks/razorpay` | POST | Receive Razorpay events |

## Development

### Prerequisites

- Node.js 22+
- pnpm
- PostgreSQL (via Docker or local)
- Redis (via Docker or local)

### Setup

```bash
# Install dependencies
pnpm install

# Copy environment template
cp .env.example .env

# Start database (if using Docker)
docker-compose up -d postgres redis

# Push schema to database
pnpm db:push

# Start development server
pnpm dev
```

### Available Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start dev server with hot reload |
| `pnpm build` | Build for production |
| `pnpm start` | Run production build |
| `pnpm typecheck` | Run TypeScript compiler |
| `pnpm lint` | Run ESLint |
| `pnpm db:generate` | Generate migration files |
| `pnpm db:migrate` | Run pending migrations |
| `pnpm db:push` | Push schema directly (dev only) |
| `pnpm db:studio` | Open Drizzle Studio GUI |

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `TEMPORAL_ADDRESS` | Yes | Temporal server address |
| `TEMPORAL_NAMESPACE` | Yes | Temporal namespace |
| `JWT_SECRET` | Yes | Secret for signing JWTs (min 32 chars) |
| `ENCRYPTION_KEY` | Yes | Key for AES encryption (min 32 chars) |
| `CORS_ORIGINS` | No | Allowed CORS origins (comma-separated) |
| `PORT` | No | Server port (default: 3000) |

## Database Schema

Key tables managed by this service:

- **merchants** - Merchant accounts and settings
- **orders** - Payment orders with status tracking
- **transactions** - Individual payment/refund transactions
- **webhook_events** - Outbound webhook delivery queue
- **api_keys** - Merchant API keys (hashed)
- **processor_configs** - Encrypted processor credentials

## Security

- **Credentials encrypted** at rest using AES-256-GCM
- **API keys hashed** using bcrypt before storage
- **JWT tokens** with configurable expiration
- **Webhook signatures** verified before processing
- **Rate limiting** on authentication endpoints

## Related Repositories

- [processor-core](https://github.com/payloops/processor-core) - Receives workflow triggers from this service
- [sdk-ts](https://github.com/payloops/sdk-ts) - Consumes the `/v1/*` API
- [dashboard](https://github.com/payloops/dashboard) - Consumes the `/api/*` API

## License

Copyright © 2025 PayLoops. All rights reserved.
