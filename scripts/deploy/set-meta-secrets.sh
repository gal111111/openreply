#!/usr/bin/env bash
# 隱藏輸入兩組 Meta 密鑰，寫入 Railway 的 web 與 worker，然後重新部署兩者。
# 值不會顯示、不寫入檔案或 shell 歷史。
set -euo pipefail
cd "$(dirname "$0")/../.."

read -r -s -p "Instagram 應用程式密鑰（Instagram API 頁面，按「顯示」）: " IG_SECRET; echo
read -r -s -p "Facebook 應用程式密鑰（應用程式設定 → 基本資料，按「顯示」）: " FB_SECRET; echo

for v in IG_SECRET FB_SECRET; do
  val="${!v// /}"
  if [[ ! "$val" =~ ^[0-9a-f]{32}$ ]]; then
    echo "$v 格式不對（應為 32 碼英數），請重新執行。" >&2; exit 1
  fi
done
[[ "$IG_SECRET" == "$FB_SECRET" ]] && echo "注意：兩組密鑰相同，請確認沒有貼錯。"

for s in web worker; do
  printf '%s' "$IG_SECRET" | railway variable set INSTAGRAM_APP_SECRET --stdin --service "$s" --skip-deploys >/dev/null
  printf '%s' "$FB_SECRET" | railway variable set FACEBOOK_APP_SECRET --stdin --service "$s" --skip-deploys >/dev/null
  echo "  $s: 已設定兩組密鑰"
done

echo "重新部署 web 與 worker…"
railway redeploy --service web --yes >/dev/null && echo "  web: 重新部署中"
railway redeploy --service worker --yes >/dev/null && echo "  worker: 重新部署中"
echo "完成。"
