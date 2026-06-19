# Bastion — Firewall Onboarding Assistant

A guided, mostly-deterministic web app that brings a firewall from a near-blank
state up to a best-practice baseline via vendor APIs. It runs entirely on
Cloudflare (Workers + Durable Objects + D1 + R2).

> **AI is used in exactly one place:** normalising messy source config
> (NAT/ACL/VPN) into the app's internal structured format (the IR). Everything
> else — design, packs, plan, render, apply — is deterministic templating.
> See [CLAUDE.md](./CLAUDE.md) for the full specification.

---

## What's built

This is a working vertical slice of the spec, end-to-end:

- **Worker + SPA** — one Worker serves the React/Vite/Tailwind wizard and the
  `/api/*` surface (`src/index.ts`, `src/router.ts`).
- **Session Durable Object** — one per onboarding session; holds wizard state,
  credentials *in memory only*, the relay WebSocket, and an apply-lock
  (`src/session-do.ts`).
- **IR schema** — the vendor-neutral source of truth, Zod-validated, with a JSON
  Schema mirror (`schema/ir.ts`, `schema/ir.json`).
- **Vendor drivers** — Palo Alto (most complete: keygen/discover/`set` render/
  commit), Fortinet, Cisco FTD, Cisco ASA, Meraki MX. Common `FirewallDriver`
  contract (`src/drivers/`).
- **Transports** — Direct, Cloudflare Tunnel, Relay agent (`src/transport/`)
  plus a Node relay agent (`agent/relay-agent.mjs`).
- **Plan engine** — deterministic, idempotent merge of design + accepted imports
  + policy packs, with a section-by-section diff (`src/plan/engine.ts`).
- **Policy packs** — 13 best-practice packs across connectivity/security/access/
  management (`src/packs/catalogue.ts`).
- **AI normaliser** — the one AI step: source config → schema-validated IR
  fragment, with ambiguity (any/any, unknown services) flagged for the human and
  a retry-on-invalid loop (`src/normaliser/`).
- **D1 + R2** — projects, plans, imports, packs, apply runs, append-only audit
  log; backups/imports/bundles/readbacks/reports in R2 (`migrations/`, `src/db.ts`).
- **Tests** — IR schema, plan determinism/idempotency, pack idempotency
  (`tests/`, `npm test`).

### Verified working locally
`npm test` (12/12), `npm run build` (clean tsc + Vite), and a full `wrangler dev`
smoke run: create session → design → packs → plan/diff → validate → staged apply
→ download a real PAN-OS `set` bundle, plus a live AI normalise of a Cisco ASA
ACL into a schema-valid IR fragment with `any/any` flagged `danger`.

> **Not yet wired to a real device.** Drivers are structured correctly and fail
> *honestly* on network errors, but `discover`/live-`apply`/`verify` have not been
> run against physical firewalls. Confirm each vendor's current API
> version/auth before first live use (CLAUDE.md §4.3).

---

## Quick start (local)

```bash
npm install
cp .dev.vars.example .dev.vars   # then put your ANTHROPIC_API_KEY in it
npm run db:migrate:local         # apply D1 migrations to the local DB
npm run dev:worker               # wrangler dev on http://127.0.0.1:8787
# in another terminal, for the live-reloading UI:
npm run dev:web                  # vite on http://127.0.0.1:5173 (proxies /api)
```

Local dev has no Cloudflare Access in front, so the API treats requests as the
owner (because `ENVIRONMENT` is not `production` once you remove it, or send the
`Cf-Access-Authenticated-User-Email` header). In production Access is mandatory.

## Deploy to Cloudflare

```bash
# one-time provisioning (creates D1 + R2, patches wrangler.toml, sets secret, deploys)
pwsh ./scripts/provision.ps1
```

…or manually:

```bash
npx wrangler d1 create bastion          # paste database_id into wrangler.toml
npx wrangler r2 bucket create bastion-storage
npx wrangler secret put ANTHROPIC_API_KEY
npm run db:migrate:remote
npm run deploy
```

Then in the Cloudflare dashboard add an **Access** application for
`bastion.clydeford.net` with a policy that **allows only
`stevie.johnston@gmail.com`** (CLAUDE.md §12).

## Relay agent (private-network targets)

```bash
node agent/relay-agent.mjs \
  --url wss://bastion.clydeford.net/api/relay/<session-id> \
  --device https://10.0.0.1
```

The agent dials *outbound* to the session's Durable Object; no inbound firewall
holes required.

---

## Layout

```
schema/ir.ts          IR schema (source of truth) + JSON Schema mirror
src/index.ts          Worker entry (SPA + /api)
src/router.ts         API routing + Access auth
src/session-do.ts     per-session Durable Object orchestrator
src/db.ts, audit.ts   D1 helpers + append-only audit log
src/drivers/<vendor>/ FirewallDriver implementations
src/transport/        direct | tunnel | relay
src/plan/engine.ts    deterministic plan build + diff
src/packs/catalogue.ts policy packs
src/normaliser/       the single AI step
web/                  React + Vite + Tailwind wizard SPA
agent/                on-site relay agent
migrations/           D1 schema
tests/                vitest
```

## Security notes

- Credentials live only in Durable Object memory; never persisted, never logged.
- VPN PSKs are referenced (`pskRef`), never stored in the IR/plan.
- Every connect/discover/plan/apply/rollback is written to an immutable audit log.
- A full pre-change snapshot is taken before any change (rollback safety net).
- AI output can never reach a driver without passing schema validation **and**
  explicit human acceptance.
- `.env` / `.dev.vars` are gitignored — never commit secrets.
