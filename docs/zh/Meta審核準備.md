# Meta 商家驗證與 App 審核準備（HL Reply）

**查證日期：** 2026-09-22（所有來源都在這一天讀取）
**對象：** Meta App「HL Reply」（Instagram API with Instagram Login，IG app id `1777871603401057`），主體為 Hobbyland 香港公司
**目標：** 由 Standard Access（只有 app 內有角色的人可用）升級到 Advanced Access，讓外部客人連接自己的 IG 帳號
**底稿：** repo 根目錄的 [`META_APP_REVIEW.md`](../../META_APP_REVIEW.md)

來源標記說明：

- **〔官〕**：Meta 官方文件。developers.facebook.com 的頁面讀得到，大部分**沒有標頁面日期**；有標的已註明。
- **〔三〕**：第三方來源。
- **未查證**：找不到可靠來源，不要當作事實。

**讀不到的官方頁面：** facebook.com/business/help 的文章要用 JavaScript 載入，只抓到標題，正文讀不到。例如商業驗證步驟（2058515294227817）、上傳文件（159334372093366）、被拒原因（2342133782492969）、網域驗證（286768115176155）。這幾篇的內容只能靠搜尋摘要和第三方引述，可信度已相應降低。

---

## 先講結論

### 必須完成三道關卡，順序固定

| # | 關卡 | 做甚麼 | 官方審核時間 | 來源 |
| --- | --- | --- | --- | --- |
| 1 | **商業驗證（Business Verification）** | 證明 Hobbyland 是真實的法人 | 第三方說最長約 14 個工作天 | 〔官〕https://developers.facebook.com/docs/development/release/business-verification |
| 2 | **存取驗證（Access Verification，即 Tech Provider 驗證）** | 說明你怎樣使用**其他商家**的資料來提供服務；要先完成第 1 關 | 約 5 天 | 〔官〕https://developers.facebook.com/docs/development/release/access-verification |
| 3 | **App 審核（App Review）** | 逐個權限申請 Advanced Access：寫用途說明、上傳錄影、提供測試方法 | 「應該會在一星期內收到決定」 | 〔官〕https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review/submission-guide （Updated 2026-06-30） |

官方原文：Advanced Access「requires App Review and Business Verification」（〔官〕https://developers.facebook.com/docs/instagram-platform/overview/ ）。Access Levels 頁寫明，由 2023-02-01 起申請 Advanced Access 都要先做商業驗證（〔官〕https://developers.facebook.com/docs/graph-api/overview/access-levels ）。

### 🔴 提交前必須先解決的四個阻礙（都要改程式，由總指揮處理）

1. **`instagram_business_manage_insights` 可能申請不到 Advanced Access。**
   - 官方〈Instagram App Review〉頁列出 Instagram Login 可申請的權限，只有五項：Human Agent、`instagram_business_basic`、`instagram_business_content_publishing`、`instagram_business_manage_comments`、`instagram_business_manage_messages`。權限參考頁也找不到 manage_insights（〔官〕https://developers.facebook.com/documentation/instagram-platform/app-review ，Updated 2026-06-30）。
   - 但 Insights 文件又說，用 Instagram Login 讀取成效數據需要這個權限（〔官〕https://developers.facebook.com/documentation/instagram-platform/insights ，Updated 2025-01-21）。**兩份官方文件互相矛盾。**
   - OpenReply 的 OAuth 已經在要求這個權限（`lib/meta/oauth.ts:81-82`），總覽頁和粉絲快照會用到。**如果它拿不到 Advanced Access，外部用戶授權時可能會出錯**（未查證會不會出錯）。
   - **處理方法：** 用戶登入 App Dashboard，看這個權限有沒有「Request advanced access」按鈕。
     - **有**：一併申請，說明和錄影見第 3 節。
     - **沒有**：在送審前，把它從 OAuth 的 scope 移除，並確認總覽頁在沒有這個權限時仍能正常顯示（`lib/meta/client.ts:686` 的註解說沒有這個權限時會拋出 PermissionError）。
2. **審核員無法登入。** OpenReply 只支援 magic link 登入，而且有 `ALLOWED_EMAILS` 白名單，審核員收不到你的信。官方要求「If needed」提供測試帳密，並寫清楚逐步說明（〔官〕app-review 頁、Submission Guide）；找不到登入方法或登入失敗，**整份送審都會被拒**（〔官〕https://developers.facebook.com/docs/app-review/submission-guide/common-mistakes ）。第 3.4 節有兩個方案，要總指揮選一個。
3. **資料刪除。** 現在的 `/data-deletion` 頁只寫「用登入的電郵聯絡客服」，但**沒有寫電郵地址**；也沒有實作 Data Deletion Callback。官方要求在 App 設定填寫刪除說明網址或 Callback（〔官〕https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/data-deletion-callback ，我沒有逐字讀原文）。見第 4 節。
4. **網站要顯示法定名稱。** 商業驗證時，網站名稱、地址和電話要與商業資料一致（〔三〕360dialog、Vonage、Wati；官方明文未查證）。目前網站是 OpenReply 的品牌，頁尾要加上「HL Reply by Hobbyland Limited」（以 BR 上的法定英文名稱為準）、BR 上的地址，以及公司網域的電郵。

