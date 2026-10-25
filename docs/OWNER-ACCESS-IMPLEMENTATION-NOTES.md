# 擁有者核准與版主存取權限 — 實作紀錄

- 分支:`owner-access`
- 狀態:**本機/分支完成,未部署正式環境,未動正式資料**
- 對應:docs/OWNER-ACCESS-PRD.md、docs/OWNER-ACCESS-TECH-ASSESSMENT.md(含產品核准決策與技術修正)

本文件記錄實際實作跟技術評估/修正之間的落差、新增的細節決策,以及還剩什麼要做才能真的上線。

## 測試

```
npm install
npm test
```

82個測試全過,涵蓋:

- `test/lib/*.test.ts`:crypto(含簽章cookie)、PKCE、LINE OAuth驗證邏輯(mock LINE的網路呼叫)、session(含停權立即生效)、rate limit、資料保留sweep、公開欄位白名單、ownership helper
- `test/routes/mod-owner.test.ts`:**透過真正的Hono app + 真正的D1(Workers runtime內)**測權限隔離——待審核/拒絕/停權都被擋、停權對既有session立即生效、A看不到B的活動(跟活動不存在回應一樣)、CSRF/same-origin擋跨站請求、擁有者專屬端點非擁有者打不進去、suspend_reason只在單筆查詢看得到

**沒測到的部分**:`/auth/line/callback`走到真正打LINE真實伺服器那一步——測試裡是用`vi.stubGlobal('fetch', ...)`把LINE的token/verify端點回應整個mock掉,驗證callback端點本身的邏輯(簽章cookie驗證、state/nonce比對、建session/導頁)全部正確,但沒有也不可能驗證「我們送出去的request格式LINE真的看得懂、LINE真的會回我們預期的格式」。**串上真的LINE channel後,還是需要手動跑一次完整登入流程確認。**

## 第二輪修正(code review後)

對第一輪實作的review抓到幾個問題,都已修正、補測試、測試全過(見下方「跟技術評估/產品決策之間」維持原樣的部分,這裡只列這輪新增/改掉的):

