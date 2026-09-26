# Deploying the API to Vercel

Only `apps/api` is deployed here. The web app goes to Netlify, which means the
browser talks to two different sites — that fact drives most of the
configuration below.

## How the deployment is wired

The Vercel project's **Root Directory is the repo root**, not `apps/api`.
That looks odd for a monorepo, but it is what makes the pnpm layout work:
`node_modules/.pnpm` lives at the root, and `includeFiles` globs cannot reach
above the project root. Rooting at the repo means the function bundle can pull
in the Prisma engine and pdfkit's font metrics.

```
/vercel.json              build, region, function config
/api/index.ts             the serverless entry Vercel discovers
/public/.gitkeep          an empty static output dir, so Vercel has something to serve
/apps/api/src/serverless.ts   the real bootstrap (compiled by nest build)
```

`api/index.ts` re-exports the **compiled** `apps/api/dist/serverless.js`. It
must never import the TypeScript source: Vercel bundles entry points with
esbuild, which strips the decorator metadata NestJS dependency injection reads,
and the container fails to build at runtime with errors that point nowhere
useful.

### Project settings

| Setting | Value |
| --- | --- |
| Framework Preset | Other |
| Root Directory | `./` (repo root) |
| Node.js Version | 22.x |
| Install / Build Command | leave blank — `vercel.json` supplies both |

## Region

```json
"regions": ["bom1"]
```

`bom1` is Mumbai. **Pin this to wherever Postgres lives, not to where the users
are.** A single request makes several round-trips to the database — the RLS
`set_config`, then the query, often inside one transaction — so a function in
the wrong region multiplies that latency on every call, which costs far more
than the milliseconds saved by sitting near the user.

To confirm the right value: Supabase dashboard → Project Settings → General →
Region. Then map it:

| Supabase region | Vercel region |
| --- | --- |
| `ap-south-1` (Mumbai) | `bom1` |
| `ap-southeast-1` (Singapore) | `sin1` |
| `eu-central-1` (Frankfurt) | `fra1` |
| `us-east-1` (N. Virginia) | `iad1` |

On the Hobby plan only one region may be listed. Listing several needs Pro.

## Database connection strings

Two URLs, and they are not interchangeable:

- `DATABASE_URL` — the **Transaction pooler**, port `6543`, with
  `?pgbouncer=true&connection_limit=5`. Used at runtime.
- `DIRECT_URL` — the direct or session connection, port `5432`. Used only by
  `prisma migrate` and `prisma studio`.

Two reasons the pooler is mandatory rather than merely advisable. Each warm
serverless instance holds its own connection, so direct connections exhaust
well before traffic becomes interesting. And `db.<ref>.supabase.co` resolves to
an **IPv6 address only** — Vercel functions have IPv4 egress, so the direct
host is simply unreachable from them.

Transaction pooling is safe for the RLS design here: the tenant context is set
with `set_config('app.current_user_id', …, true)`, whose third argument scopes
it to the transaction, and every tenant query runs inside that transaction.
A session-level `SET` would have broken under this pooler.

`APP_DATABASE_URL` must stay a **non-superuser** role (`menu_app`). Table
owners and superusers bypass RLS entirely, so pointing it at the migration role
silently disables every policy while leaving all the tests green.

### Migrations

Not run during the build — a preview deploy should not migrate production.
Run them deliberately:

```sh
pnpm --filter @menu/api exec prisma migrate deploy
```

with `DIRECT_URL` pointing at the 5432 connection.

## Environment variables

Set these in Vercel → Settings → Environment Variables (Production, and Preview
if you use it):

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | pooled Supabase URL (6543, `?pgbouncer=true&connection_limit=5`) |
| `DIRECT_URL` | direct Supabase URL (5432) |
| `APP_DATABASE_URL` | pooled URL using the `menu_app` role |
| `WEB_ORIGIN` | the Netlify site URL — used for the revalidate callback |
| `CORS_ORIGINS` | the Netlify site URL, plus any preview domains, comma-separated |
| `COOKIE_SAMESITE` | `none` |
| `PUBLIC_MENU_BASE_URL` | the Netlify site URL — goes into every QR code |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `REVALIDATE_SECRET`, `TABLE_SESSION_SECRET` | fresh values, not the dev ones |
| `AUTH_SKIP_VERIFICATION` | `false` once WhatsApp/Resend are configured, `true` until then |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | from Cloudinary |

`API_PORT` is not needed — nothing binds a port in serverless.

### Why `COOKIE_SAMESITE=none` matters

`lib/api-client.ts` calls the API straight from the browser with
`credentials: "include"`. With the web app on Netlify and the API on Vercel
those are different sites, so a `SameSite=Lax` refresh cookie is never sent.
The symptom is specific and easy to misread: login works, and then the session
vanishes the moment the 15-minute access token expires. `none` forces `Secure`,
which is applied automatically in `refreshCookieFlags`.

If you later put both behind one domain, set it back to `lax`.

## Netlify side

`NEXT_PUBLIC_API_URL` must be the Vercel deployment URL. Use a stable custom
domain rather than the generated `*.vercel.app` one, which changes per
deployment and would need `CORS_ORIGINS` updated every time.

## Media uploads

Cloudinary is the production driver. The local-disk fallback cannot work on
Vercel — the filesystem is read-only outside `/tmp`, and `/tmp` does not
survive between invocations — so `MediaService` now throws at startup of an
upload rather than handing back a ticket pointing at `localhost`. If image
uploads fail with "No image storage configured", the `CLOUDINARY_*` variables
are missing.

## Known rough edges

- **QR card text.** `@resvg/resvg-js` renders with system fonts, and Vercel's
  runtime image carries very few. Text in generated QR cards may come out blank
  or as tofu. If it does, bundle a `.ttf` with the app and pass it through
  resvg's `font.fontFiles` option in `qr.service.ts`.
- **Cold starts.** A Nest container plus Prisma engine is a heavy boot. The
  cached bootstrap promise in `serverless.ts` keeps concurrent cold requests
  from each paying for it, but the first request after idle is still slow.