---

## 1. 商業驗證（Business Verification）

### 1.1 所需文件（香港公司）

Meta 接受五類文件（〔三〕saveoffice.io 2026-07-28 引述 Help Center：https://saveoffice.io/blog/meta-business-verification-documents ，中高可信度）：

| 類別 | Hobbyland 對應的文件 | 用途 | 備註 |
| --- | --- | --- | --- |
| 1. 公司註冊證書／公司章程 | **公司註冊證書（CI）** | 證明法定名稱 | 推論：CI 屬於這一類 |
| 2. 商業登記或牌照 | **商業登記證（BR）** | 證明法定名稱、地址 | 推論：BR 屬於這一類，要用**有效期內**的 BR |
| 3. 政府發出的稅務文件 | 稅務局發出的文件 | 證明名稱 | 自行填報的文件不接受 |
| 4. 公司銀行月結單 | 公司戶口月結單 | 證明名稱、地址 | |
| 5. 水電煤賬單 | 公司名義的賬單 | **只能證明地址或電話，不能證明名稱** | |

- **有沒有香港專屬的文件清單：未查證。** Wati 的分國家清單（2026-06-16）沒有香港一欄，BR 和 CI 列在「China」一欄下（〔三〕https://support.wati.io/en/articles/11463208-meta-business-verification-required-documents-by-country ）。
- **NAR1（周年申報表）：未查證**，沒有任何來源提到。
- **名稱要逐字相符**：法定名稱要與 Business settings 裡填的「完全一樣」，連「Limited／Ltd」後綴也算（〔官〕被拒原因頁的搜尋摘要；〔三〕saveoffice）。**建議直接照抄 BR 上的英文名稱。**
- **選電話驗證**的話，文件上要同時有法定名稱和相符的電話號碼（〔官〕搜尋摘要）。
- **語言**：「不支援的語言」是被拒原因之一；翻譯本要由翻譯機構蓋章，自己翻譯的不算（〔三〕saveoffice 引述官方）。中英雙語的 BR 能否直接用：**未查證**，但 BR 本身有英文，風險低（推論）。
- **文件狀態**：要有效、未過期、未經修改、清晰；自製或沒有官方印章的不接受（〔官〕搜尋摘要；〔三〕Wati）。

### 1.2 操作步驟

**入口 A（建議，在開發者後台）**〔官〕https://developers.facebook.com/docs/development/release/business-verification

1. 登入 developers.facebook.com → My Apps → HL Reply。
2. 按 **Settings → Basic → Verification** → **Start Verification**。
3. 把 app 連到 Hobbyland 的 Business 帳號（Business Portfolio）。任何 app 管理員都可以連，但**只有 Business Admin 可以完成驗證**。
4. 如果那個 Business 已經驗證過，就會直接完成。

**入口 B（在 Business Suite）**〔三〕360dialog https://docs.360dialog.com/docs/resources/meta-business-verification/classic-business-verification

1. business.facebook.com → **Settings → Security Center** → **Start Verification**。
2. 揀選對應的商業資產；揀不到就選「None of these match」。

**填寫商業資料**（〔官〕搜尋摘要；〔三〕360dialog）

- 欄位：法定名稱、地址、電話、網站；部分流程也要填電郵。
- 360dialog 說**送出後不能再修改**，所以送出前要逐字核對。

**上傳文件**：按 1.1 節的清單。建議同時準備 BR 和 CI 的彩色掃描本。

**確認聯繫方式**（揀其中**一種**即可）（〔官〕https://www.meta.com/help/subscriptions/1589052262926083/ ，中高可信度）

- 電郵驗證碼：**要用公司網域的電郵**，見下面的被拒原因。
- SMS 或電話：號碼要與文件上的一致。
- **網域驗證（建議）**：在 DNS 加一條 TXT 記錄，或在網站放 meta tag；選這個就可以跳過輸入驗證碼（〔三〕360dialog）。具體做法見〔官〕https://www.facebook.com/business/help/286768115176155 ，正文讀不到，細節未查證。
- WhatsApp 能否用作確認方式：**未查證**。

