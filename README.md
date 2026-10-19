# vortomi-backend

Server of **Vortomi**, the multi-company WhatsApp CRM. One installation, one Meta
webhook, many companies; each company only ever reaches its own data. Design in
`../documentations` (04 · Arquitectura).

**Status (15 Oct 2026):** the panel API is complete and tested (154 tests), waiting for
the real Supabase project and Meta configuration. Not connected to the Angular panel yet.

| Milestone | What |
|---|---|
| B1 | Secure entry: verified webhooks, routing by number, four isolation layers |
| B2 | People and access: Supabase Auth tokens, memberships, platform console guard |
| B3 | Inbox API: conversations, messages, contacts, tags, notes, assignment, team |
| B4 | Sending: text in the 24 h window, templates outside it, at most once, encrypted tokens |
| B5 | Company data: settings, quick replies, pipeline, templates, inventory, monthly usage |
| B6 | Tools: Meta simulator, sample data loader |

## Stack

Node 24 · TypeScript 6 (strict) · Fastify 5 · Drizzle ORM · PostgreSQL on Supabase ·
Zod 4 · jose (Supabase JWT) · Vitest with PGlite (in-memory Postgres running the real
migrations). Base reused from `project-1/automated-responses-backend`.

## Setup

```bash
npm install
cp .env.example .env          # fill in; never paste these values anywhere else
npm run db:migrate            # applies ./drizzle to DATABASE_URL
npm run channel:register -- --name "Nosotros" ...         # a company and its number
npm run channel:set-token -- --phone-number-id <id>       # paste the token on stdin
npm run member:add -- --tenant-slug nosotros --user-id <supabase uuid> ...
npm run dev
```

The server refuses to start if any required variable is missing or weak. Development
only: `npm run db:seed-sample` loads the prototype's seven sample companies into an
empty database, and `npm run meta:simulate` plays Meta against the local server.

## Tenant isolation, four layers

| Layer | Where | What it guarantees |
|---|---|---|
| Routing | `modules/tenancy/channel-directory.ts` | Each Meta event goes to the company that owns its `phone_number_id` (templates: its WABA). Unknown owners are set aside, never guessed. A number, and a WABA, belong to one company |
| Scope in code | `modules/tenancy/tenant-scope.ts`, `modules/access/member-scope.ts` | Tenant data is only reachable through `withTenant()`; the panel goes through `withMember()`, which also proves the caller belongs to that company |
| RLS | `drizzle/*_security*.sql` | Inside the scope the transaction runs as `tenant_scoped` with `app.tenant_id` set. Policies hide and reject every other company's rows |
| Composite foreign keys | `db/schema/*.ts` | `(tenant_id, id)` keys: a row of one company can never point to a row of another, even from the server role |

Least privilege for `tenant_scoped`: messages are never rewritten (only their send
result, once), status events and stock movements are append-only, stock counts move
only through movements, credentials are not readable at all, and Supabase's `anon` and
`authenticated` roles get nothing.

## Who sees what inside a company

`modules/conversations/visibility.ts`, one rule for every query:

| Person | Sees |
|---|---|
| Admin | Everything in the company |
| Agent | Only the numbers assigned to them |
| Agent without "see others" | Of those, unassigned conversations and their own |

What a person cannot see, they cannot answer, assign, annotate or tag. Not found and
not visible give the same answer.

## API

All under `/api`, with `Authorization: Bearer <Supabase access token>` (asymmetric
signing keys only). Errors are `{ error: code }`; the panel translates codes to Spanish.

| Route | Who |
|---|---|
| `GET /me` | Anyone with an account: profile and the companies they can enter |
| `GET /platform/tenants`, `GET /platform/usage?month=` | Super admin with second factor (aal2) |
| `/tenants/:tenantId/...` | Active members of that company |
| `GET me` · `GET team` | Own role and numbers · the team (emails for admins only) |
| `GET conversations` (view, channel, tag, search, cursor) · `GET conversations/:id` · `GET conversations/:id/messages` | Visibility rule |
| `POST conversations/:id/messages` · `POST conversations/:id/template-messages` | Visibility rule; `clientMessageId` makes retries safe |
| `POST conversations/:id/read` · `PUT conversations/:id/assignee` · `PUT conversations/:id/status` · `GET/POST conversations/:id/notes` | Visibility rule |
| `GET contacts` · `GET contacts/:id` · `PUT contacts/:id/name` · `PUT contacts/:id/tags` · `PUT contacts/:id/opportunity` | Visibility rule |
| `GET tags` · `GET quick-replies` · `GET pipeline/stages` · `GET settings` · `GET templates` · `GET inventory/products` | Everyone; changes are admin-only |
| `POST inventory/variants/:id/movements` | Sales and returns: everyone. Purchases, adjustments, losses: admins |
| `GET usage?month=` | Admins |

## Sending

`modules/messaging/outbound.service.ts`: store the message in the company transaction,
call Meta outside any transaction, record the result in a new one. Never retried
automatically; the same `clientMessageId` never sends twice. Text needs the 24 h
window; templates must be approved and belong to the number's WABA. Each number's
token is encrypted with AES-256-GCM bound to that number (`CREDENTIALS_ENCRYPTION_KEY`).

## Scripts

| Script | Purpose |
|---|---|
| `dev` / `build` / `start` | Run with reload / compile / run compiled |
| `check` | Typecheck + lint + tests; run before every change is considered done |
| `db:generate` / `db:migrate` / `db:check` | Drizzle migrations |
| `channel:register` | Register a company and its number |
| `channel:set-token` | Store a number's access token, encrypted (read from stdin) |
| `member:add` | Link a Supabase Auth user to a company |
| `db:seed-sample` | Sample companies into an empty development database |
| `meta:simulate` | Signed fake Meta webhooks against the local server |

## Layout

```
src/
  config/          env validation
  db/              schema (one file per domain), client
  http/            API plugin, authentication, company scope, error mapping
  modules/
    access/        Supabase token verifier, who-am-I, withMember
    channels/      encrypted credentials
    contacts/      contacts and tags
    conversations/ ingest, delivery statuses, inbox queries and commands, visibility
    inbox/         webhook_events store, serial queue, processor, event router
    inventory/     products, variants, stock movements
    messaging/     outbound sending, 24 h window
    platform/      platform console
    team/          the company's people
    templates/     templates and Meta's verdicts
    tenancy/       routing and withTenant
    usage/         monthly usage per number
    whatsapp/      signature, payload schema, parser, webhook routes, Cloud API client
    workspace/     settings, quick replies, pipeline
scripts/           operational CLIs (+ lib/sample-data.ts)
drizzle/           SQL migrations (generated + *_security custom)
test/
```

## Rules

- Never query a tenant table outside `withTenant()` / `withMember()`. Platform code
  (routing, inbox, access directory, platform console) only reads by verified ids.
- Every new table: RLS and a `tenant_isolation` policy in its `*_security` migration,
  composite foreign keys to other tenant tables. `test/db/security.test.ts` fails if
  a declared table lacks RLS or its policy.
- Never call Meta inside a database transaction.
- Use the session pooler or a direct connection, never the transaction pooler.
- Secrets live in `.env` only. Logs redact authorization and signature headers.

## Pending

Invitations (accept link, our own hashed tokens), contact attributes and owner,
reservations when quoting, media download, number health (quality, limit) from Meta,
and connecting the Angular panel.
