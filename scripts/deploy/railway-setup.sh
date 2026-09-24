#!/usr/bin/env bash
# Provision OpenReply entirely on Railway (plan v2):
#
#   Postgres  Railway database        (reused if it already exists)
#   Redis     Railway database        (reused if it already exists)
#   web       Dockerfile, `npm run start`, pre-deploy `npm run db:migrate`, public domain
#   worker    Dockerfile, `npm run worker`
#   cron      Dockerfile, `sh scripts/cron.sh`, calls web over the private network
#
# All three app services build from the repo-root Dockerfile and differ only in
# their start command, so wget (cron), tsconfig + source (worker) and the
# generated Prisma client are the same everywhere.
#
# Written against Railway CLI 5.58. Run it yourself after `railway login`.
# Values not in .env.production.local are parameters, passed as env vars:
#
#   Required
#     GITHUB_REPO         owner/repo of the fork (e.g. gal111111/openreply)
#     GMAIL_ADDRESS + GMAIL_APP_PASSWORD   login mail through Gmail SMTP,
#                         or EMAIL_SERVER (a full smtps:// URL) + EMAIL_FROM
#
#   Recommended
#     ALLOWED_EMAILS      comma-separated sign-in allowlist. Without it anyone who
#                         reaches the URL can sign up, so the script stops unless
#                         you pass ALLOW_OPEN_SIGNUP=1.
#
#   Optional
#     EMAIL_FROM          default: OpenReply <GMAIL_ADDRESS>
#     RAILWAY_PROJECT     project ID or name           (default: openreply)
#     RAILWAY_WORKSPACE   workspace ID or name         (default: My Projects)
#     RAILWAY_ENVIRONMENT (default: production)
#     GITHUB_BRANCH       (default: main)
#     WEB_SERVICE / WORKER_SERVICE / CRON_SERVICE   (default: web / worker / cron)
#     POSTGRES_SERVICE / REDIS_SERVICE              (default: Postgres / Redis)
#     WEB_PORT            port next start listens on (default: 3000)
#     ENV_FILE            (default: <repo>/.env.production.local)
#     DRY_RUN=1           print the railway commands, change nothing
#
# Secrets go to Railway on stdin (`variable set KEY --stdin`), never on the
# command line, and are never echoed.

set -euo pipefail
set +x

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

RAILWAY_PROJECT="${RAILWAY_PROJECT:-openreply}"
RAILWAY_WORKSPACE="${RAILWAY_WORKSPACE:-My Projects}"
RAILWAY_ENVIRONMENT="${RAILWAY_ENVIRONMENT:-production}"
GITHUB_BRANCH="${GITHUB_BRANCH:-main}"
WEB_SERVICE="${WEB_SERVICE:-web}"
WORKER_SERVICE="${WORKER_SERVICE:-worker}"
CRON_SERVICE="${CRON_SERVICE:-cron}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-Postgres}"
REDIS_SERVICE="${REDIS_SERVICE:-Redis}"
WEB_PORT="${WEB_PORT:-3000}"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env.production.local}"
DRY_RUN="${DRY_RUN:-0}"
ENV_ARGS=(--environment "$RAILWAY_ENVIRONMENT")

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] railway $*"
  else
    railway "$@"
  fi
}

# set_var SERVICE KEY VALUE — value goes through stdin, never argv or the log.
set_var() {
  local service="$1" key="$2" value="$3"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] railway variable set $key --stdin --service $service ${ENV_ARGS[*]} --skip-deploys   (value hidden)"
    return
  fi
  printf '%s' "$value" | railway variable set "$key" --stdin \
    --service "$service" "${ENV_ARGS[@]}" --skip-deploys >/dev/null
  echo "    $service: set $key"
}

service_exists() {
  [[ "$DRY_RUN" == "1" ]] && return 1
  railway service list "${ENV_ARGS[@]}" --json 2>/dev/null \
    | jq -e --arg n "$1" '[.. | objects | select(.name? == $n)] | length > 0' >/dev/null
}