### 1.3 常見被拒原因與對策

| 原因 | 對策 | 來源 |
| --- | --- | --- |
| 法定名稱不一致（包括 Ltd／Limited） | 所有地方照抄 BR 的英文名稱 | 〔官〕搜尋摘要；〔三〕saveoffice |
| 地址或電話與文件不符 | 商業資料的地址照 BR 填寫；電話用文件上有的號碼 | 同上 |
| 網站打不開、沒有 HTTPS、網站名稱與法定名稱不符 | 網站頁尾顯示法定名稱、地址、電話和公司網域的電郵；品牌名與法定名稱不同時，要寫明兩者關係，例如「HL Reply by Hobbyland Limited」 | 〔三〕saveoffice、360dialog、Vonage https://api.support.vonage.com/hc/en-us/articles/4404796719764 |
| **用免費電郵（Gmail 等）** | 改用 `@hobbyland 網域` 的電郵。**現在的聯絡電郵是 Gmail，要換** | 〔三〕360dialog；官方有沒有明文禁止：未查證 |
| 文件過期、模糊、自製 | 用最新 BR 的彩色掃描本 | 〔官〕搜尋摘要 |
| 補交資料逾期 | 被要求補交時，一星期內要補，否則要重頭開始 | 〔官〕搜尋摘要 |

- **上訴**：被拒後「可能可以上訴」，在 Security Center 處理（〔官〕搜尋摘要）。
- **重試上限**：官方未查證；第三方說沒有硬性上限，建議每次重交相隔 24–48 小時（〔三〕低可信度）。

### 1.4 需要的時間

- 最長約 14 個工作天（〔三〕360dialog、saveoffice）；也有第三方說 3–7 個工作天（低可信度）。**官方時限未查證。**

---

## 2. 技術供應商（Tech Provider）／存取驗證

### 2.1 HL Reply 必須做

- **定義**：Tech Provider 是「有正當需要存取**其他企業擁有**的商業資料來提供服務」的企業（〔官〕https://developers.facebook.com/docs/development/release/tech-providers ）。
- **幾時必須做**：app 由企業建立、給其他企業使用，而且用到清單上的權限，就要先通過 Tech Provider 驗證，其他企業才能用。這個要求與 App Review 和權限等級是分開計算的（〔官〕access-verification 頁、tech-providers 頁）。
- **清單包括 `instagram_business_basic`**（HL Reply 有用到），另外還有 `instagram_basic`、`instagram_business_content_publish`、`instagram_manage_insights` 等（〔官〕同上）。
  - manage_comments、manage_messages、manage_insights **不在清單上**，但因為用了 basic，所以一樣要做。
  - 是漏列還是刻意排除：未查證。
- **Instagram App Review 頁**：「我是 Tech Provider，我的 app 服務多間企業」這種情況，**要 Advanced Access 和 App Review**；只服務自己擁有的商家就不用（〔官〕https://developers.facebook.com/documentation/instagram-platform/app-review ）。

### 2.2 步驟

1. **先完成商業驗證**，而且 Business 帳號不能有任何限制（〔官〕access-verification 頁）。
2. App Dashboard → **Basics → Verifications → Access verification**。另外，當 app 管理員為清單上的權限申請 Advanced Access 時，Business 管理員會收到一封附表單連結的電郵（〔官〕同上）。
3. 填問卷：官方只寫要「**分類並描述**企業怎樣使用其他企業的資料來提供服務」。**逐條題目未查證**，官方沒有公開。預先準備的答案（草稿）：
   - **服務對象**：香港的中小企和品牌，他們自行連接自己的 Instagram 專業帳號。
   - **使用的資料**：客人帳號的基本資料（username、ID）、客人自己貼文下的留言、客人帳號收到的私訊，以及（如有申請）帳號成效數據。
   - **用途**：只用來按客人自己設定的關鍵詞，自動回覆留言者或私訊者；在客人的後台顯示紀錄和統計。
   - **不做的事**：不出售、不轉售、不做廣告投放、不跨客人合併資料、不爬取資料。
   - **資料保護**：token 用 AES-256-GCM 加密儲存；每個客人的資料按 workspace 分隔；客人可隨時斷開連接並要求刪除。
4. 等審核：約 5 天（〔官〕）。

### 2.3 不做的後果

- 需要清單權限的 API 呼叫會失敗，錯誤碼是 `100`，訊息以「Unsupported get request. Object with ID … does not exist」開頭；只有在 app 內有角色的用戶例外（〔官〕access-verification 頁）。
- 商業驗證失效、app 與 Business 斷開、帳戶被限制，都會失去 Tech Provider 身份；問題解決後會自動恢復（〔官〕tech-providers 頁）。

