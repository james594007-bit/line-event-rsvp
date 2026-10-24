# 擁有者核准與版主存取權限 — 技術評估回覆

- 回覆對象:docs/OWNER-ACCESS-PRD.md 第13節
- 狀態:**評估完成,待產品(James/GPT)確認第15題標示的開放決策後才開始實作**
- 撰寫者:Claude Code

本文件逐項回覆PRD第13節的15個問題,並在最後給出分階段實作計畫與工期估算。凡PRD明確要求「產品決定」的項目,本文件只提供方案與風險,不自行拍板。

---

## 1. 登入方式:現有LIFF channel能否直接用,建議的OAuth/OIDC流程

**不建議直接沿用現有LIFF的身分取得方式。**

現況:參加者報名頁(`liff.html`)用的是`liff.getProfile()`,前端直接把`lineUserId`/`displayName`送給後端,**後端完全信任前端送來的值**。這對參加者報名這個低風險場景是可接受的(頂多有人謊報身分幫別人報名,影響範圍是單一活動的名單),但PRD明確要求「不信任前端自行提交的LINE user ID」(FR-01),這個模式不能用在版主/擁有者登入。

**建議架構**:沿用同一個LINE Login channel(不用再跟James要新的channel設定),但新增一條**標準LINE Login OAuth2/OIDC web流程**,跟現有LIFF的`/liff`路徑分開,服務後台登入:

1. 後台新增 `GET /auth/line/start`:產生隨機`state`與`nonce`,存進一個短期的signed cookie,重導向到`https://access.line.me/oauth2/v2.1/authorize`,帶上`client_id`(channel id)、`redirect_uri`、`scope=openid profile`、`state`、`nonce`。
2. 新增 `GET /auth/line/callback`:檢查回傳的`state`與cookie裡的值一致(防CSRF),用`code`跟LINE的token endpoint換`id_token`,**後端驗證id_token的簽章(JWKS)、`iss`、`aud`(channel id)、`exp`、`nonce`**,全部通過才算登入成功。
3. 成功後核發我們自己的session(見第3題),不是直接信任id_token裡的欄位做後續判斷。

這比繼續用LIFF的`getProfile()`更合適,因為:LIFF的profile API本質是「前端問LINE SDK要資料,前端轉交給後端」,中間沒有可驗證的簽章;標準OAuth流程則是後端直接跟LINE的token/JWKS endpoint對話,資料來源可驗證。

需要在LINE Developers Console新增一個**Callback URL**(在現有LINE Login channel的設定裡加一條,例如`https://line-event-rsvp.../auth/line/callback`),這是唯一需要James再跑一次LINE Console操作的地方。

---

## 2. 第一位擁有者如何安全建立,不把LINE user ID寫進Git

**方案**:用Wrangler secret存擁有者的LINE user ID,不寫進任何原始碼或文件。

1. James完成一次上述OAuth登入流程(用他自己的LINE帳號),系統後端log(僅他本機終端機輸出,不寫入任何檔案)顯示驗證後的`line_user_id`。
2. 用 `wrangler secret put OWNER_LINE_USER_ID` 把這個值存進Worker secret(跟現在`ADMIN_PASSCODE`、`LINE_CHANNEL_SECRET`同一套機制,已經在用,不是新技術)。
3. 之後任何人登入時,後端拿驗證過的`line_user_id`跟這個secret比對;相符就視為owner、寫入`moderators`表並標記`role='owner'`(只在該值為空或與自己相符時才授予,避免之後被覆寫搶占)。

這個流程不需要新建部署機制、不需要手動操作資料庫,跟現有的secret管理模式一致。

---

## 3. Session方案:如何讓停權「立即」生效

**不建議用自簽JWT/無狀態token**——這類方案要做到「立即失效」通常得另外維護一份denylist,等於還是要查資料庫,不如一開始就設計成每次都查。

**建議**:
- Session cookie 只放一個**不透明的session id**(隨機字串),屬性設 `Secure; HttpOnly; SameSite=Lax`,有效期設短(例如7天),存進D1的`sessions`表(`id`, `moderator_id`, `created_at`, `expires_at`)。
- **每一個受保護API請求**,都用session id查`sessions`表拿到`moderator_id`,再即時查`moderators`表目前的`status`——不快取、不放進cookie本身。這樣停權的效果在「下一次請求」就生效,不用等cookie過期(滿足AC-09)。
- 在`moderators`表加一個`session_version`欄位,擁有者執行停權時連帶把這個版本號+1,並刪除該版主在`sessions`表裡的所有既有session列——這樣「停權當下正開著分頁的人」下一次操作也會立刻被擋,不只是「下次重新登入才生效」。
- 登出 = 刪除該session在`sessions`表的那一列 + 清cookie。