# ensure_service NAME ARGS-FOR-railway-add...
ensure_service() {
  local name="$1"; shift
  if service_exists "$name"; then
    echo "    $name exists, skipping"
    return
  fi
  # `add --service` otherwise stops at an interactive "Enter a variable"
  # prompt in a TTY. --json is the CLI's machine mode, and stdin from
  # /dev/null means any prompt that still appears gets EOF instead of waiting.
  # Variables are set later with `variable set`.
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] railway add $* --json </dev/null"
  else
    railway add "$@" --json </dev/null >/dev/null
  fi
  if [[ "$DRY_RUN" != "1" ]] && ! service_exists "$name"; then
    die "added a service but none is named '$name'. Check \`railway service list\` and rerun with the matching *_SERVICE=<name>."
  fi
}

# configure_app SERVICE START_COMMAND RESTART_POLICY [more --service-config triples]
configure_app() {
  local service="$1" start="$2" restart="$3"; shift 3
  run environment edit "${ENV_ARGS[@]}" \
    --service-config "$service" build.builder DOCKERFILE \
    --service-config "$service" build.dockerfilePath Dockerfile \
    --service-config "$service" deploy.startCommand "$start" \
    --service-config "$service" deploy.restartPolicyType "$restart" \
    "$@" \
    --message "OpenReply $service: Dockerfile, $start"
}

# ── Preflight ────────────────────────────────────────────────────────────────
step "Preflight"
command -v railway >/dev/null || die "railway CLI not found"
command -v jq >/dev/null || die "jq not found"
command -v node >/dev/null || die "node not found (used to URL-encode the SMTP URL)"
[[ -f "$ENV_FILE" ]] || die "missing $ENV_FILE"
[[ -n "${GITHUB_REPO:-}" ]] || die "GITHUB_REPO (owner/repo of your fork) is required"
[[ "$GITHUB_REPO" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]] || die "GITHUB_REPO must look like owner/repo"
[[ "$WEB_PORT" =~ ^[0-9]+$ ]] || die "WEB_PORT must be a number"

# Load the shared secrets without echoing them.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

for key in NEXTAUTH_SECRET CRON_SECRET ENCRYPTION_KEY META_GRAPH_API_VERSION; do
  [[ -n "${!key:-}" ]] || die "$key is missing from $ENV_FILE"
done
[[ "$ENCRYPTION_KEY" =~ ^[0-9a-fA-F]{64}$ ]] || die "ENCRYPTION_KEY in $ENV_FILE is not 64 hex characters"

if [[ -z "${EMAIL_SERVER:-}" ]]; then
  [[ -n "${GMAIL_ADDRESS:-}" && -n "${GMAIL_APP_PASSWORD:-}" ]] \
    || die "login mail needs GMAIL_ADDRESS + GMAIL_APP_PASSWORD (or EMAIL_SERVER + EMAIL_FROM)"
  # Gmail shows app passwords in groups of four; SMTP wants them without spaces.
  EMAIL_SERVER="$(GA="$GMAIL_ADDRESS" GP="${GMAIL_APP_PASSWORD// /}" node -e \
    'process.stdout.write(`smtps://${encodeURIComponent(process.env.GA)}:${encodeURIComponent(process.env.GP)}@smtp.gmail.com:465`)')"
