#!/usr/bin/env bash
# 上線驗收：檢查 OpenReply 的 /api/health。
#
# 用法：scripts/verify/healthcheck.sh https://your-app.up.railway.app
#
# 對應 app/api/health/route.ts 的回應格式：
#   {
#     "status": "ok" | "degraded",
#     "checks": {
#       "database": { "status": "ok"|"error", "detail"? },
#       "redis":    { "status": "ok"|"error", "detail"? },
#       "queue":    { "status": "ok"|"error", "detail"?, "counts"?: {waiting,active,delayed,failed} },
#       "worker":   { "healthy": bool, "heartbeat": {pid,hostname,startedAt,checkedAt,...}|null,
#                     "ageMs": number|null, "error"? }
#     }
#   }
# 健康時 HTTP 200，任何一項不健康時 HTTP 503。
# worker 心跳每 30 秒寫一次 Redis（worker/dm-worker.ts），TTL 120 秒；
# ageMs 超過 120000 即判定不健康（lib/ops/worker-health.ts）。
#
# 需要 curl，以及 jq 或 node 其中之一來解析 JSON。
# 回傳值：0 = 全部健康；1 = 任一項不健康或無法連線；2 = 用法或環境錯誤。

set -u

BASE_URL="${1:-}"
if [ -z "$BASE_URL" ]; then
  echo "用法：$0 BASE_URL（例如 https://your-app.up.railway.app）" >&2
  exit 2
fi
BASE_URL="${BASE_URL%/}"
URL="$BASE_URL/api/health"

if ! command -v curl >/dev/null 2>&1; then
  echo "找不到 curl，無法檢查。" >&2
  exit 2
fi

if command -v jq >/dev/null 2>&1; then
  PARSER=jq
elif command -v node >/dev/null 2>&1; then
  PARSER=node
else
  echo "需要 jq 或 node 來解析 JSON，兩個都找不到。" >&2
  exit 2
fi

TMP_BODY="$(mktemp)"
trap 'rm -f "$TMP_BODY"' EXIT

echo "檢查 $URL"
HTTP_CODE="$(curl -sS -o "$TMP_BODY" -w '%{http_code}' --max-time 20 "$URL" 2>/dev/null)"
CURL_EXIT=$?

if [ $CURL_EXIT -ne 0 ] || [ -z "$HTTP_CODE" ] || [ "$HTTP_CODE" = "000" ]; then
  echo "❌ 無法連線到 $URL（curl exit $CURL_EXIT）。web 服務可能沒起來、網址錯誤，或網域尚未生效。"
  exit 1
fi

# 取欄位：統一輸出成 key=value，沒有值時為空字串。
extract() {
  if [ "$PARSER" = jq ]; then
    jq -r '
      def s(v): if v == null then "" else (v|tostring) end;
      "status=" + s(.status),
      "db=" + s(.checks.database.status),
      "db_detail=" + s(.checks.database.detail),
      "redis=" + s(.checks.redis.status),
      "redis_detail=" + s(.checks.redis.detail),
      "queue=" + s(.checks.queue.status),
      "queue_detail=" + s(.checks.queue.detail),
      "q_waiting=" + s(.checks.queue.counts.waiting),
      "q_active=" + s(.checks.queue.counts.active),
      "q_delayed=" + s(.checks.queue.counts.delayed),
      "q_failed=" + s(.checks.queue.counts.failed),
      "worker_healthy=" + s(.checks.worker.healthy),
      "worker_error=" + s(.checks.worker.error),
      "hb_checked=" + s(.checks.worker.heartbeat.checkedAt),
      "hb_started=" + s(.checks.worker.heartbeat.startedAt),
      "hb_host=" + s(.checks.worker.heartbeat.hostname),
      "hb_age=" + s(.checks.worker.ageMs)
    ' "$TMP_BODY"
  else
    node -e '
      const fs = require("fs");
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const c = j.checks || {};
      const s = (v) => (v === undefined || v === null ? "" : String(v));
      const q = c.queue || {}, qc = q.counts || {}, w = c.worker || {}, hb = w.heartbeat || {};
      const out = {
        status: j.status,
        db: (c.database || {}).status, db_detail: (c.database || {}).detail,
        redis: (c.redis || {}).status, redis_detail: (c.redis || {}).detail,
        queue: q.status, queue_detail: q.detail,
        q_waiting: qc.waiting, q_active: qc.active, q_delayed: qc.delayed, q_failed: qc.failed,
        worker_healthy: w.healthy, worker_error: w.error,
        hb_checked: hb.checkedAt, hb_started: hb.startedAt, hb_host: hb.hostname,
        hb_age: w.ageMs,
      };
      for (const [k, v] of Object.entries(out)) console.log(k + "=" + s(v).replace(/\n/g, " "));
    ' "$TMP_BODY"
  fi
}

