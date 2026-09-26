# Deploying the API to Vercel

A runbook. Follow it top to bottom for a first deploy; the reference sections at
the end explain why each piece is shaped the way it is.

Only `apps/api` is deployed here. The web app goes to Netlify, which means the
browser talks to two different sites — that single fact drives most of the
configuration below, and it is the thing that breaks silently if you skip it.

---

## Before you start

You need:

- Push access to `Iftekhar1405/menu` and a Vercel account with access to it.
- The Supabase project's database password.
- Cloudinary credentials (cloud name, API key, API secret).
- `pnpm` locally, and a working `pnpm install` on the branch you are deploying.

Nothing here is destructive except step 3, which runs migrations against the
production database. Read that step before running it.

---

## Step 1 — Collect the two connection strings

Supabase dashboard → **Project Settings → Database → Connection string**.

Take two of them, and do not mix them up:

| Purpose | Which one | Port |
| --- | --- | --- |
| Runtime (`DATABASE_URL`, `APP_DATABASE_URL`) | **Transaction pooler** | `6543` |
| Migrations (`DIRECT_URL`) | **Direct connection** or **Session pooler** | `5432` |

Append pooler options to the runtime URL:

```
postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=5
             ^^^^^^^^^^^^^
```

**The username carries the project ref, and it is not decoration.** Supavisor
routes by username, splitting on the last dot into `<db-user>.<project-ref>`.
Without the suffix it has no tenant to route to and refuses the connection:

```
FATAL: (ENOIDENTIFIER) no tenant identifier provided (external_id or sni_hostname required)
```

This bites hardest in step 2, where the role changes and the suffix is easy to
drop along with it. `DIRECT_URL` takes no suffix — it connects straight to
Postgres with no pooler in front.

Percent-encode the password if it contains `@ : / ? # &`.

`connection_limit=5` is Prisma's own pool size **per serverless instance**, not
a global cap. Keep it small — the pooler multiplexes, so a large per-instance
pool buys nothing and exhausts the pooler faster.

While you are on this page, note the project's **region** (Project Settings →
General). You need it in step 6.

### Why the pooler is mandatory, not merely advisable

Two independent reasons:

1. Every warm serverless instance holds its own connection. Direct connections
   run out long before the traffic becomes interesting.
2. `db.<ref>.supabase.co` resolves to an **IPv6 address only**. Vercel
   functions have IPv4 egress. The direct host is not slow from Vercel — it is
   unreachable.

The second one is the reason a local `.env` that works fine will produce a
deployment that cannot talk to the database at all.

---

## Step 2 — Create the runtime role and give it a real password

The API must connect as a **non-superuser**. Superusers and table owners bypass
row-level security entirely, so pointing `APP_DATABASE_URL` at the `postgres`
role silently turns every tenant-isolation policy off while every test still
passes.

The `menu_app` role is created by the `20260830074320_hardening` migration with
a development password hard-coded in the SQL. Change it, in the Supabase SQL
editor, before anything reaches the internet:

```sql
ALTER ROLE menu_app PASSWORD '<a long random password>';
```

`APP_DATABASE_URL` is then the **pooled** URL with `menu_app` and that password
in place of `postgres` — keeping the project-ref suffix on the username:

```
postgresql://menu_app.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=5
```

Replacing the whole username with a bare `menu_app` is the single most common
way to get `ENOIDENTIFIER` on the first deploy.

---

## Step 3 — Run the migrations

Migrations do **not** run during the Vercel build. That is deliberate: a preview
deploy must never migrate production. Run them by hand, against the direct
connection:

```sh
cd apps/api
DIRECT_URL="<direct 5432 url>" DATABASE_URL="<direct 5432 url>" \
  pnpm exec prisma migrate deploy
```

Both variables point at the direct URL here — `migrate deploy` needs a real
session and the pooler cannot give it one.

Then seed the platform admin and merchandise catalogue. Set a real
`SEED_ADMIN_PIN` first; the seed is idempotent and warns if the PIN is still
the example value.

```sh
SEED_ADMIN_PIN=<six digits> DATABASE_URL="<direct 5432 url>" pnpm db:seed
```

