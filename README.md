# InvoMatch Server

Node.js + TypeScript backend for InvoMatch. Talks to Supabase (Postgres) for
persistence and to the Anthropic Claude API for invoice parsing and delivery
photo analysis. The Claude API key and Supabase service-role key live only
here — the Flutter app never calls Anthropic or Supabase's service role
directly.

## Stack

- Express 5 + TypeScript
- Supabase (`@supabase/supabase-js`, service-role client)
- Anthropic Claude (`@anthropic-ai/sdk`, model: `claude-sonnet-5`)
- `zod` for request validation, `multer` for photo/PDF uploads

## Getting started

```bash
cp .env.example .env   # then fill in real values
npm install
npm run dev             # http://localhost:4000, auto-reloads on save
```

Other scripts:

```bash
npm run build      # compile TypeScript -> dist/
npm run start       # run the compiled build
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src
```

## Folder structure

```
src/
  config/       env var loading + validation
  db/           Supabase client
  services/     third-party clients (Anthropic)
  middleware/    error handling, async wrapper, file upload
  controllers/   request handlers per resource
  routes/        Express routers per resource
  types/         TypeScript interfaces mirroring the DB schema
  app.ts         Express app assembly (middleware + routes)
  index.ts       process entrypoint (starts the HTTP server)
supabase/
  migrations/    SQL migrations — run via the Supabase CLI or dashboard SQL editor
```

## Multi-tenancy & auth

InvoMatch is multi-tenant: every store (tenant) has its own vendors, items,
invoices, deliveries, etc. The Flutter app authenticates with **Supabase
Auth** directly (email/password) and sends the resulting access token to
this backend as `Authorization: Bearer <token>` on every request.

- `src/middleware/auth.ts`
  - `authenticate` — validates the bearer token via `supabase.auth.getUser()` and attaches `req.userId`/`req.userEmail`. This asks Supabase Auth to validate the token rather than verifying its signature locally, so it keeps working transparently across JWT signing key rotations (legacy shared secret or the newer per-project asymmetric keys) with no config on our end.
  - `requireStore` — looks up the user's `store_members` row and attaches `req.storeId`/`req.storeRole`; returns 403 if the user hasn't created/joined a store yet.
- Every resource router (`vendors`, `items`, `invoices`, `deliveries`) applies both middlewares, and every controller filters/writes using `req.storeId` — no endpoint can read or write another store's data, even though the backend's Supabase client uses the service-role key (which bypasses Row Level Security). RLS policies in the migrations are a second, defense-in-depth layer for the same rule.
- `/me` and `/stores` only require `authenticate` (not `requireStore`), since they're how a brand-new user checks their status and creates their first store.

## API

All routes are mounted under `/api`.

| Resource | Routes | Auth |
| --- | --- | --- |
| Me | `GET /me` — current user + store membership, if any | session only |
| Stores | `POST /stores` — create a store, become its `owner` | session only |
| Vendors | `GET/POST /vendors`, `GET/PATCH/DELETE /vendors/:id` | session + store |
| Items | `GET/POST /items`, `GET/PATCH/DELETE /items/:id`, `GET /items/:id/price-history` | session + store |
| Invoices | `GET/POST /invoices`, `GET/PATCH/DELETE /invoices/:id` | session + store |
| Deliveries | `GET/POST /deliveries`, `GET/PATCH/DELETE /deliveries/:id`, `PUT /deliveries/:id/line-items` | session + store |

Claude-powered (stubbed, not yet implemented):

- `POST /invoices/parse` — multipart upload (`file`) of an invoice photo/PDF; will return structured line items. (session + store)
- `POST /deliveries/analyze` — multipart upload (`file`) of a delivery photo; will return detected item counts/matches. (session + store)

`GET /health` (outside `/api`) is a plain liveness check with no auth.

## Database

Run the SQL files in `supabase/migrations/` in order against your Supabase
project (via `supabase db push`, the Supabase CLI, or pasting into the SQL
editor). See the root [README](../README.md) for the full schema overview.