fi
[[ "$EMAIL_SERVER" =~ ^smtps?:// ]] || die "EMAIL_SERVER must start with smtps:// or smtp://"
if [[ -z "${EMAIL_FROM:-}" ]]; then
  [[ -n "${GMAIL_ADDRESS:-}" ]] || die "EMAIL_FROM is required when EMAIL_SERVER is given directly"
  EMAIL_FROM="OpenReply <$GMAIL_ADDRESS>"
fi
if [[ -z "${ALLOWED_EMAILS:-}" && "${ALLOW_OPEN_SIGNUP:-0}" != "1" ]]; then
  die "ALLOWED_EMAILS is empty, so anyone could sign up. Set it, or pass ALLOW_OPEN_SIGNUP=1 to accept that."
fi

if [[ "$DRY_RUN" != "1" ]]; then
  railway whoami >/dev/null 2>&1 || die "not logged in; run \`railway login\` first"
fi

# ── Project ──────────────────────────────────────────────────────────────────
# Reuse the project if this directory is already linked to it; otherwise link
# it by ID or name; create it only if that fails.
step "Project $RAILWAY_PROJECT"
linked=0
if [[ "$DRY_RUN" != "1" ]] && status_json="$(railway status --json 2>/dev/null)"; then
  if jq -e --arg p "$RAILWAY_PROJECT" \
       '[.. | objects | select(.name? == $p or .id? == $p)] | length > 0' \
       <<<"$status_json" >/dev/null; then
    linked=1
    echo "    already linked"
  else
    die "this directory is linked to a different Railway project. Run \`railway unlink\` or set RAILWAY_PROJECT."
  fi
fi
if [[ "$linked" == "0" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    run link --project "$RAILWAY_PROJECT" --workspace "$RAILWAY_WORKSPACE" "${ENV_ARGS[@]}"
  elif ! railway link --project "$RAILWAY_PROJECT" --workspace "$RAILWAY_WORKSPACE" "${ENV_ARGS[@]}"; then
    echo "    could not link '$RAILWAY_PROJECT'; creating it"
    railway init --name "$RAILWAY_PROJECT" --workspace "$RAILWAY_WORKSPACE"
    railway environment link "$RAILWAY_ENVIRONMENT"
  fi
fi

# ── Databases ────────────────────────────────────────────────────────────────
step "Databases"
ensure_service "$POSTGRES_SERVICE" --database postgres
ensure_service "$REDIS_SERVICE" --database redis

# ── App services (empty; sources are connected last) ─────────────────────────
step "App services"
ensure_service "$WEB_SERVICE" --service "$WEB_SERVICE"
ensure_service "$WORKER_SERVICE" --service "$WORKER_SERVICE"
ensure_service "$CRON_SERVICE" --service "$CRON_SERVICE"

# ── Build / start settings ───────────────────────────────────────────────────
# Same content as scripts/deploy/railway.{web,worker,cron}.json.
step "Build and start settings"
# `-- --hostname ::` makes next start listen on IPv6 as well, so cron can reach
# it over Railway's private network. Migrations run in pre-deploy, which can
# reach Postgres; the Docker build cannot.
configure_app "$WEB_SERVICE" "npm run start -- --hostname ::" ON_FAILURE \
  --service-config "$WEB_SERVICE" deploy.preDeployCommand "npm run db:migrate"
configure_app "$WORKER_SERVICE" "npm run worker" ALWAYS
configure_app "$CRON_SERVICE" "sh scripts/cron.sh" ALWAYS

# ── Public domain for web (before variables, so RAILWAY_PUBLIC_DOMAIN exists) ─
step "Domain for $WEB_SERVICE"
if [[ "$DRY_RUN" != "1" ]] \
   && railway domain list --service "$WEB_SERVICE" "${ENV_ARGS[@]}" --json 2>/dev/null \
      | jq -e '[.. | strings | select(endswith(".up.railway.app"))] | length > 0' >/dev/null; then
  echo "    $WEB_SERVICE already has a Railway domain, skipping"
else
  run domain --service "$WEB_SERVICE" --port "$WEB_PORT" "${ENV_ARGS[@]}"
fi

# ── Variables ────────────────────────────────────────────────────────────────
# ${{Service.VAR}} are Railway reference variables, resolved at deploy time.
# Postgres and Redis use their internal URLs; family=0 lets ioredis resolve
# IPv6 on the private network.
DB_REF="\${{${POSTGRES_SERVICE}.DATABASE_URL}}"
REDIS_REF="\${{${REDIS_SERVICE}.REDIS_URL}}?family=0"
PUBLIC_URL_REF="https://\${{${WEB_SERVICE}.RAILWAY_PUBLIC_DOMAIN}}"

step "Variables: $WEB_SERVICE"
set_var "$WEB_SERVICE" PORT "$WEB_PORT"
set_var "$WEB_SERVICE" DATABASE_URL "$DB_REF"
set_var "$WEB_SERVICE" REDIS_URL "$REDIS_REF"
set_var "$WEB_SERVICE" NEXTAUTH_URL "$PUBLIC_URL_REF"
set_var "$WEB_SERVICE" NEXTAUTH_SECRET "$NEXTAUTH_SECRET"
set_var "$WEB_SERVICE" CRON_SECRET "$CRON_SECRET"
set_var "$WEB_SERVICE" ENCRYPTION_KEY "$ENCRYPTION_KEY"
set_var "$WEB_SERVICE" META_GRAPH_API_VERSION "$META_GRAPH_API_VERSION"
set_var "$WEB_SERVICE" EMAIL_SERVER "$EMAIL_SERVER"
set_var "$WEB_SERVICE" EMAIL_FROM "$EMAIL_FROM"
if [[ -n "${ALLOWED_EMAILS:-}" ]]; then
  set_var "$WEB_SERVICE" ALLOWED_EMAILS "$ALLOWED_EMAILS"
fi

step "Variables: $WORKER_SERVICE"
set_var "$WORKER_SERVICE" DATABASE_URL "$DB_REF"
set_var "$WORKER_SERVICE" REDIS_URL "$REDIS_REF"
set_var "$WORKER_SERVICE" NEXTAUTH_URL "$PUBLIC_URL_REF"
set_var "$WORKER_SERVICE" NEXTAUTH_SECRET "$NEXTAUTH_SECRET"
set_var "$WORKER_SERVICE" ENCRYPTION_KEY "$ENCRYPTION_KEY"
set_var "$WORKER_SERVICE" META_GRAPH_API_VERSION "$META_GRAPH_API_VERSION"

# Direct-Meta variables and poll tuning: set only when present in the env file
# or the calling shell. Meta goes to web and worker; polling only to worker.
for key in WEBHOOK_VERIFY_TOKEN INSTAGRAM_APP_ID INSTAGRAM_APP_SECRET FACEBOOK_APP_SECRET; do
  if [[ -n "${!key:-}" ]]; then
    set_var "$WEB_SERVICE" "$key" "${!key}"
    set_var "$WORKER_SERVICE" "$key" "${!key}"
  fi
done
for key in COMMENT_POLL_INTERVAL_MS COMMENT_POLL_MAX_PER_SWEEP COMMENT_POLL_LOOKBACK_HOURS; do
  if [[ -n "${!key:-}" ]]; then
    set_var "$WORKER_SERVICE" "$key" "${!key}"
  fi
done

step "Variables: $CRON_SERVICE"
set_var "$CRON_SERVICE" CRON_BASE_URL "http://\${{${WEB_SERVICE}.RAILWAY_PRIVATE_DOMAIN}}:\${{${WEB_SERVICE}.PORT}}"
set_var "$CRON_SERVICE" CRON_SECRET "$CRON_SECRET"

# ── Connect the fork (each connect triggers that service's first deploy) ─────
step "Connect $GITHUB_REPO@$GITHUB_BRANCH"
for service in "$WEB_SERVICE" "$WORKER_SERVICE" "$CRON_SERVICE"; do
  run service source connect --repo "$GITHUB_REPO" --branch "$GITHUB_BRANCH" \
    --service "$service" "${ENV_ARGS[@]}"
done

step "Done"
cat <<EOF
Now work through "Verify" in scripts/deploy/README.md:
  railway logs --service $WEB_SERVICE --build        # Dockerfile build
  railway logs --service $WEB_SERVICE --deployment   # pre-deploy migrate, then next start
  railway logs --service $CRON_SERVICE               # "[cron] ... ok"
  railway domain list --service $WEB_SERVICE         # public URL; open /api/health
EOF