### 2.4 拿到 Advanced Access 之後的年度義務

| 項目 | 內容 | 期限 | 來源 |
| --- | --- | --- | --- |
| **Data Use Checkup（DUC）** | 每年一次，由 app 管理員完成：覆核權限、聲明用法合規、回答資料處理問題（2024-01 起加入）、提供測試說明。只有 Standard Access 的 app 不用做 | 官方沒有寫日數；2020 年的報道寫 60 天（現況未查證） | 〔官〕https://developers.facebook.com/docs/development/maintaining-data-access/data-use-checkup ；〔三〕Social Media Today |
| **Data Protection Assessment（DPA）** | Meta 通知才要做（觸發條件官方沒有列明，HL Reply 會不會收到：**未查證**）。題目包括：資料用途限制、服務供應商（Railway 等）、**各 Tech Provider 客戶資料有沒有分隔**、刪除（一般不超過 120 天）、安全（靜態加密、TLS 1.2+、12 個月內做過漏洞測試、token 和 app secret 的保護、MFA、每年權限覆核、公開的漏洞報告渠道、審計日誌） | 收到通知後 60 天 | 〔官〕https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/data-protection-assessment/content/ |

逾期不做，可能失去平台存取權（〔官〕DPA 頁；〔三〕https://singhamandeep.com/meta-data-use-checkup-app-disabled/ ）。**建議現在就把 DPA 的安全題目當作待辦**：漏洞報告頁、MFA、審計日誌。現有的 `SECURITY.md` 可以作為漏洞報告渠道的起點。

---

## 3. App 審核

### 3.1 要申請的權限

| 權限 | 相依權限 | 要不要申請 | 原因 |
| --- | --- | --- | --- |
| `instagram_business_basic` | 無 | ✅ | 登入和識別帳號 |
| `instagram_business_manage_comments` | basic | ✅ | 公開回覆留言；私訊回覆文件也要求這個權限 |
| `instagram_business_manage_messages` | basic | ✅ | 發送私訊、收私訊關鍵詞、按鈕 postback |
| `instagram_business_manage_insights` | basic | ⚠️ 見「先講結論」第 1 點 | Dashboard 裡有申請按鈕才申請；沒有就從 OAuth scope 移除 |
| Human Agent | — | ❌ 不申請 | 只在真人要在 24 小時後手動回覆時才需要；OpenReply 是自動回覆（推論） |

- **相依權限要放在同一次送審**（〔官〕app-review 頁）。
- **不要申請用不到的權限**，這是常見的被拒原因（〔官〕Permissions Reference https://developers.facebook.com/documentation/development/permissions ，Updated 2026-09-14；Common Mistakes）。

### 3.2 各權限的用途說明

每個權限在送審表格都有自己的說明欄。**官方要求不要複製貼上同一段文字**（〔官〕Submission Guide）。下面每項先寫中文說明給用戶理解，英文可以直接貼上提交。

#### `instagram_business_basic`

**中文：** 客人按「Connect Instagram」，經 Instagram 商家登入授權後，我們讀取他 IG 專業帳號的 username 和 ID，用來把帳號綁定到他在 HL Reply 的工作區，並在後台顯示每個自動回覆活動屬於哪個帳號。

**English (paste):**
> HL Reply lets a business connect its own Instagram professional account through Instagram Business Login. We use instagram_business_basic to read the connected account's user ID and username right after the business authorizes the app. We store the ID to link the account to the business's HL Reply workspace, match incoming webhook events to that workspace, and show the username in the dashboard so the business can see which account each keyword campaign belongs to. We do not use this data for any other purpose and do not share it.

#### `instagram_business_manage_comments`

**中文：** 客人在自己的貼文或 Reel 上設定關鍵詞（例如 LINK）。有人在**客人自己的貼文**留言命中關鍵詞時，我們經 comments webhook 收到這則留言；如果客人開啟了公開回覆，就在該留言下公開回覆一句客人預設的文字。我們也用這個權限發送私訊回覆（private reply）。我們只處理連接帳號自己的貼文底下的留言。

**English (paste):**
> A business using HL Reply sets up a keyword campaign on one of its own posts or reels (for example, the keyword "LINK"). We subscribe to the comments webhook for the connected account and use instagram_business_manage_comments to read comments on that account's own media, check them against the business's keywords, and, when the business has turned the option on, post one public reply under the matching comment with text the business wrote. The same permission is used to send the one-time private reply to that comment, as described in the Private Replies documentation. We only act on comments on the connected account's own media, reply at most once per comment, and never read or reply to comments on other accounts' content.

