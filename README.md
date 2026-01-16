# @payloops/backend

Hono API server for PayLoops payment platform.

## Features

- RESTful API for payment operations
- JWT + API Key authentication
- Webhook handlers for Stripe and Razorpay
- Temporal workflow integration
- PostgreSQL with Drizzle ORM
- AES-256-GCM encryption for credentials

## Tech Stack

- **Framework**: Hono
- **Language**: TypeScript
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod
- **Auth**: JWT (jose) + bcryptjs

## Development

```bash
# Install dependencies
pnpm install

# Start dev server (with hot reload)
pnpm dev

# Type check
pnpm typecheck

# Build for production
pnpm build

# Run production build
pnpm start
```

## Database Commands

```bash
# Generate migrations
pnpm db:generate

# Run migrations
pnpm db:migrate

# Push schema to database
pnpm db:push

# Open Drizzle Studio
pnpm db:studio
```

## Environment Variables

```bash
# Copy example env file
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `TEMPORAL_ADDRESS` | Temporal server address |
| `TEMPORAL_NAMESPACE` | Temporal namespace |
| `JWT_SECRET` | Secret for JWT signing (min 32 chars) |
| `ENCRYPTION_KEY` | Key for AES encryption (min 32 chars) |
| `CORS_ORIGINS` | Allowed CORS origins |

## API Endpoints

### Public API (Merchant SDK)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/orders` | Create payment order |
| GET | `/v1/orders/:id` | Get order status |
| POST | `/v1/orders/:id/pay` | Process payment |
| POST | `/v1/orders/:id/refund` | Initiate refund |
| GET | `/v1/orders/:id/refunds` | List refunds |
| POST | `/v1/checkout/sessions` | Create checkout session |

### Webhooks

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/webhooks/stripe` | Stripe webhook receiver |
| POST | `/webhooks/razorpay` | Razorpay webhook receiver |

### Dashboard API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/register` | Register |
| GET | `/api/merchants/me` | Get current merchant |
| PUT | `/api/merchants/me` | Update merchant |

## Authentication

**Merchant API**: Include API key in header
```
X-API-Key: sk_live_xxx
```

**Dashboard API**: Include JWT in header
```
Authorization: Bearer <token>
```

## Docker

```bash
# Build image
docker build -t payloops/backend .

# Run container
docker run -p 3000:3000 payloops/backend
```

## License

Proprietary - PayLoops