---

## Step 4 — Create the Vercel project

Vercel dashboard → **Add New → Project → Import Git Repository →
`Iftekhar1405/menu`**.

Then, before the first build, set:

| Setting | Value |
| --- | --- |
| Framework Preset | **Other** — `vercel.json` pins this, see below |
| Root Directory | **`./`** — the repo root, *not* `apps/api` |
| Node.js Version | **22.x** |
| Install Command | leave blank |
| Build Command | leave blank |
| Output Directory | leave blank |

The three blank commands are supplied by `vercel.json`; overriding them in the
dashboard silently wins over the file, which makes for a confusing afternoon.

`"framework": null` in `vercel.json` holds the preset at Other. Vercel's import
scans the monorepo, finds Next in `apps/web`, and offers the Next.js preset —
which then runs its own builder against the repo root and fails with:

```
Error: No Next.js version detected. Make sure your package.json has "next" ...
```

Truthfully so: the root `package.json` is a workspace manifest, and the install
command skips `apps/web` anyway. The setting lives in the file rather than the
dashboard so a re-import cannot reintroduce it.

**Vercel will suggest `api` as the Root Directory. Change it.** The import
screen sees the `api/` folder at the repo root and offers it — accept that and
the build resolves against a directory holding one file. Click **Edit** beside
Root Directory and set it back to the repo root.

**The repo root is correct on purpose**, even though it looks wrong for a
monorepo. The reason is pnpm: `node_modules/.pnpm` lives at the repo root, and
`includeFiles` globs cannot reach above the project root. Rooting the project at
`apps/api` produces a build that succeeds and a function that fails at runtime,
missing the Prisma query engine and pdfkit's font metrics.

---

## Step 5 — Set the environment variables

Vercel → **Settings → Environment Variables**. Set every one of these for
**Production** (and for Preview if you intend to use preview deploys).

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | pooled URL, `postgres` role (step 1) |
| `APP_DATABASE_URL` | pooled URL, **`menu_app`** role (step 2) |
| `DIRECT_URL` | direct URL, port 5432 |
| `WEB_ORIGIN` | the Netlify site URL — the API calls it back to revalidate |
| `CORS_ORIGINS` | the Netlify site URL; add preview domains comma-separated |
| `COOKIE_SAMESITE` | **`none`** |
| `PUBLIC_MENU_BASE_URL` | the Netlify site URL — this goes into every QR code |
| `JWT_ACCESS_SECRET` | fresh random value |
| `JWT_REFRESH_SECRET` | fresh random value |
| `REVALIDATE_SECRET` | fresh random value, same one Netlify gets |
| `TABLE_SESSION_SECRET` | fresh random value |
| `AUTH_SKIP_VERIFICATION` | `true` until WhatsApp/Resend are configured, then `false` |
| `CLOUDINARY_CLOUD_NAME` | from Cloudinary |
| `CLOUDINARY_API_KEY` | from Cloudinary |
| `CLOUDINARY_API_SECRET` | from Cloudinary |

`API_PORT` is not needed — nothing binds a port in serverless.

Generate the secrets with `openssl rand -base64 32`. Do not reuse the
`dev-*-change-me` values; `PUBLIC_MENU_BASE_URL` in particular is baked into
printed QR codes, so getting it wrong means reprinting cards.

### `COOKIE_SAMESITE=none` is the one people skip

`apps/web/lib/api-client.ts` calls the API straight from the browser with
`credentials: "include"`. With the web app on Netlify and the API on Vercel
those are different sites, so a `SameSite=Lax` refresh cookie is never sent.

The failure is specific and easy to misdiagnose: **login works, and the session
vanishes about fifteen minutes later** when the access token expires and the
refresh call arrives without its cookie. `none` forces `Secure`, which
`refreshCookieFlags()` applies automatically.

If you later put both behind one domain, set it back to `lax`.

### `CLOUDINARY_*` is the second one

Cloudinary is the production image driver. The local-disk fallback cannot work
on Vercel — the filesystem is read-only outside `/tmp`, and `/tmp` does not
survive between invocations. `MediaService` therefore throws when it reaches
that branch in production rather than handing back an upload ticket pointing at
`localhost:4000`. If uploads fail with *"No image storage configured"*, these
three variables are missing.

