# Sortcerer (sortcerer.net)

Amazon FBM Order Hub SaaS: unshipped orders → shipping CSV, label PDF split with smaller header fonts, Keepa auto-fill for weight / max units per box, catalog PDF import, and Trybit $100/mo paywall.

## Stack

- Next.js App Router + TypeScript + Tailwind
- Supabase Auth (email/password) + Postgres
- Trybit monthly crypto invoice ($100 USD)
- Keepa product API (server-side only)

## Local setup

```bash
cd sortcerer
cp .env.example .env.local
# fill env vars (see below)
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Without Supabase env vars, middleware skips auth (useful for UI-only peek). Full flows need Supabase + schema.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role (Trybit postback + invoice metadata) |
| `NEXT_PUBLIC_APP_URL` | Canonical app URL (`https://sortcerer.net` or `http://localhost:3000`) |
| `KEEPA_API_KEY` | Keepa API key — never expose to the client |
| `TRYBIT_API_KEY` | Trybit project API key (`Authorization: Token …`) |
| `TRYBIT_SHOP_ID` | Trybit `shop_id` |
| `TRYBIT_SECRET_KEY` | HS256 secret to verify postback JWT |
| `ADMIN_EMAILS` | Comma-separated emails with complimentary Order Hub access (case-insensitive; match Supabase Auth signup email) |

### Admin / complimentary access

Set `ADMIN_EMAILS=you@example.com` (or several emails, comma-separated). Matching accounts skip the Trybit paywall forever — middleware and `/api/subscription` treat them as active. Billing shows “Admin / complimentary access” instead of Pay.

On Vercel: add `ADMIN_EMAILS` with the exact email you use in Supabase Auth, then redeploy (or soft refresh after env is live).

## Supabase setup

1. Create a project at [https://supabase.com](https://supabase.com).
2. **Authentication → Providers → Email** — enable email/password.
3. **Authentication → URL configuration** — set Site URL to `NEXT_PUBLIC_APP_URL`, add redirect `https://your-domain/auth/callback`.
4. **SQL Editor** — paste and run [`supabase/schema.sql`](./supabase/schema.sql).
5. Copy Project URL, anon key, and service_role key into `.env.local` / Vercel.

Schema highlights:

- `profiles` — optional `store_name` (one store per account)
- `subscriptions` — `active` / `locked`, `current_period_end`
- `master_reference` — unique `(user_id, asin)`

New signups get a profile + **locked** subscription via trigger.

### Dev unlock (no Trybit yet)

```sql
update public.subscriptions
set status = 'active',
    current_period_end = now() + interval '30 days'
where user_id = '<your-user-uuid>';
```

## Trybit dashboard setup

1. Create a project at [https://trybit.com](https://trybit.com) / merchant dashboard.
2. **Integration & API** — copy API key → `TRYBIT_API_KEY`, shop id → `TRYBIT_SHOP_ID`, secret → `TRYBIT_SECRET_KEY`.
3. Set **notification / postback URL** to:
   `https://sortcerer.net/api/trybit/postback`
   (use JSON postback format).
4. Set **success URL** → `https://sortcerer.net/billing`
5. Set **fail URL** → `https://sortcerer.net/billing`
6. Prefer USDT or other stablecoins if desired via project currency settings.

Flow:

1. Logged-in user hits **Pay $100** → `POST /api/trybit/create-invoice`
2. User pays on Trybit-hosted link
3. Trybit posts to `/api/trybit/postback` with JWT (`token`) signed by `TRYBIT_SECRET_KEY`
4. App sets subscription `active` with `current_period_end` ≈ now + 30 days

If keys are missing, the billing page shows a clear “configure env” message (no fake sandbox).

## Keepa

1. Subscribe / get a key: [https://keepa.com/#!api](https://keepa.com/#!api)
2. Set `KEEPA_API_KEY` on the server only
3. `POST /api/keepa/enrich` with `{ "asins": ["B0..."] }` returns weight (lb) + max units for box **8.5 × 12 × 12.25 in**

### Packing algorithm

- Keepa package L/W/H are **mm** → inches (`/ 25.4`)
- Try all 6 axis orientations of the unit prism
- `maxQty = max(floor(boxL/uL)*floor(boxW/uW)*floor(boxH/uH))`
- Weight: grams → lb, **ceil** to whole pounds, **minimum 1**
- If dims/weight missing → leave null; UI prompts manual entry

## Catalog PDF import

Seller Central **Manage Inventory** print/PDF (see example structure: `ASIN B0…` / `SKU …` near product title). Settings → **Import catalog PDF** extracts SKU/ASIN/title and upserts `master_reference`. Then run **Keepa enrich missing**.

## Vercel deploy from GitHub

1. Push this repo to GitHub (`phantomcash/sortcerer`).
2. [Vercel](https://vercel.com) → Import project → select repo.
3. Add all env vars from the table above (`NEXT_PUBLIC_APP_URL` = your Vercel or custom domain).
4. Deploy.
5. Point domain `sortcerer.net` DNS to Vercel (follow-up once domain is ready).
6. Update Supabase auth redirect URLs and Trybit postback/success/fail URLs to the live domain.

## App routes

| Path | Notes |
|------|--------|
| `/` | Landing |
| `/login`, `/signup` | Auth |
| `/billing` | Paywall / renew |
| `/hub` | Order Hub (requires active subscription) |
| `/settings` | Master reference + catalog PDF + Keepa |
| `/api/trybit/postback` | Public webhook |

Middleware: unauthenticated users → login; authenticated but locked → billing only (auth + Trybit webhook exempt).

## Label header fonts

Order Hub label header pages use **13pt** text and **~36 character** wrap (vs WeShop’s 20pt / 23 chars) so longer product titles fit on the header page.

## GitHub create (if not already pushed)

```bash
cd "/Users/polly/WeShop Productivity/sortcerer"
gh auth login   # if needed, as phantomcash
gh repo create phantomcash/sortcerer --source=. --public --push
```

Private alternative: add `--private`.
