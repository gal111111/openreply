#!/usr/bin/env bash
# 互動式包裝：逐項詢問後呼叫 railway-setup.sh。密碼隱藏輸入，不寫入任何檔案或歷史。
# 用法：scripts/deploy/run-interactive.sh          （模擬執行，不改任何東西）
#       scripts/deploy/run-interactive.sh --real   （正式部署）
set -euo pipefail
cd "$(dirname "$0")/../.."

read -r -p "寄信用的 Gmail（新建的那個）: " GMAIL_ADDRESS
read -r -p "允許登入後台的信箱（多個用逗號分隔）: " ALLOWED_EMAILS
read -r -s -p "Gmail 應用程式密碼（16 碼，輸入時不會顯示）: " GMAIL_APP_PASSWORD
echo
GMAIL_APP_PASSWORD="${GMAIL_APP_PASSWORD// /}"

if [[ "$GMAIL_ADDRESS" != *@* || "$ALLOWED_EMAILS" != *@* ]]; then
  echo "信箱格式不對，請重新執行。" >&2; exit 1
fi
if [[ ${#GMAIL_APP_PASSWORD} -ne 16 ]]; then
  echo "應用程式密碼應為 16 碼（目前 ${#GMAIL_APP_PASSWORD} 碼），請重新執行。" >&2; exit 1
fi

DRY=1
[[ "${1:-}" == "--real" ]] && DRY=0
echo "模式：$([[ $DRY == 1 ]] && echo 模擬執行 || echo 正式部署)"

GITHUB_REPO=gal111111/openreply GMAIL_ADDRESS="$GMAIL_ADDRESS" ALLOWED_EMAILS="$ALLOWED_EMAILS" \
  GMAIL_APP_PASSWORD="$GMAIL_APP_PASSWORD" DRY_RUN="$DRY" scripts/deploy/railway-setup.sh