#### `instagram_business_manage_messages`

**中文：** 有人在客人的貼文留言命中關鍵詞後，我們向這位留言者發送**一次**私訊回覆，內容是客人預設的文字，通常附上對方要的連結。如果客人開啟「私訊觸發」，有人私訊或回覆限動命中關鍵詞時，我們在 24 小時內回覆一次。私訊裡有按鈕的話，對方按下後，我們經 messaging_postbacks 收到事件，再送出第二則訊息。我們遵守每則留言只可私訊回覆一次、24 小時視窗和 Meta 的頻率限制。

**English (paste):**
> After someone comments a business's configured keyword on the business's own post or reel, HL Reply uses instagram_business_manage_messages to send that person one private reply containing the content the business prepared, usually the link or information the person asked for by commenting. This is the standard comment-to-DM flow: one private reply per matching comment, sent within 7 days of the comment. If the business enables it, we also respond once, within the 24-hour messaging window, when a person sends the business a DM or story reply containing the keyword. When the reply contains a button, we receive the messaging_postbacks webhook when the person taps it and send the follow-up message they requested. Every message is triggered by the person's own action, and we never send unsolicited or promotional broadcast messages. The business can see every message in the DM Logs page and can disconnect at any time.

#### `instagram_business_manage_insights`（只在 Dashboard 可以申請時才用）

**中文：** 讀取客人自己帳號的粉絲數和貼文成效（觀看、觸及），只在客人自己的後台以圖表顯示，讓他知道哪些貼文帶來最多留言和私訊。

**English (paste):**
> HL Reply shows each business an overview of its own Instagram professional account, including follower count over time and views and reach for the posts it runs keyword campaigns on. We use instagram_business_manage_insights to read these metrics for the connected account only and display them in that business's dashboard, so it can see which posts drive comments and replies. Insights data is never shared with other businesses or third parties.

### 3.3 錄影腳本（一鏡到底，約 2–3 分鐘）

**官方規格**（〔官〕Submission Guide，Updated 2026-06-30）：

- **解析度**：1080p 以上；錄影時把瀏覽器寬度調到 **1440 以下**。
- **語言**：介面用英文（OpenReply 本身就是英文）。
- **審核員不聽聲音**：所以**不要靠旁白**，用**畫面字幕或提示框**標出每一步用到哪個權限。這一點和舊版 `META_APP_REVIEW.md` 說「narrate」不同，以官方為準。
- **錄製方式**：只錄瀏覽器視窗或全螢幕；用滑鼠操作；**放大游標**。
- **內容**：要看到用戶授予每一項權限，以及 app 怎樣使用每一項權限。缺錄影的權限一律不會核准。
- **各權限的特別要求**（〔官〕Permissions Reference）：
  - comments：同一個動作要**同時在 app 和 IG 原生 app** 看到結果。
  - messages：要錄到**訊息從 app 送出**，並在 IG 收件匣看到收到；只有 IG 收件匣的截圖不算。另外要示範用 App Dashboard → Instagram → **API Integration Helper** 產生一段發送訊息的 cURL request。
- **一支還是多支**：官方沒有規定一定要分開。同一支合併影片能否在每個權限重複上傳：**未查證**。**建議**：錄一支完整的主影片，再剪出每個權限對應的片段分開上傳，最穩妥。

**事前準備**

- 帳號 A：用來連接的 IG 專業帳號（Hobbyland 的帳號）。
- 帳號 B：另一個 IG 帳號，用來留言和私訊。**不能用假帳號**，否則整份送審會被拒（〔官〕Common Mistakes）。
- 帳號 A 有一篇近期的貼文。
- 在 OpenReply 先**斷開** IG，這樣才錄得到授權畫面。
- 準備錄影工具（例如 macOS 內建的螢幕錄影），並開啟放大游標。
- 手機畫面用 QuickTime 鏡像到電腦，或用第二個瀏覽器視窗開 instagram.com 登入帳號 B。

**腳本**（每一格的「字幕」就是要疊在畫面上的英文）