資料庫多一張表、多幾次查詢,但D1延遲很低,量體(幾位版主)完全不是問題,換來的是邏輯簡單、容易驗證正確性。

---

## 4. Schema設計

```sql
-- 版主/擁有者帳號
CREATE TABLE moderators (
  id TEXT PRIMARY KEY,                 -- mod_xxxxxxxxxx
  line_user_id TEXT NOT NULL UNIQUE,   -- 只存這個,不存顯示名稱當永久欄位
  role TEXT NOT NULL DEFAULT 'moderator' CHECK(role IN ('owner','moderator')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','suspended')),
  session_version INTEGER NOT NULL DEFAULT 0,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by TEXT REFERENCES moderators(id),
  suspend_reason TEXT,                 -- 只有擁有者看得到,API層過濾
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- session
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- 隨機token,存進cookie
  moderator_id TEXT NOT NULL REFERENCES moderators(id),
  session_version INTEGER NOT NULL,    -- 核發當下的版本號,跟moderators.session_version比對
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_moderator ON sessions(moderator_id);

-- 稽核紀錄
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,            -- apply|approve|reject|suspend|restore
  target_moderator_id TEXT NOT NULL,
  actor_moderator_id TEXT NOT NULL,
  result TEXT NOT NULL,                -- success|denied
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_target ON audit_log(target_moderator_id);

-- events表加一欄,取代現有「誰都能管理誰的活動」
ALTER TABLE events ADD COLUMN moderator_id TEXT REFERENCES moderators(id);
CREATE INDEX idx_events_moderator ON events(moderator_id);
```

**唯一性**:`moderators.line_user_id UNIQUE` 天然防止重複申請產生多筆帳號(AC-03)——重送申請時用`INSERT ... ON CONFLICT(line_user_id) DO NOTHING`或先查再擋,回應都視為「已有一筆有效申請」。

**狀態轉換**都是後端白名單控制(`pending→approved`、`pending→rejected`、`approved→suspended`、`suspended→approved`),不接受前端指定任意狀態。

---

## 5. 舊共用密碼API與`/admin`如何移轉

**不做「新舊並存」的漸進式遷移**,理由跟PRD的FR-08精神一致:並存期間就是一條繞過路徑。

建議順序:
1. 在**同一個repo、同一個Worker**裡把新流程完整做完,用一個新路徑測試(例如`/mod`而非沿用`/admin`,視覺上就跟舊的分開),可以用`wrangler versions`或獨立的preview部署來測,不影響正式站。
2. 確認新流程通過驗收測試後,**同一次deploy**裡:
   - 移除`requireAdmin`這個middleware跟所有讀`ADMIN_PASSCODE`的程式碼
   - 用 `wrangler secret delete ADMIN_PASSCODE` 撤銷這組密碼
   - 舊的`/admin.html`、`/admin`路徑要嘛整個刪除,要嘛改成導去新的`/mod`登入頁
3. 這樣不會有「新系統上線後,舊密碼還能用一段時間」的空窗期。

---

## 6. 現有測試活動資料怎麼處理

**建議**:正式切換前,先把現有3筆測試活動(含報名資料)**匯出成JSON備份**(存在我本機,不進git,因為裡面有真實LINE使用者的顯示名稱/頭像屬於個資),接著**整批刪除**正式資料庫裡的資料,讓新schema乾淨上線,不用幫這些測試資料瞎猜該歸屬哪個版主。

這一步是破壞性操作,**實際執行前我會先跟James確認一次**,不會自己直接刪。

---

## 7. 被停權版主的既有活動頁要唯讀/停止報名/下架

三個選項的風險:

| 方案 | 優點 | 風險 |
| --- | --- | --- |
| 維持公開+可報名 | 參加者體驗不受影響 | 版主可能是因為濫用被停權,停權後還能繼續收報名,等於懲罰沒生效 |
| **停止新報名,但維持可查看(建議)** | 已報名者的資訊不消失,新增風險被擋住 | 需要额外邏輯:停權時批次把該版主名下活動status改成closed |
| 完全下架(404) | 風險最小 | 已經報名的參加者連自己報了什麼都查不到,對無辜參加者不公平 |

**我建議中間方案**:擁有者執行停權時,系統自動把該版主名下所有`status='open'`的活動改成`status='closed'`(現有欄位已經有這個狀態,邏輯不用新建)。頁面保持可查看(參加者還看得到自己有沒有報名成功),但擋掉新報名/取消。這個預設值我會先這樣實作,但**最終要不要這樣做,請產品確認**。