1. **OAuth暫存cookie(`line_oauth`)原本只是裸JSON**,沒有簽章——理論上使用者可以自己竄改cookie內容(state/nonce/verifier)。改用既有的`signPayload`/`verifyPayload`(HMAC簽章+有效期),callback端點先驗簽跟過期時間才會用裡面的值。補了竄改、過期、不同密鑰偽造、cookie合法但query state對不上、以及mock LINE網路呼叫的「完整成功流程」測試(`test/routes/auth.test.ts`,9個測試)。
2. **新後台三個頁面(`mod.js`/`owner.js`/`mod-apply.js`)有DOM XSS**:活動名稱、LINE顯示名稱、報名者名稱這些不可信資料,原本直接字串接進`innerHTML`。抽出一個共用的`escapeHtml()`(純函式,不依賴DOM,放`public/escape-html.js`給瀏覽器載入,同份邏輯鏡射一份到`src/lib/escape-html.ts`方便寫自動測試),所有會被接進innerHTML的不可信欄位都包上這層。測試用`<img src=x onerror=...>`、屬性跳脫字串(`"><script>`、`' onmouseover='`)驗證輸出不含裸的`<`、`>`、`"`、`'`(`test/lib/escape-html.test.ts`,6個測試)。沒有依賴CSP當輸入清理——CSP是另一層防護,不是取代escaping。
3. **舊密碼路徑的跨租戶漏洞**:`PUT/DELETE /api/events/:id`跟`GET /api/events`(清單)原本沒有限定`moderator_id`,等於舊密碼除了能管自己建的活動,也能看到/改到/刪到透過新版主系統建立的任何活動。全部補上`moderator_id = 'mod_legacy_admin'`的條件。刪除端點額外修正了執行順序問題:原本是「先刪registrations、再刪events」,如果activity其實不屬於legacy admin,舊的寫法會在events那步被擋下(0 rows affected)但registrations已經被刪了——等於能悄悄清空別人的報名資料。改成先用WHERE moderator_id查一次確認擁有權,確認是自己的才動手刪。測試證明A的活動在legacy清單裡看不到、改不動、刪不掉,而且B(真正的擁有者)建的報名資料不會被動到(`test/routes/legacy-isolation.test.ts`,5個測試)。
4. **migration 0003原本是破壞性的**:用`ALTER TABLE events RENAME`+重建的方式讓`moderator_id`/`ends_at`直接是NOT NULL,等於`wrangler d1 migrations apply`一下去,現有的events跟registrations資料就沒了。改成**非破壞性**:只用`ALTER TABLE ADD COLUMN`加兩個nullable欄位、把既有活動UPDATE成`mod_legacy_admin`(純新增,不是覆蓋或刪除),migration 0003本身不做任何rename/drop/重建。真正要把這兩個欄位變成NOT NULL,寫成一個**不在`migrations/`目錄裡**的手動腳本(`ops/finalize-owner-access-not-null.sql`),`wrangler d1 migrations apply`不會自動跑到它。這個腳本連帶要重建`registrations`——起初漏掉這點,被抓出來:SQLite現代版的`ALTER TABLE RENAME`會自動把「參照到被重新命名的表」的其他表之FOREIGN KEY子句文字改寫,所以`events`一改名成`events_pre_not_null`,`registrations.event_id`的FK宣告就被SQLite自動重寫成指向`events_pre_not_null`,而且之後不會再被改回來——如果不連帶重建`registrations`,最後drop掉`events_pre_not_null`時,`registrations`就留著一個指向已經不存在的表名的懸空FK。已經在一份乾淨的本機D1上,用2個活動+3筆報名(含一筆有`plus_one_count`的driver、一筆cancelled)實際跑過這個腳本,`PRAGMA foreign_key_check`回傳0筆、所有欄位資料比對過都沒變、新`registrations`的FK子句正確指向`events`(不是`events_pre_not_null`)、舊的兩張暫存表事後確認都真的不見了——細節跟操作前置條件都寫在`ops/README.md`。測試用的schema(`test/setup.ts`)維持原本的NOT NULL最終版本沒動,因為那是在測「最終狀態該有的行為」,跟實際migration怎麼分階段套用是兩回事。
5. **核准/拒絕/恢復/停權的多個寫入改成D1 batch**:`approveModerator`/`rejectModerator`/`restoreModerator`原本是「UPDATE狀態」+「寫audit_log」兩次分開的`.run()`,`suspendModerator`則是UPDATE狀態+UPDATE events+寫audit_log三次分開——都改成`db.batch([...])`一次送出。保留原本的狀態前置檢查語意(先查目前狀態決定要不要允許轉換,檢查不過直接回傳,不送batch)。D1的`batch()`是不是真正原子性以ACID等級保證,官方文件沒有像關聯式資料庫transaction那樣明確承諾,但至少比分開呼叫減少了「UPDATE成功但audit寫入失敗、兩者狀態不一致」的中間窗口。原本的14個moderators測試全部通過,行為沒變。

## 跟技術評估/產品決策之間,實作時多做的決定

這些是寫程式過程中遇到、技術評估文件沒明講、但要有個答案才能往下寫的小決策:

1. **FR-06的「審核時暫時顯示」怎麼落地**:`moderators`表加了`pending_display_name`欄位,申請當下存入LINE顯示名稱,**只在`status='pending'`時存在**,一核准或拒絕就立刻清空(`approveModerator`/`rejectModerator`裡面做)。擁有者審核清單只看得到這個暫時欄位,不會有任何永久的「誰是誰」對照表。
2. **舊的共用密碼系統怎麼跟新schema共存**(指令要求不能撤銷`ADMIN_PASSCODE`):建了一個合成的`mod_legacy_admin`版主列(migration裡seed),舊的`POST/PUT/GET/DELETE /api/events*`(密碼保護)操作全部都限定在這個假版主底下(每個端點都有`moderator_id = 'mod_legacy_admin'`的WHERE條件,list/update/delete都驗證過不會碰到其他版主的活動)。**第五階段正式切換時這個合成列跟舊路徑要一起刪掉**。
3. **舊的公開參加者端點**(`GET /api/events/:id`,`liff.html`在用)原本是`SELECT *`,現在events表多了`moderator_id`欄位會跟著外洩,已經改成走白名單(`toPublicEvent`)。這不是PRD原本列的範圍,但不動它就是個資外洩,所以在這個分支一起修了。
4. **CSRF cookie的值不需要存DB**:用標準的double-submit模式(cookie跟header字串相等即可),沒有額外存一份到session表,減少一次資料表。
5. **CSP的script-src**:新頁面(`mod.html`、`mod-apply.html`、`owner.html`)完全沒有inline script,CSP給最嚴格的設定;`liff.html`/`admin.html`的JS還是寫在頁面裡,這兩個路徑CSP還留`unsafe-inline`——完整抽出inline script風險(尤其`liff.html`是正式在跑的參加者報名流程)比這次owner-access範圍本身還大,所以沒有在這個分支動它,算是明確留下的技術債,不是漏掉。
6. **Rate limiting**:沒辦法確認這個Worker掛在`*.workers.dev`共用網域上,James的Cloudflare方案能不能設zone層級的Rate Limiting Rules(那是給你自己管理的網域用的,不確定`*.workers.dev`適不適用,也沒有在這個分支去戳Cloudflare帳號設定做確認)。改用D1自己做一個簡單的固定時間窗計數器當保底方案,量體小、不依賴帳號方案,在`src/lib/ratelimit.ts`。
7. **資料保留的`ends_at`**:events表新增`ends_at`(ISO日期),專門給保留期限計算用,原本的`event_date`(自由文字,例如"10/29(四)")維持不變當顯示用。新建/編輯活動的表單多了一個必填的日期欄位(應用層強制必填;資料庫層級目前是nullable,見下方「非破壞性migration」說明)。
8. **保留sweep已經寫好但沒接上**:`src/lib/retention.ts`的`runRetentionSweep`函式完整實作+測試過(含archive去識別化統計、dry-run模式),`wrangler.toml`裡留了註解掉的`[triggers]`cron設定,`index.ts`也寫好`scheduled`handler——**這些都是inert的,要實際上線用才需要把註解打開再部署**,這個分支沒有做這件事。

## 還需要James操作外部平台才能繼續

1. 去LINE Developers Console,在**現有的那個LINE Login channel**(LIFF_ID所在的那個,不用開新的)設定裡新增一條 **Callback URL**:`https://<正式網址>/auth/line/callback`
2. 把這個channel的 **Channel ID** 填進`wrangler.toml`的`LINE_LOGIN_CHANNEL_ID`(這個不是密碼,可以直接寫進設定檔)
3. 這三組要在部署前用`wrangler secret put`設定(分支裡完全沒有設,我沒有建立或修改任何正式secret):
   - `LINE_LOGIN_CHANNEL_SECRET`(同一個channel的Channel Secret)
   - `OWNER_LINE_USER_ID`(James自己驗證過的LINE user id——流程是:先跑一次`/auth/line/start`登入,從後端log或暫時加一行debug輸出拿到驗證後的`sub`值,設完secret再把debug輸出拿掉;**這個值本身不能寫進任何commit或文件**)
   - `COOKIE_SIGNING_SECRET`(隨便一組長亂數字串,例如`openssl rand -base64 32`)

## 第五階段(正式切換)還沒做,刻意停在這裡

- 沒有刪除`ADMIN_PASSCODE`或舊的`/admin`、`/api/events`passcode路徑
- 沒有備份或清空現有測試活動資料
- 沒有部署到正式環境、沒有對remote D1跑migration 0003
- 沒有打開cron trigger

這些都是指令明確要求停在「需要人工核准」的位置,全部留著等你們確認。
