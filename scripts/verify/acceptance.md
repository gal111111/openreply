# OpenReply 上線驗收清單（Railway）

架構：`web`（Next.js）、`worker`（BullMQ，`npm run worker`）、`cron`（`sh scripts/cron.sh`）、Postgres、Redis，全部在同一個 Railway 專案。

以下「資料庫」指 Railway Postgres 的 Data / Query 頁面。Prisma schema 沒有 `@@map`，表名就是模型名，查詢時要加雙引號（例如 `"DmLog"`）。所有 SQL 都是唯讀查詢。

驗收順序建議照編號走：前面的項目沒過，後面的必定失敗。

---

## 0. 事前準備

- [ ] web 服務變數有：`NEXTAUTH_URL`（= web 的正式 https 網址，**不能是 localhost**，追蹤連結和登入信的網址都從這裡來）、`NEXTAUTH_SECRET`、`DATABASE_URL`、`REDIS_URL`、`ENCRYPTION_KEY`、`CRON_SECRET`、`WEBHOOK_VERIFY_TOKEN`、`FACEBOOK_APP_SECRET`（或 `INSTAGRAM_APP_SECRET`）、寄信設定（`EMAIL_SERVER` + `EMAIL_FROM`，或 `RESEND_API_KEY` + `EMAIL_FROM`）、`ALLOWED_EMAILS`
- [ ] worker 和 web 用的是**同一個** `DATABASE_URL`、`REDIS_URL`、`ENCRYPTION_KEY`
- [ ] 準備兩個 IG 帳號：A = 要接上 OpenReply 的商業／創作者帳號；B = 另一個帳號，用來留言和回覆限動（**用 A 自己留言會被刻意忽略**）

---

## 1. `/api/health`

**在哪裡看：** 本機終端機執行

```bash
scripts/verify/healthcheck.sh https://<web 網域>
```

**通過：**

- [ ] 輸出最後一行是 `結果：全部健康 ✅`，exit code 0
- [ ] 資料庫、Redis、佇列都是 `ok`
- [ ] Worker 是 `healthy`，最後心跳距今少於 60 秒（worker 每 30 秒寫一次心跳，超過 120 秒判定不健康）

**沒過時：**

- `Worker：沒有心跳紀錄` → worker 服務沒在跑，或 worker 的 `REDIS_URL` 跟 web 指到不同 Redis。看 worker logs 有沒有 `[DM Worker] Started`、有沒有 `[DM Worker] Heartbeat failed`。
- `資料庫` / `Redis` 是 error → 看後面接的錯誤訊息，通常是連線字串錯或服務沒起來。

---

## 2. Magic link 登入信

**操作：** 瀏覽器開 `https://<web 網域>/login`，輸入一個**在 `ALLOWED_EMAILS` 名單裡**的信箱，送出。

**在哪裡看、通過標準：**

- [ ] 瀏覽器跳到 `/verify-request` 頁
- [ ] 1 分鐘內收到登入信，寄件人是 `EMAIL_FROM` 設定的地址（沒收到先看垃圾郵件匣）
- [ ] 信裡的連結網域是正式網域（不是 `localhost`，否則是 `NEXTAUTH_URL` 設錯）
- [ ] 點連結後進到後台，不是回到 `/login`
- [ ] 資料庫：

  ```sql
  SELECT u.email, u."createdAt", w.name AS workspace
  FROM "User" u
  LEFT JOIN "WorkspaceMember" m ON m."userId" = u.id
  LEFT JOIN "Workspace" w ON w.id = m."workspaceId"
  ORDER BY u."createdAt" DESC LIMIT 5;
  ```

  看到這個信箱，且有對應的 workspace（第一次登入時會自動建立）

**沒過時：** web logs 搜尋 `nodemailer`、`resend`、`EAUTH`、`Invalid login`。用 Gmail SMTP 時 `EMAIL_SERVER` 要用應用程式密碼，特殊字元要 URL encode。

---

## 3. `ALLOWED_EMAILS` 以外的信箱被拒

`lib/auth.ts` 的 `signIn` callback 會在**寄信之前**呼叫 `isEmailAllowedToSignIn`（`lib/env.ts`），比對時不分大小寫。

**操作：** 登出後回 `/login`，輸入一個**不在名單裡**的信箱，送出。

**通過標準：**