---

## Step 6 — Set the region

In `vercel.json`:

```json
"regions": ["bom1"]
```

**Pin this to wherever Postgres lives, not to where the users are.** A single
request makes several round-trips to the database — the RLS `set_config`, then
the query, inside one transaction — so a function in the wrong region multiplies
that latency on every call. It costs far more than the milliseconds saved by
sitting near the user.

Map the Supabase region you noted in step 1:

| Supabase region | Vercel region |
| --- | --- |
| `ap-south-1` (Mumbai) | `bom1` |
| `ap-southeast-1` (Singapore) | `sin1` |
| `ap-southeast-2` (Sydney) | `syd1` |
| `eu-central-1` (Frankfurt) | `fra1` |
| `us-east-1` (N. Virginia) | `iad1` |

The committed value is `syd1`, because the Supabase project currently sits in
`ap-southeast-2`. You can read the region straight off the pooler hostname —
`aws-0-<region>.pooler.supabase.com` — without opening the dashboard.

That pairing is internally consistent but probably not what you want long term:
a diner in India scanning a QR code is served from Sydney. Moving the database
to `ap-south-1` means creating a new Supabase project and migrating into it,
which is far cheaper now than after real orders exist. If you do move it,
change this to `bom1` in the same commit.

On the Hobby plan only one region may be listed; listing several requires Pro.

---

## Step 7 — Deploy

Push to `master`, or from the dashboard use **Deployments → Redeploy**.

The build runs, in order:

```sh
pnpm install --frozen-lockfile --filter=@menu/api...      # installCommand
pnpm --filter @menu/shared build
pnpm --filter @menu/api exec prisma generate
pnpm --filter @menu/api build                             # buildCommand
```

The filtered install pulls in `@menu/api` and `@menu/shared` only — Next, React
and Playwright are never downloaded. `--frozen-lockfile` means **an uncommitted
`pnpm-lock.yaml` fails the build**; if you have just added a dependency, commit
the lockfile with it.

---

## Step 8 — Verify

Three checks, in increasing order of confidence.

**It booted and routes:**

```sh
curl -i https://<your-deployment>/auth/me
# expect 401 {"message":"Unauthorized","statusCode":401}
```

A 401 here is the good outcome — it proves the Nest container built and the
guard ran. A 500 means the bootstrap threw; check the function logs.

**It can reach the database:**

```sh
curl -i https://<your-deployment>/public/menus/<a-real-public-code>
```

This is unauthenticated and hits Postgres. A 200 or a clean 404 both prove
connectivity; a hang or a 500 mentioning connections means the URL is still the
direct (IPv6) host rather than the pooler.

**Tenant isolation still holds against the deployed instance:**

```sh
pnpm --filter @menu/api test:isolation https://<your-deployment>
```

Two real tenants, eight attack paths, non-zero exit if any returns 2xx. Worth
running once against production, because this is the one bug class here that
cannot be fixed after the fact.

Then log in through the Netlify site and **leave the tab open for twenty
minutes**. If the session survives a token refresh, `COOKIE_SAMESITE` is right.

---

## Step 9 — Point Netlify at it

Set `NEXT_PUBLIC_API_URL` in Netlify to the Vercel deployment URL.

Use a **stable custom domain**, not the generated `*.vercel.app` URL — that one
changes on every deployment, and `CORS_ORIGINS` would need updating each time.

`REVALIDATE_SECRET` must match on both sides: the API posts to
`${WEB_ORIGIN}/api/revalidate` with it when a menu changes.

---

## Redeploying and rolling back

Redeploy: push to `master`. Nothing in the build touches the database, so a
redeploy is safe to repeat.