---

## 8. 遭拒者可否重新申請

**建議**:P0階段**允許隨時重新申請**,不設冷卻期、不限次數。

理由:這個產品現階段只有個位數申請量,擁有者是人工審核,重新申請的成本極低(就是再看一次)。過早設計「冷卻期/次數上限」這種機制是對一個還沒出現過的濫用場景做過度設計,不符合「不造輪子」的原則。等真的出現有人惡意洗申請,再加限流(第11題已經涵蓋技術面的限流手段)。

---

## 9. 擁有者是否需要查看/代操作版主資料

**建議P0完全不開放**,擁有者對版主的活動資料預設零存取,只能看到申請清單跟帳號狀態(pending/approved/rejected/suspended + 申請時間),不能看任何版主的活動內容、名單、統計。

PRD自己也寫「預設不提供,只在有時效及稽核的支援模式啟用」——我建議連「支援模式」都不在這一期做,因為這會需要額外設計(時效、稽核、UI),而且目前完全沒有真實支援需求發生過。等真的有版主需要擁有者協助處理問題,再補這塊,屬於過度超前的設計。

---

## 10. CSRF / CORS / CSP

- **CSRF**:SameSite=Lax cookie是第一道防線,但不是唯一防線——所有會改變資料的API(POST/PUT/DELETE)額外要求一個CSRF token(頁面載入時由後端核發、存在另一個可被JS讀取的cookie或回應裡,前端送請求時放進自訂header,後端比對兩者一致)。這是標準的「double-submit cookie」模式,不需要額外套件。
- **CORS**:後台API只服務自己的網域(`line-event-rsvp.james594007.workers.dev`),不需要開放跨網域存取。管理端點明確檢查`Origin` header是否為自家網域,不符合就拒絕,作為CSRF的額外防線。
- **CSP**:設定`Content-Security-Policy`限制`script-src`只能是`'self'`加上LINE LIFF SDK那個CDN網域。現有頁面(`liff.html`/`admin.html`)目前把JS直接寫在`<script>`標籤內(inline),嚴格CSP預設會擋掉inline script——要嘛改用CSP nonce,要嘛把JS搬成外部`.js`檔。**這會是一個不小的重構**,我建議列入這次工作範圍(藉機把inline script搬出來),但會增加一些工時,先讓你知道。

---

## 11. 限流與告警

**建議用Cloudflare原生的Rate Limiting Rules**(在Cloudflare Dashboard設定,不用寫程式),針對:
- `/auth/line/callback`:防止暴力嘗試token交換
- `/api/moderators/apply`:防止洗申請
- 擁有者的核准/拒絕/停權端點:防止帳號被盜後大量操作

這是現成的平台功能,符合「不造輪子」原則,比自己在Worker裡寫滑動視窗計數器更省事也更可靠。告警部分,Cloudflare的Rate Limiting規則觸發時有事件記錄,量體小的話不需要額外接告警系統,先用這個就夠。

---

## 12. 資料保留期限

這題本質是商業/法遵決策,我只能給技術上可行的選項,**最終期限要產品決定**:

- **稽核紀錄(audit_log)**:建議預設保留,不主動刪除(量體小,保留對未來排查有幫助,刪除的風險大於保留的成本)。
- **申請/帳號資料(moderators)**:只存一個不透明的LINE user id,沒有額外個資,建議比照稽核紀錄保留;除非有人明確要求刪除帳號(可比照一般服務的「刪除帳號」請求處理,需要產品另外定SOP)。
- **活動與報名資料**:這塊建議設一個「活動結束後N個月自動可封存」的規則,但**N是多少、封存後是否仍可查、要不要通知版主**,這些是產品決策,不是技術限制——先列為開放問題,等你們決定後我再實作成排程清理邏輯(Cloudflare Workers支援Cron Triggers可以做定時任務)。

---

## 13. 公開端點要刪減哪些欄位

現有 `GET /api/events/:id` 用`SELECT *`,之後加了`moderator_id`欄位後**必須排除**,否則內部歸屬資訊就外洩了。

**建議新增一個「公開視圖」白名單**,明確列出可回傳欄位,而不是繼續用`SELECT *`再事後挑著拿掉(白名單比黑名單安全,之後加新欄位不會忘記檢查):

```
公開允許:id, title, organizer, event_date, meeting_location, meeting_time,
         fee, passenger_fee, capacity, cutoff_at, group_link, notes, status,
         enable_attendance_type, enable_car_role, enable_plus_one
不可外洩:moderator_id(新增)、任何未來會加的審核/內部欄位
```

