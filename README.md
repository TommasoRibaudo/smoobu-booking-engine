# Smoobu Booking Engine

A free, open-source, production-grade booking engine for vacation rental
sites running on [Smoobu](https://www.smoobu.com/). It replaces Smoobu's
embedded booking widget with your own custom UI — an availability calendar
with per-night price dots, a search flow, PayPal checkout, manual bank
transfer / SINPE deposits, and a guest self-service portal — while keeping
Smoobu as the single source of truth for inventory.

Extracted from a real production deployment (a Puerto Viejo, Costa Rica
vacation rental portfolio) and genericized for reuse. MIT licensed.

## Why this exists

Smoobu's own documentation is explicit: its API **cannot be called directly
from a browser**, and a real backend proxy is required for anything beyond
the embedded widget. Building that backend correctly — availability
revalidation at write time, a durable booking state machine, webhook
signature verification, idempotent payment handling — is most of the actual
engineering effort in a custom booking flow. This project does that work so
you don't have to redo it.

## What's inside

| Directory | What it is |
| --- | --- |
| `api/` | Node/TypeScript backend (Lambda-ready): availability search, holds, PayPal payments, manual deposits, guest portal, webhook ingestion. ~490 tests. |
| `web-widgets/` | React components: a price-dot calendar and a search widget (both portable, both tested), plus a full reference checkout page. |
| `infra/` | Terraform module for the AWS side — API Gateway, Lambda, RDS, Secrets Manager, S3, CloudWatch, WAF, SES. |

## Start here

**[AGENTS.md](./AGENTS.md)** is the full technical guide: architecture,
state machine, data model, API reference, and a step-by-step integration
playbook. It's written for an AI coding agent to follow directly, which also
makes it a dense but complete reference for a human.

## Quickstart (local development)

```bash
docker compose up -d
cd api
cp .env.example .env
cp .env.local.example .env.local
npm install
npm run migrate:local
npm run dev              # mock Smoobu/PayPal + booking API on :4000
```

```bash
cd web-widgets
npm install
npm test                 # component tests, no external services needed
```

See [AGENTS.md](./AGENTS.md) for deploying the Terraform infra and wiring
real Smoobu/PayPal credentials.

## What you'll need to configure

This ships with a fictional demo property catalog and placeholder branding —
none of it is usable as-is. At minimum:

- Your own property catalog (`api/src/propertyCatalog.ts`)
- Your brand name (`api/src/branding.ts`)
- A Smoobu API key and a PayPal app (sandbox first)
- Guest-facing copy (`web-widgets/examples/Booking.i18n.ts`)

## What this doesn't include

No admin panel, no staff login, no automated refunds, and no payment
providers beyond PayPal + manual deposit. These are deliberate scope
boundaries, not gaps — see the "Non-goals" section of
[AGENTS.md](./AGENTS.md) for the reasoning.

## License

MIT — see [LICENSE](./LICENSE). Use it, fork it, sell things with it.