- [ ] 瀏覽器**沒有**進 `/verify-request`，而是回到登入頁，網址帶 `error=AccessDenied`
- [ ] 那個信箱**完全收不到**信（等 5 分鐘、含垃圾郵件匣）
- [ ] 資料庫沒有新增該信箱的使用者，也沒有為它建立登入 token：

  ```sql
  SELECT count(*) FROM "User" WHERE lower(email) = lower('<被拒的信箱>');               -- 應為 0
  SELECT count(*) FROM "VerificationToken" WHERE lower(identifier) = lower('<被拒的信箱>'); -- 應為 0
  ```

- [ ] 再用名單內信箱的**大寫版本**（例如 `You@Example.com`）試一次，應該可以正常收到信（驗證不分大小寫）

**注意：** `ALLOWED_EMAILS` 沒設或設成空字串時，**任何人都能註冊**。如果上面第一項竟然收到信，第一件事就是檢查 web 服務的這個變數。

---

## 4. TEST 留言 → WebhookEvent → DmLog SENT

**前置：**

- [ ] 後台 Settings 已連接 IG 帳號 A
- [ ] Meta App 的 Webhook callback URL 是 `https://<web 網域>/api/webhook`，Verify token 等於 `WEBHOOK_VERIFY_TOKEN`，訂閱欄位勾了 `comments`、`messages`（第 5 項要用）和 `messaging_postbacks`（開場私訊的按鈕要用，沒訂閱時按鈕按了不會補發連結，只能等已讀 5 分鐘後的後備機制）
- [ ] 建一個啟用中的活動（Campaign）：指定 A 的某篇貼文、關鍵字 `TEST`、私訊內容含一個連結（第 6 項要用）

**操作：** 用帳號 B 在那篇貼文留言 `TEST`。

**在哪裡看、通過標準：**

- [ ] 資料庫，留言後幾秒內出現一筆 webhook 事件：

  ```sql
  SELECT id, status, "workspaceId", "errorMessage", "createdAt", "processedAt"
  FROM "WebhookEvent"
  ORDER BY "createdAt" DESC LIMIT 5;
  ```

  `status = 'PROCESSED'`、`workspaceId` 不是 NULL、`errorMessage` 是 NULL。
  （`PROCESSED` 只代表「已放進佇列」，私訊是否送出要看下一步。）

- [ ] 資料庫，數秒到一分鐘內出現私訊紀錄：

  ```sql
  SELECT status, "commentText", "matchedKeyword", "commenterName",
         "dmSentAt", "errorMessage", "publicReplySentAt", "createdAt"
  FROM "DmLog"
  WHERE "commentId" NOT LIKE 'dm:%'
  ORDER BY "createdAt" DESC LIMIT 5;
  ```

  `status = 'SENT'`、`commentText = 'TEST'`、`matchedKeyword = 'TEST'`、`dmSentAt` 有值

- [ ] 帳號 B 的 IG 收件匣（可能在「訊息請求」裡）真的收到那則私訊
- [ ] 後台 `/logs` 頁面看到這筆，狀態為已送出

**沒過時，照順序查：**

1. **`WebhookEvent` 完全沒有新紀錄：**
   - 查 `SELECT "createdAt", message, payload FROM "OperationalEvent" WHERE message = 'Webhook signature verification failed' ORDER BY "createdAt" DESC LIMIT 5;` 有紀錄 → `FACEBOOK_APP_SECRET` 不是這個 Meta App 的 secret。
   - 沒有簽章錯誤 → Meta 根本沒打過來（callback URL、訂閱欄位、App 是否為 Live 模式／B 是否為測試者），或 webhook 裡的帳號 id 對不到 `"InstagramAccount"."instagramId"`（對不到時程式會直接忽略，不留紀錄）。
   - 用 Zernio 連接的帳號走的是 `/api/zernio/webhook/<workspaceId>`，不是 `/api/webhook`。
2. **`WebhookEvent` 是 `FAILED`：** 看 `errorMessage`，通常是 Redis／佇列連不上。
3. **有 `WebhookEvent` 但沒有 `DmLog`：** worker 沒在消化佇列。跑一次 `healthcheck.sh`，看 worker logs。
4. **`DmLog` 狀態不是 `SENT`：**
   - `FAILED` → 看 `errorMessage`（例如 `No Instagram access token available`、權限不足）
   - `SKIPPED_NO_MATCH` → 關鍵字沒對到（活動預設整字比對）
   - `SKIPPED_DEDUP` → B 之前已經觸發過同一個活動
   - `SKIPPED_RATE_LIMIT` / `SKIPPED_PLAN_LIMIT` → 觸發了頻率或方案上限