| 時間 | 畫面 | 操作 | 字幕（英文，疊在畫面上） |
| --- | --- | --- | --- |
| 0:00–0:10 | HL Reply 首頁 | 停兩秒 | `HL Reply — comment-to-DM for Instagram professional accounts` |
| 0:10–0:25 | `/login` | 輸入審核用的帳號登入（見 3.4） | `Step 1: Sign in to HL Reply` |
| 0:25–0:55 | Settings | 按 **Connect Instagram** → 跳到 Instagram 授權畫面 → **停 3 秒讓權限清單清楚可見** → 按同意 | `Step 2: Business connects its own Instagram account. Permissions requested: instagram_business_basic, instagram_business_manage_comments, instagram_business_manage_messages` |
| 0:55–1:05 | Settings | 顯示已連接的 username | `instagram_business_basic: connected account username and ID shown` |
| 1:05–1:35 | Campaigns → New campaign | 揀帳號 A → 「a specific post or reel」揀那篇貼文 → 關鍵詞 `LINK` → 私訊內容加一個連結按鈕 → 開啟公開回覆 → **Go Live** | `Step 3: Business creates a keyword campaign on its own post` |
| 1:35–1:55 | 切到帳號 B（手機鏡像或 instagram.com） | 在帳號 A 那篇貼文留言 `LINK` | `Step 4: A follower comments the keyword "LINK"` |
| 1:55–2:10 | 帳號 B 的貼文留言區 | 顯示帳號 A 的公開回覆 | `instagram_business_manage_comments: public reply posted under the comment (visible in the Instagram app)` |
| 2:10–2:30 | 帳號 B 的 IG 收件匣（可能在「訊息要求」） | 打開 HL Reply 送來的私訊 → 按連結按鈕 | `instagram_business_manage_messages: private reply received in the Instagram inbox` |
| 2:30–2:45 | 回到 HL Reply → DM Logs | 顯示該筆狀態為 `SENT` | `Message sent by HL Reply and logged once (SENT)` |
| 2:45–3:00 | App Dashboard → Instagram → API Integration Helper | 產生一段發送訊息的 cURL request | `API Integration Helper: send message cURL request` |
| （選做）+0:20 | 帳號 B 私訊帳號 A「LINK」 | 顯示自動回覆 | `DM keyword trigger: reply within the 24-hour window` |
| （如有申請 insights）+0:15 | HL Reply 總覽頁 | 顯示粉絲數和貼文成效 | `instagram_business_manage_insights: account insights shown to the business` |

錄完後檢查三件事：
- 授權畫面的權限清單是否清晰可讀。
- 每個權限都有對應的字幕。
- 畫面上沒有露出任何密碼、token 或 API 密鑰。

### 3.4 測試帳號怎樣提供給審核員

**官方規定**（〔官〕app-review 頁、Submission Guide）：

- 在「App Verification」逐個平台寫清楚步驟，說明審核員怎樣登入、怎樣測試每個權限。
- 「If needed」要提供測試帳密。
- Instagram Login 目前只支援網頁和手機網頁。
- Meta 會用自己的測試帳號，**不要附你個人的 Meta 帳號帳密**。
- **使用假帳號會令整份送審被拒。**

**OpenReply 的問題**：magic link 登入加上 `ALLOWED_EMAILS` 白名單，審核員登入不了。有兩個方案，**要總指揮決定**：

| 方案 | 做法 | 優點 | 缺點 |
| --- | --- | --- | --- |
| **A（建議）審核員專用的密碼登入** | 加一個只在環境變數有設定時才啟用的登入方式，例如 `REVIEWER_EMAIL` 和 `REVIEWER_PASSWORD`（Auth.js Credentials provider），只能登入一個指定的 workspace；審核通過後移除這兩個變數 | 審核員可以直接登入，不需要信箱；第三方實例（Chatwoot）也是這樣做 | 要改程式；要確保只影響這一個帳號 | 
| B 審核專用信箱 | 開一個新信箱（例如 `review@<公司網域>`）放進 `ALLOWED_EMAILS`，把信箱的登入方法寫在審核說明裡 | 不用改程式 | 要把信箱密碼交給 Meta；信箱可能要求兩步驗證或偵測到異常登入，審核員可能因此登入失敗 |

方案 A 的來源：〔三〕Chatwoot https://developers.chatwoot.com/self-hosted/instagram-app-review ；singhamandeep https://singhamandeep.com/meta-app-review-screencast-why-your-demo-video-gets-rejected-2026/ 。兩者都建議用權限受限、非超級管理員的帳號。

**審核說明欄範本（英文，方案 A）：**

```
1. Open https://openreply.up.railway.app/login and use "Reviewer sign-in":
   email: <REVIEWER_EMAIL>  password: <REVIEWER_PASSWORD>
2. Go to Settings and click "Connect Instagram". Authorize with any Instagram
   professional account you control.
3. Go to Campaigns → New campaign. Pick a recent post, enter the keyword LINK,
   write a short DM message, and click "Go Live".
4. From a different Instagram account, comment LINK on that post.
5. The commenter receives one private reply in the Instagram inbox (it may be in
   Message Requests), and a public reply appears under the comment if enabled.
6. In HL Reply, open "DM Logs" to see the message recorded as SENT.
Optional: DM the keyword LINK to the connected account to see the DM trigger.
```