if ! PARSED="$(extract 2>/dev/null)"; then
  echo "❌ HTTP $HTTP_CODE，但回應不是預期的 JSON："
  head -c 500 "$TMP_BODY"; echo
  exit 1
fi

get() { printf '%s\n' "$PARSED" | sed -n "s/^$1=//p" | head -n 1; }

FAIL=0
ok()  { echo "✅ $1"; }
bad() { echo "❌ $1"; FAIL=1; }

echo "HTTP $HTTP_CODE"

STATUS="$(get status)"
if [ "$STATUS" = "ok" ]; then ok "整體狀態：ok"; else bad "整體狀態：${STATUS:-（無）}（預期 ok）"; fi

DB="$(get db)"
if [ "$DB" = "ok" ]; then ok "資料庫（Postgres）：ok"
else bad "資料庫（Postgres）：${DB:-（無）} $(get db_detail)"; fi

REDIS="$(get redis)"
if [ "$REDIS" = "ok" ]; then ok "Redis：ok"
else bad "Redis：${REDIS:-（無）} $(get redis_detail)"; fi

QUEUE="$(get queue)"
if [ "$QUEUE" = "ok" ]; then
  ok "佇列（BullMQ）：ok — 等待 $(get q_waiting)、執行中 $(get q_active)、延遲 $(get q_delayed)、失敗 $(get q_failed)"
  Q_FAILED="$(get q_failed)"
  if [ -n "$Q_FAILED" ] && [ "$Q_FAILED" != "0" ]; then
    echo "   ⚠️  佇列裡有 $Q_FAILED 個失敗的工作（不影響健康判定，但請到 /logs 或 worker logs 查原因）"
  fi
else
  bad "佇列（BullMQ）：${QUEUE:-（無）} $(get queue_detail)"
fi

WH="$(get worker_healthy)"
HB_CHECKED="$(get hb_checked)"
HB_AGE="$(get hb_age)"
if [ -n "$HB_AGE" ]; then
  HB_AGE_S="$(( ${HB_AGE%.*} / 1000 ))"
  AGE_TEXT="，距今 ${HB_AGE_S} 秒"
else
  AGE_TEXT=""
fi
if [ "$WH" = "true" ]; then
  ok "Worker：healthy — 最後心跳 ${HB_CHECKED}${AGE_TEXT}（主機 $(get hb_host)，啟動於 $(get hb_started)）"
elif [ -z "$HB_CHECKED" ]; then
  bad "Worker：沒有心跳紀錄。worker 服務沒在跑、連到不同的 Redis，或已停超過 120 秒。$(get worker_error)"
else
  bad "Worker：心跳過期 — 最後心跳 ${HB_CHECKED}${AGE_TEXT}（超過 120 秒即判定不健康）"
fi

# 回應 code 與內容不一致時也當作失敗，避免被 proxy 或快取騙過。
if [ "$FAIL" -eq 0 ] && [ "$HTTP_CODE" != "200" ]; then
  bad "欄位都正常，但 HTTP 狀態碼是 $HTTP_CODE（預期 200）"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "結果：全部健康 ✅"
  exit 0
else
  echo "結果：有項目不健康 ❌"
  exit 1
fi