---

## 5. 限動回覆觸發

Instagram 把「回覆限動」當成一般私訊送來（webhook 的 `messages` 欄位），所以走的是活動的私訊觸發，不是留言觸發。

**前置：**

- [ ] 活動開啟「有人私訊這些關鍵字時也回覆」（資料庫欄位 `"Automation"."dmTriggerEnabled" = true`）
- [ ] Meta App 的 webhook 有訂閱 `messages`（只訂 `comments` 時這個開關看起來有開，但永遠不會觸發）
- [ ] 帳號 A 發一則限動

**操作：** 用帳號 B 回覆那則限動，**文字**內容是 `TEST`（貼圖、表情回應不會觸發，只處理有文字的訊息）。

**在哪裡看、通過標準：**

- [ ] `"WebhookEvent"` 新增一筆 `status = 'PROCESSED'`（同第 4 項的查詢）
- [ ] 資料庫：

  ```sql
  SELECT status, "commentId", "commentText", "matchedKeyword", "dmSentAt", "errorMessage", "createdAt"
  FROM "DmLog"
  WHERE "commentId" LIKE 'dm:%'
  ORDER BY "createdAt" DESC LIMIT 5;
  ```

  有一筆 `commentId` 是 `dm:<訊息 id>`、`commentText = 'TEST'`、`status = 'SENT'`

- [ ] 帳號 B 在同一個對話裡收到自動回覆

**沒過時：** 沒有 `WebhookEvent` → 幾乎都是 `messages` 沒訂閱；有 `WebhookEvent` 沒有 `DmLog` → 確認 `dmTriggerEnabled` 為 true 且活動 `isActive` 為 true。

---

## 6. 追蹤連結點擊計數

私訊裡的連結是 `https://<NEXTAUTH_URL 的網域>/r/<slug>`（`lib/tracking/message.ts`）。點擊時 `app/r/[slug]/route.ts` 會寫一筆 `"LinkClick"`，再 302 轉址到真正的目的網址。

**操作：**

1. 先記下目前的點擊數（後台 Campaigns 列表該活動的 `N clicks`，或下面 SQL）
2. 用帳號 B 在 IG 收到的私訊裡點那個連結／按鈕

**在哪裡看、通過標準：**

- [ ] 連結網域是正式網域，不是 `localhost:3000`
- [ ] 點下去後落在活動設定的目的網址（不是首頁；落到首頁代表 slug 找不到）
- [ ] 資料庫：

  ```sql
  SELECT t.slug, t.label, t."destinationUrl", count(c.id) AS clicks, max(c."createdAt") AS last_click
  FROM "TrackedLink" t
  LEFT JOIN "LinkClick" c ON c."trackedLinkId" = t.id
  GROUP BY t.id
  ORDER BY last_click DESC NULLS LAST
  LIMIT 5;
  ```

  該連結的 `clicks` 增加、`last_click` 是剛剛的時間

- [ ] 後台 Campaigns 列表該活動的 `clicks` 數字增加；Dashboard 的 Clicks 卡片（本月）也增加

**注意：** 每次請求都算一次點擊，沒有去重。IG 產生連結預覽時也可能打一次，所以一次點擊造成 +2 屬正常；只要有增加就算通過。

---

## 7. cron

見 [cron-check.md](cron-check.md)。至少要看到 `attach-next-reel ok` 每 5 分鐘一筆、沒有 `FAILED`。

---

## 驗收總表

| # | 項目 | 結果 | 備註 |
| --- | --- | --- | --- |
| 1 | `/api/health` 全部健康 | ☐ | |
| 2 | 名單內信箱收到 magic link 並能登入 | ☐ | |
| 3 | 名單外信箱被拒、收不到信 | ☐ | |
| 4 | TEST 留言 → `WebhookEvent` PROCESSED → `DmLog` SENT | ☐ | |
| 5 | 限動回覆 → `DmLog`（`dm:` 開頭）SENT | ☐ | |
| 6 | 追蹤連結點擊 → `LinkClick` 增加、後台計數增加 | ☐ | |
| 7 | cron 正常執行 | ☐ | |