（`<…>` 由用戶在提交時填入，**不要寫進這份文件或 git**。）

### 3.5 提交前還要做的事

- **每個要申請的權限，都要至少有 1 次成功的 API 呼叫**。系統最多要 2 天才會記錄到（〔官〕Submission Guide）。完成端到端測試時已經呼叫過 basic、comments、messages；insights 要打開總覽頁才會呼叫。**送審前到 App Dashboard 確認每個權限都有呼叫紀錄。**
- **登入按鈕要清楚可見**，並符合 Meta 品牌準則（〔官〕app-review 頁）。「Connect Instagram」按鈕要確認用詞和樣式合規（品牌準則的細節未查證）。
- **告知對方是自動回覆**：加州、德國等地依法必須告知，官方也建議一般情況都告知（〔官〕Messaging Policy https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy ，Updated 2026-04-06）。**建議客人的私訊範本預設加一句**，例如「（自動回覆）」。

### 3.6 常見退件原因與對策

| 退件原因 | 對策 | 來源 |
| --- | --- | --- |
| app 無法存取，或審核員登入失敗（整份被拒） | 3.4 的方案 A；送審前用無痕視窗按審核說明完整走一次 | 〔官〕Common Mistakes |
| 權限沒有對應的錄影 | 每個權限都上傳錄影片段，並有字幕標明 | 〔官〕Submission Guide |
| 申請了用不到的權限 | 不申請 Human Agent；insights 用不到就不申請，並從 OAuth scope 移除 | 〔官〕Permissions Reference |
| 送審時 app 仍在開發模式 | HL Reply 已經發佈（Live），要保持 | 〔官〕Common Mistakes |
| 使用假帳號 | 帳號 A 和 B 都用真人帳號 | 〔官〕Common Mistakes |
| 未完成商業驗證 | 先完成第 1 節 | 〔官〕Permissions Reference |
| 私隱政策網址無效 | 見第 4 節 | 〔官〕Submission Guide |
| 缺少資料刪除說明或 Callback，或網址失效 | 見第 4 節；說明頁要公開、不需要登入 | 〔三〕singhamandeep https://singhamandeep.com/facebook-data-deletion-callback-url/ |
| 錄影看不出權限用在哪裡 | 字幕逐步寫出權限名稱；審核員不會自己推測 | 〔三〕singhamandeep |
| 用途說明和錄影不一致 | 用途說明只寫錄影裡看得到的功能 | 推論 |

### 3.7 私訊相關的規則（寫說明和錄影時要遵守）

- **Private reply**：每則留言只可以私訊回覆**一次**，要在留言後 **7 天內**送出；直播留言只可以在直播進行中回覆。對方回覆之後，才可以在 24 小時內再發訊息。對方沒有追蹤你的話，訊息會進「訊息要求」（〔官〕https://developers.facebook.com/documentation/instagram-platform/private-replies ，Updated 2026-06-30，我讀的是 AI 中文翻譯版）。
- **24 小時視窗**：對方先私訊你，你才可以回覆，而且要在 24 小時內（〔官〕IG Messaging API https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api ，Updated 2026-05-06）。限時動態的提及和回覆可以開啟對話（〔官〕同上）。
- **按鈕的後續訊息**：對方按按鈕觸發 postback，算不算「回覆」、會不會開啟新的 24 小時視窗，**未查證**。OpenReply 的「已讀 5 分鐘後自動補發」機制（`lib/queue/process-webhook.ts`）是在對方**沒有**按按鈕時發第二則訊息，這可能超出「對方回覆後才可以再發」的規則。**建議送審期間關閉開場私訊（opening DM）功能，錄影和說明也不提**，等官方規則確認後再開。
- **私訊回覆需要哪個權限，官方寫法矛盾**：Private Replies 頁寫 Instagram Login 需要 basic 加 manage_comments，但實際發送走的是 `/messages` 端點。**兩個權限都申請**，並在錄影裡示範（推論）。

---

## 4. 提交前清單

