# Railway environment variables

Everything runs in one Railway project, `openreply`: `Postgres`, `Redis`, and three app services built from the repo-root `Dockerfile`. `railway-setup.sh` sets all of this; this page is the reference for checking it or setting it by hand under each service's Variables tab.

`${{Service.VAR}}` is a Railway reference variable: Railway fills it in at deploy time, so it tracks the real value if that service's credentials or domain change. Type it literally, braces included.

Sources:

- **env file**: `.env.production.local` at the repo root (gitignored). Paste the value; never commit it.
- **param**: you pass it to the script (or type it in the dashboard).
- **reference**: the literal `${{...}}` text shown.

## web

Start `npm run start -- --hostname ::` · pre-deploy `npm run db:migrate` · public domain on port 3000.

| Variable | Value / source | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Set explicitly so the domain's target port and cron's `${{web.PORT}}` agree with what `next start` listens on. |
| `DATABASE_URL` | reference `${{Postgres.DATABASE_URL}}` | Internal `postgres.railway.internal`. The pre-deploy migration uses it too. |
| `REDIS_URL` | reference `${{Redis.REDIS_URL}}?family=0` | Internal URL. `family=0` lets ioredis use IPv6 on the private network. |
| `NEXTAUTH_URL` | reference `https://${{web.RAILWAY_PUBLIC_DOMAIN}}` | Exists once the domain is generated. If you add a custom domain later, replace this with the literal URL on web and worker. |
| `NEXTAUTH_SECRET` | env file | |
| `CRON_SECRET` | env file | cron sends it as `Authorization: Bearer …`. |
| `ENCRYPTION_KEY` | env file | Must be identical on web and worker, or DMs fail to decrypt. |
| `META_GRAPH_API_VERSION` | env file | |
| `EMAIL_SERVER` | param: built from `GMAIL_ADDRESS` + `GMAIL_APP_PASSWORD` | `smtps://you%40gmail.com:<app password, no spaces>@smtp.gmail.com:465`. Web only. |
| `EMAIL_FROM` | param, default `OpenReply <GMAIL_ADDRESS>` | Must be the same Gmail address, or Gmail rewrites or rejects it. Web only. |
| `ALLOWED_EMAILS` | param | Comma-separated. Without it anyone who finds the URL can sign up. Web only. |
| `WEBHOOK_VERIFY_TOKEN` | env file | Direct Meta only. Same value goes into Meta's webhook config. |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET` | env file, if you add them | Direct Meta only. Not needed with Zernio. |

## worker

Start `npm run worker`. No domain, no port.

| Variable | Value / source | Notes |
| --- | --- | --- |
| `DATABASE_URL` | reference `${{Postgres.DATABASE_URL}}` | |
| `REDIS_URL` | reference `${{Redis.REDIS_URL}}?family=0` | |
| `NEXTAUTH_URL` | reference `https://${{web.RAILWAY_PUBLIC_DOMAIN}}` | Used for tracked links inside DMs. |
| `NEXTAUTH_SECRET` | env file | |
| `ENCRYPTION_KEY` | env file | Same as web. |
| `META_GRAPH_API_VERSION` | env file | |
| `WEBHOOK_VERIFY_TOKEN`, Meta app IDs/secrets | env file, if present | Direct Meta only. |
| `COMMENT_POLL_INTERVAL_MS`, `COMMENT_POLL_MAX_PER_SWEEP`, `COMMENT_POLL_LOOKBACK_HOURS` | optional | Defaults 300000 / 30 / 72 are fine. |

No `EMAIL_*` or `ALLOWED_EMAILS`: only the web app sends mail.

## cron

Start `sh scripts/cron.sh`. No domain. The script runs forever: `attach-next-reel` every 5 minutes, `refresh-tokens` and `snapshot-followers` daily at 05:00 UTC.

| Variable | Value / source | Notes |
| --- | --- | --- |
| `CRON_BASE_URL` | reference `http://${{web.RAILWAY_PRIVATE_DOMAIN}}:${{web.PORT}}` | Private network, plain http. Resolves to `http://web.railway.internal:3000`. |
| `CRON_SECRET` | env file | Same as web, or the routes answer 401. |

## Postgres and Redis

Nothing to set. Railway generates their credentials; the app services only reference them. Public URLs (`DATABASE_PUBLIC_URL`, `REDIS_PUBLIC_URL`) are only for connecting from your own machine, e.g. `railway connect Postgres`.