`roster`端點本來就只回傳`display_name`/`picture_url`/角色標籤,沒有洩漏`line_user_id`,這塊維持現狀即可,不用改。

---

## 14. 時區

**建議維持現有做法**:資料庫統一存UTC(SQLite的`datetime('now')`本來就是UTC),顯示層(前端JS或API回應格式化時)才轉成Asia/Taipei。

截止日(`cutoff_at`)目前是自由文字欄位(例如"10/28"),不是真正的日期型別,所以談不上時區問題,這個欄位本來就只是給人看的提示文字,不是程式拿來做邏辯判斷的依據(現在沒有「到了截止日自動關閉」這個功能,PRD第11節也明確把這個排除在本期之外)。稽核紀錄的時間戳記統一用UTC ISO格式存,跟其他表一致,不會有歧義。

---

## 15. 分階段計畫、資料移轉順序、測試策略、風險、工期估算

### 分階段(每個階段可獨立驗收、獨立deploy)

**第一階段:登入與session骨架**
- LINE OAuth流程(`/auth/line/start`、`/auth/line/callback`)
- `moderators`、`sessions`表
- 第一位擁有者的secret-based bootstrap
- 對應AC-01

**第二階段:申請與審核流程**
- 申請端點、`audit_log`表
- 擁有者審核頁面(核准/拒絕/停權/恢復)
- 對應AC-02、AC-03、AC-04、AC-05、AC-09、AC-10

**第三階段:資料隔離**
- `events`表加`moderator_id`,所有既有管理端點(建立/編輯/刪除/名單/統計/CSV)加歸屬檢查
- 公開端點改白名單欄位
- 對應AC-06、AC-07、AC-11、AC-13

**第四階段:固定社群名稱 + 安全強化**
- 固定社群名稱邏輯(對應AC-08)
- CSRF token、CORS檢查、CSP header(含inline script搬遷)
- Cloudflare Rate Limiting設定
- 對應AC-12

**第五階段:舊機制移除與正式切換**
- 刪除`ADMIN_PASSCODE`相關程式碼與secret
- 測試資料備份+清空
- 隱私權政策/服務條款更新(配合新增的登入/申請/稽核行為)
- 對應AC-14、第12節上線前檢核全部項目

### 測試策略
- 每個API端點的整合測試對應PRD第9節AC-01~AC-14,用兩個測試版主帳號(模擬A、B)跑跨租戶負面測試是重點,這個在第三階段完成後要完整跑過一次
- 瀏覽器端手動驗收:申請→核准→建活動→停權→確認被擋,這個流程我會在部署到正式站前,先在preview環境跟你或你指定的測試帳號實際跑一次

### 風險
- **最大風險是「資料隔離」漏檢查**——8個左右的管理端點都要加歸屬檢查,漏一個就是資安漏洞。我會把歸屬檢查寫成一個共用middleware/helper,所有端點強制套用,而不是每個端點各自土法煉鋼寫一次,降低漏檢查的機率。
- **CSP + inline script搬遷**是這次範圍裡唯一牽涉「重構既有可運作程式碼」的部分,有一定機率在搬遷過程中不小心弄壞現有的報名頁(`liff.html`)——這部分我會先做,先跑過現有的手動測試流程(報名/取消/額滿/三組選項)確認沒壞,再往下做權限功能。

### 工期估算
以我們之前這個session的節奏(一個功能通常半小時到一小時內可以做完、測完、部署),這次範圍明顯更大——涉及全新的認證機制、安全機制、資料遷移,不是加欄位、加按鈕這種量級。保守估計分五個階段,**每個階段大約是一次到兩次像今天這樣的完整工作時段**(連續開發+測試+部署),全部做完大概需要5-8個這樣的工作時段,取決於中間要跟你確認的開放決策(第7、8、9、12題)回覆得多快。

---

## 需要產品確認才能開始實作的項目

1. 第7題:停權後既有活動頁要「唯讀+停止報名」(我的建議)還是其他方案?
2. 第8題:是否同意「P0階段不限制重新申請」?
3. 第9題:是否同意「P0階段擁有者完全不提供支援模式存取」,等有真實需求再做?
4. 第12題:活動/報名資料的保留期限怎麼訂?
5. 是否同意第6題「正式切換前,現有測試資料備份後整批刪除」這個破壞性操作?

其餘項目(第1-6、10、11、13、14題)我已經給出明確建議方案,會照這個方向實作,除非你們有不同意見。
