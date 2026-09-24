# 確認 cron 服務有在執行

Railway 上的 `cron` 服務跑的是 `sh scripts/cron.sh`：一個常駐迴圈，每 30 秒醒來一次，時間到了就用 `wget` 帶 `Authorization: Bearer $CRON_SECRET` 去打 web 的 `/api/cron/<route>`。它本身不是 Railway 的 Cron Schedule 功能，所以服務要一直是 **Running**（restart policy ALWAYS），不會出現「每次執行一個 deployment」的紀錄。

## 排程（全部用 UTC）

| 路由 | 頻率 | 台灣時間 |
| --- | --- | --- |
| `attach-next-reel` | 每 5 分鐘（分鐘數為 00、05、10…55） | 同 |
| `refresh-tokens` | 每天 05:00–05:59 UTC 之間跑一次 | 每天 13:00 左右 |
| `snapshot-followers` | 緊接在 `refresh-tokens` 之後 | 每天 13:00 左右 |

## 1. 看 Railway logs

在 Railway 專案 → `cron` 服務 → **Logs**（或 CLI：`railway logs --service cron`，唯讀）。`scripts/cron.sh` 的輸出格式固定如下：

| 你要找的字串 | 代表什麼 | 算不算正常 |
| --- | --- | --- |
| `[cron] scheduler started, target http://web.railway.internal:3000` | 容器剛啟動，後面是它要打的網址 | 正常。target 應該是 web 的私有網域，不應該是 `http://web:3000`（那是 docker compose 的預設值，代表 `CRON_BASE_URL` 沒設） |
| `[cron] 2026-09-21 03:05:01 attach-next-reel ok {"success":true,...}` | 每 5 分鐘一次，呼叫成功，後面接的是 API 回傳的 JSON | 正常。服務啟動後 **5 分鐘內**一定要出現第一筆 |
| `[cron] 2026-09-22 05:00:12 refresh-tokens ok {"success":true,"data":{"totalProcessed":0,"workspacesReset":0,"results":[]}}` | 每日的 token 更新 | 正常，但要看 JSON 內容，見下方第 2 節 |
| `[cron] 2026-09-22 05:00:15 snapshot-followers ok {...}` | 每日追蹤數快照 | 正常 |
| `[cron] <時間> <route> FAILED <原因>` | 呼叫失敗（寫到 stderr，Railway 可能標成紅色／error） | **不正常** |
| `[cron] neither CRON_SECRET nor NEXTAUTH_SECRET is set — the routes would answer 401` | cron 服務沒設密鑰，腳本直接 exit 1，會一直重啟 | **不正常** |

Railway logs 的搜尋框可以直接輸入：

- `attach-next-reel ok` → 應該每 5 分鐘一筆，連續不中斷
- `refresh-tokens` → 每天一筆
- `FAILED` → 應該零筆

### FAILED 常見原因

`FAILED` 後面接的是 wget 的錯誤訊息：

- `Connection refused` / `can't connect` / `bad address`：cron 連不到 web。檢查 cron 的 `CRON_BASE_URL` 是否為 `http://${{web.RAILWAY_PRIVATE_DOMAIN}}:${{web.PORT}}` 解析出來的值，以及 web 的啟動指令有沒有 `--hostname ::`（Railway 私有網路走 IPv6）。
- `server returned error: HTTP/1.1 401 Unauthorized`：cron 和 web 的 `CRON_SECRET` 不一致（兩邊都沒設 `CRON_SECRET` 時，會退回比對 `NEXTAUTH_SECRET`）。
- `HTTP/1.1 500`：路由本身出錯，去看 web 服務同一時間的 logs。
- `wget: not found`：cron 服務不是用 repo 的 `Dockerfile` 建的（Dockerfile 有另外裝 wget，node:20-slim 預設沒有）。

## 2. 確認 refresh-tokens 真的有更新 token

`app/api/cron/refresh-tokens/route.ts` 的行為：

- 只處理 `provider = 'META'`、`accessToken` 非空、且 `tokenExpiresAt` 在 **10 天內到期**的 Instagram 帳號。
- 剛連好的帳號 token 約 60 天有效，所以前 50 天左右 log 會一直是 `"totalProcessed":0`——**這是正常的**，不代表壞掉。
- 注意：就算個別帳號更新失敗，log 仍然是 `refresh-tokens ok`（HTTP 200），失敗會寫在 JSON 的 `results[].status = "failed"` 和 `error`。所以要看 JSON 內容，不能只看 `ok`。

### 成功時資料庫會更新的欄位

資料表 `"InstagramAccount"`（`prisma/schema.prisma`，沒有 `@@map`，表名就是模型名）：

| 欄位 | 變化 |
| --- | --- |
| `tokenExpiresAt` | **主要看這個**：更新成「現在 + Meta 回傳的 expiresIn」，約 60 天後 |
| `accessToken` | 換成新的（加密過，看不出內容，只能看出字串變了） |
| `updatedAt` | Prisma 的 `@updatedAt`，會變成這次執行的時間 |

同一支路由每月還會重設用量：`"Workspace"."usagePeriodStart"` 改成當月 1 號、`"dmsSentThisPeriod"` 歸 0（log 裡的 `workspacesReset` 就是被重設的 workspace 數）。

失敗時不會改上面欄位，而是在 `"OperationalEvent"` 新增一筆 `source = 'TOKEN_REFRESH'`、`level = 'ERROR'`、`message = 'Token refresh failed for @<username>: <原因>'`。

### 查詢用的 SQL（在 Railway Postgres 的 Data / Query 頁面執行，唯讀）

```sql
-- 每個帳號的 token 還剩幾天
SELECT username, provider, "tokenExpiresAt",
       round(extract(epoch FROM ("tokenExpiresAt" - now())) / 86400) AS days_left,
       "updatedAt"
FROM "InstagramAccount"
ORDER BY "tokenExpiresAt";

-- 最近的 token 更新失敗
SELECT "createdAt", message
FROM "OperationalEvent"
WHERE source = 'TOKEN_REFRESH'
ORDER BY "createdAt" DESC
LIMIT 10;
```

判讀：

- `days_left` 應該一直大於 0。如果有帳號掉到 10 以下又過了一天還沒回到 ~60，代表 refresh 沒成功——看 log 的 `results` 和上面的 `OperationalEvent`。
- `days_left` 是負的：token 已過期，所有自動私訊都會停，而且不會有任何錯誤提示。要請使用者在 Settings 重新連接 Instagram。

## 3. 想立刻驗證、不想等到隔天 13:00

手動打一次路由（這會連網並讀寫正式資料庫，由操作者自己決定是否執行；密鑰不要貼到任何地方）：

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" https://<web 網域>/api/cron/refresh-tokens
```

預期回應 `{"success":true,"data":{"totalProcessed":N,"workspacesReset":N,"results":[...]}}`；回 `{"success":false,"error":"Unauthorized"}` 就是密鑰錯。

## 通過標準

- [ ] cron 服務狀態為 Running，logs 開頭有 `scheduler started`，target 是 web 的私有網域
- [ ] 啟動後 5 分鐘內出現 `attach-next-reel ok`，之後每 5 分鐘一筆
- [ ] 過了一個 05:00 UTC（台灣 13:00）後，出現 `refresh-tokens ok` 和 `snapshot-followers ok` 各一筆
- [ ] logs 搜尋 `FAILED` 為零筆
- [ ] `refresh-tokens` 回應裡沒有 `"status":"failed"`，`"OperationalEvent"` 沒有新的 `TOKEN_REFRESH` 錯誤
- [ ] 所有 META 帳號的 `tokenExpiresAt` 都在未來
