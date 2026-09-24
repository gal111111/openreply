# Deploying OpenReply on Railway

Everything in one Railway project, `openreply` (workspace "My Projects"): Postgres, Redis, and three app services built from the repo-root `Dockerfile`. Login mail goes out through Gmail SMTP. Nothing in this folder runs by itself; you run each step.

| Service | Start command | Extra |
| --- | --- | --- |
| `Postgres`, `Redis` | Railway databases | reused if they already exist |
| `web` | `npm run start -- --hostname ::` | pre-deploy `npm run db:migrate`, public domain on port 3000 |
| `worker` | `npm run worker` | restarts always, no domain |
| `cron` | `sh scripts/cron.sh` | restarts always, calls web over the private network |

| File | What it is |
| --- | --- |
| `railway-setup.sh` | Links or creates the project, reuses or adds Postgres and Redis, creates `web`/`worker`/`cron`, sets build/start settings, generates web's domain, sets every variable, connects the fork. `DRY_RUN=1` prints the commands only. Safe to rerun: existing services and domain are skipped, variables are overwritten with the same values. |
| `railway.web.json`, `railway.worker.json`, `railway.cron.json` | The same build/deploy settings as config-as-code. The script sets them through the CLI; these are the fallback if the CLI settings do not take (see Verify). |
| `railway-env.md` | Every variable on each service and where it comes from. |

Shared secrets (`NEXTAUTH_SECRET`, `CRON_SECRET`, `ENCRYPTION_KEY`, `WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_API_VERSION`) live in `.env.production.local` at the repo root, which is gitignored. The script reads it without printing it.

## Order

### 0. Before you start

- Fork `gal111111/openreply` exists, and the Railway GitHub App can see it.
- `railway login` done (`railway whoami` works). CLI 5.58, `jq`, `node` installed.
- Gmail account with 2-Step Verification and an app password (myaccount.google.com → Security → App passwords).

### 1. Dry run

```bash
DRY_RUN=1 GITHUB_REPO=gal111111/openreply GMAIL_ADDRESS='you@gmail.com' GMAIL_APP_PASSWORD='xxxx xxxx xxxx xxxx' ALLOWED_EMAILS='you@gmail.com' ./scripts/deploy/railway-setup.sh
```

Read the printed commands. Values are hidden.

### 2. Run it

Same line without `DRY_RUN=1`. The app password lands in shell history; clear it afterwards if that matters to you.

Order inside the script: link `openreply` (or create it if linking fails) → Postgres, Redis (skipped if present) → empty `web`, `worker`, `cron` → build/start settings via `railway environment edit` → `railway domain` for web → variables → `service source connect` for each service, which triggers the first deploys.

### 3. Verify

These are the settings the script could not confirm from `--help` alone. Check each on the first deploy.

1. **Build settings took.** `railway logs --service web --build` shows a Docker build of `Dockerfile` (`npm ci`, then `npm run build`). In the dashboard, each service's Settings shows the start command from the table above. If not, commit `scripts/deploy/railway.<service>.json` to the fork, set that service's Settings → Config-as-code path to `/scripts/deploy/railway.<service>.json`, and redeploy.
2. **Pre-deploy migration ran.** `railway logs --service web --deployment` shows `prisma migrate deploy` applying or finding migrations before `next start`. If the dashboard shows no pre-deploy command, set it by hand to `npm run db:migrate`, or use `railway.web.json` as above.
3. **The Docker build succeeds without runtime variables.** The build does not see service variables (the Dockerfile declares no `ARG`), so `next build` and `prisma generate` must not need `DATABASE_URL` or `ENCRYPTION_KEY`. If the build fails on a missing variable, that is the cause.
4. **Reference variables resolved.** `railway variable list --service cron` should show `CRON_BASE_URL` as `http://web.railway.internal:3000`, and web's `NEXTAUTH_URL` as `https://<something>.up.railway.app`. This output prints secrets; do not paste it anywhere.
5. **cron reaches web.** `railway logs --service cron` shows `[cron] … attach-next-reel ok` within 5 minutes. `FAILED … connection refused` means web is not listening on the private network: check web's start command has `--hostname ::`. A 401 means `CRON_SECRET` differs between cron and web.
6. **Everything is healthy.** Open `https://<web domain>/api/health` (`railway domain list --service web`). Expect `status: ok` and `worker.healthy: true`. `degraded` with the worker unhealthy means it is not running or cannot reach Redis: `railway logs --service worker`.
7. **Login mail arrives.** Sign in with an address in `ALLOWED_EMAILS`; the magic link comes from your Gmail.

Then connect Instagram (Zernio or direct Meta) per `docs/setup.md`, using the web domain wherever it says your Vercel domain.

## Values you fill in by hand

| Parameter | Goes to | Where you get it |
| --- | --- | --- |
| `GITHUB_REPO` | all three services' source | `gal111111/openreply` |
| `GMAIL_ADDRESS` | web `EMAIL_SERVER`, `EMAIL_FROM` | your Gmail |
| `GMAIL_APP_PASSWORD` | web `EMAIL_SERVER` | Google account → App passwords |
| `ALLOWED_EMAILS` | web | your sign-in address(es) |
| Meta app IDs/secrets | web + worker, via `.env.production.local` | only for direct Meta, not Zernio |

Everything else is either in `.env.production.local` or a Railway reference variable.

## Things to watch

- `ENCRYPTION_KEY` must be identical on web and worker. Changing it later forces every Instagram account to reconnect.
- A custom domain later: add it to web, then replace `NEXTAUTH_URL` on web and worker with the literal URL, and update Meta's redirect and webhook URLs.
- Do not add a web healthcheck on `/api/health`: it returns 503 while the worker is down, which would block web deploys.
- If you rotate a secret in `.env.production.local`, rerun the script or update the service by hand.