Roll back: **Deployments → the last good one → Promote to Production**. Note
that this rolls back *code only* — migrations already applied stay applied, so a
rollback across a schema change needs a considered `migrate resolve`, not a
click.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Import rejected: `functions.api/index.ts.includeFiles should be string` | `includeFiles` was given an array. It takes one string; use brace expansion |
| Build fails immediately, cannot find the workspace | Root Directory is `api` (Vercel's suggestion) instead of the repo root |
| `Error: No Next.js version detected` after a clean install | Framework Preset is Next.js. `"framework": null` pins it to Other |
| Build fails: `ERR_PNPM_OUTDATED_LOCKFILE` | `pnpm-lock.yaml` not committed alongside a dependency change |
| Function 500s on every request, logs show a DI error | Something imported the TS source instead of `dist/`. `api/index.ts` must re-export `../apps/api/dist/serverless` |
| First query fails, `PrismaClientInitializationError` | Missing `rhel-openssl-3.0.x` in `binaryTargets`, or the engine was not included in the bundle |
| Bootstrap 500s, `ENOIDENTIFIER: no tenant identifier provided` | The pooled URL's username lost its `.<project-ref>` suffix |
| Requests hang, then time out at 30s | `DATABASE_URL` is the direct IPv6 host, not the pooler |
| Login works, session dies ~15 min later | `COOKIE_SAMESITE` is not `none` |
| Browser console: blocked by CORS | The Netlify origin is missing from `CORS_ORIGINS` |
| Uploads fail: *No image storage configured* | `CLOUDINARY_*` not set in Vercel |
| Owner sees no data at all, no error | `APP_DATABASE_URL` points at a role that RLS denies, or at the wrong database |
| Owner sees **other tenants'** data | `APP_DATABASE_URL` points at `postgres`. Stop and fix immediately — superusers bypass RLS |
| `FUNCTION_INVOCATION_TIMEOUT` on QR sheet or bill PDF | Generation exceeded `maxDuration: 30`. Raise it, or reduce the batch |

---

## How the wiring works

```
/vercel.json                   build, region, function config
/api/index.ts                  the serverless entry Vercel discovers
/public/.gitkeep               an empty static dir, so Vercel has something to serve
/apps/api/src/serverless.ts    the real bootstrap (compiled by nest build)
```

`api/index.ts` re-exports the **compiled** `apps/api/dist/serverless.js`. It
must never import the TypeScript source: Vercel bundles entry points with
esbuild, which strips the decorator metadata NestJS dependency injection reads,
and the container then fails to build at runtime with errors that point
nowhere useful.

`serverless.ts` mirrors `main.ts` — same `cookieParser`, same CORS — but calls
`app.init()` and returns the Express instance instead of binding a port. The
bootstrap promise is cached so concurrent requests on a cold instance share one
initialisation; a *failed* bootstrap clears the cache, so one bad cold start
does not poison every subsequent request on that instance.

`includeFiles` in `vercel.json` carries four things Vercel's static tracer
cannot find on its own: the Prisma query engine, pdfkit's `.afm` font metrics
(loaded via a runtime string concatenation, so untraceable), and the
`@resvg/resvg-js` and `@node-rs/argon2` native binaries.

It must be **a single string**, not an array — Vercel rejects an array at
import time with `Invalid request: 'functions.api/index.ts.includeFiles' should
be string`. Four patterns fit in one string via brace expansion, which is why
it reads the way it does.

### Transaction pooling and RLS

Transaction pooling is safe for the isolation design here because the tenant
context is set with `set_config('app.current_user_id', …, true)` — the third
argument scopes it to the transaction — and every tenant query runs inside that
transaction. A session-level `SET` would have broken under this pooler, and
broken in the worst way: quietly, and only under concurrency.

---

## Known rough edges

- **QR card text may render blank.** `@resvg/resvg-js` draws with system fonts,
  and Vercel's runtime image carries very few. If text comes out blank or as
  tofu, bundle a `.ttf` with the app and pass it through resvg's
  `font.fontFiles` option in `qr.service.ts`.
- **Cold starts are slow.** A Nest container plus the Prisma engine is a heavy
  boot — several seconds. The cached bootstrap keeps concurrent cold requests
  from each paying for it, but the first request after idle is still slow.
- **No health endpoint.** `/auth/me` returning 401 is the current liveness
  signal. A real `/health` route would be a small, worthwhile addition.