| # | 項目 | 狀態 | 誰做 | 備註 |
| --- | --- | --- | --- | --- |
| 1 | 商業資料（名稱、地址、電話）與 BR 逐字一致 | ☐ | 用戶 | 1.1、1.3 |
| 2 | BR、CI 的彩色掃描本 | ☐ | 用戶 | 有效期內 |
| 3 | **私隱政策改成 Hobbyland 自己的版本** | ☐ **第 3 項待辦** | （另行安排） | 目前 `/privacy` 是 OpenReply 原版；App 設定的 Privacy Policy URL 要指向改好的版本 |
| 4 | 服務條款 `/terms` 改成 Hobbyland 的主體 | ☐ | 總指揮 | 與第 3 項一起處理 |
| 5 | **資料刪除**：`/data-deletion` 寫上實際的聯絡電郵（公司網域）、處理時限（建議不超過 30 天，DPA 上限是 120 天）；App 設定填 **Data Deletion Instructions URL**，即 `https://openreply.up.railway.app/data-deletion`；是否另外實作 Callback（要回傳含 `url` 和 `confirmation_code` 的 JSON）由總指揮決定 | ☐ | 總指揮 | 〔官〕data-deletion-callback 頁；〔三〕singhamandeep |
| 6 | 網站頁尾顯示法定名稱、地址、電話和公司網域的電郵 | ☐ | 總指揮 | 1.3 |
| 7 | **網域驗證**：Business Suite → Brand Safety → Domains 加入網域，用 DNS TXT 或 meta tag 驗證 | ☐ | 用戶（DNS）＋總指揮（meta tag） | 目前用 `*.up.railway.app`，**無法做 DNS 驗證**；建議先綁定 Hobbyland 自己的網域（未查證 Railway 子網域能否用 meta tag 驗證） |
| 8 | 公司網域的電郵（驗證和聯絡用） | ☐ | 用戶 | 取代 Gmail |
| 9 | App 圖示（1024×1024）、App 名稱、類別、聯絡電郵 | ☐ | 用戶 | App Dashboard → Settings → Basic（尺寸是一般要求，**未查證**） |
| 10 | insights 權限：申請或從 OAuth 移除 | ☐ | 用戶查 Dashboard，總指揮改程式 | 先講結論第 1 點 |
| 11 | 審核員登入方式（3.4 的方案 A 或 B） | ☐ | 總指揮 | |
| 12 | 送審期間關閉開場私訊功能 | ☐ | 用戶（在活動設定關閉） | 3.7 |
| 13 | 每個權限在 Dashboard 都有成功呼叫紀錄 | ☐ | 用戶 | 3.5 |
| 14 | 錄影（主影片加各權限片段） | ☐ | 用戶錄，3 號可以覆核 | 3.3 |
| 15 | 用途說明貼上（英文） | ☐ | 用戶 | 3.2 |
| 16 | 私訊範本加上「自動回覆」字樣 | ☐ | 用戶 | 3.5 |
| 17 | DPA 預備：漏洞報告頁、MFA、審計日誌 | ☐ | 總指揮 | 2.4，不阻礙送審 |

---

## 5. 時間表（預估）

**所有日數都是預估**：官方只公佈 Access Verification 約 5 天、App Review 約一星期；商業驗證的時長只有第三方說法。被拒一次就要重新排隊。

| 週次 | 工作 | 誰做 | 可以並行 |
| --- | --- | --- | --- |
| 第 0 週（準備，約 3–5 天） | 清單第 4–11 項：法定名稱頁尾、資料刪除頁、審核員登入、insights 處理、網域和公司電郵 | 總指揮（程式）、用戶（網域、電郵、DNS） | 第 3 項私隱政策同時進行 |
| 第 1 週 | **送出商業驗證**：填資料、上傳 BR 和 CI、確認聯繫方式 | 用戶（要 Business Admin 身份） | 同時錄影、準備說明 |
| 第 1–3 週 | 等商業驗證：約 3–14 個工作天（第三方） | — | 錄影、內部測試審核流程 |
| 驗證通過後 | **Access Verification** 問卷（答案草稿見 2.2） | 用戶提交，3 號可以潤色答案 | 可以與 App Review 同時送出（**未查證**，官方只說兩者分開計算） |
| ＋約 5 天 | 等 Access Verification | — | |
| 同期 | **App Review 送審**：3 或 4 個權限的說明、錄影、審核說明 | 用戶提交 | |
| ＋約 1 週 | 等 App Review | — | |
| 如被拒 | 看退件理由 → 修改 → 重送，每次再加約 1 週 | 總指揮修改，用戶重送 | |

**合計：** 順利的話約 **3–4 週**；一般有一次退件的話約 **5–6 週**。

**分工摘要：**
- **用戶**：所有要登入 Meta、上傳文件、提交表格、錄影、改 DNS 的步驟。這些要用你本人的帳號，總指揮和 3 號都不會代為登入或提交。
- **總指揮**：程式修改，包括審核員登入、insights scope、資料刪除頁、頁尾、DPA 的安全項目，以及私隱政策（第 3 項待辦）的安排。
- **3 號**：文件、用途說明潤色、錄影覆核、退件理由分析。
