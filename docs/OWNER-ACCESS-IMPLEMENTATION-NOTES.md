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

**沒測到的部分**:`/auth/line/callback`的「真正成功換到LINE token+id_token」這條路徑,因為需要真的打LINE的OAuth伺服器或架一個完整的mock OAuth provider,目前只在`src/lib/line-auth.ts`用mocked fetch測過該函式本身的邏輯(簽章驗證、iss/aud/exp/nonce檢查全部覆蓋)。**串上真的LINE channel後,需要手動跑一次完整登入流程確認。**

## 跟技術評估/產品決策之間,實作時多做的決定

這些是寫程式過程中遇到、技術評估文件沒明講、但要有個答案才能往下寫的小決策:

1. **FR-06的「審核時暫時顯示」怎麼落地**:`moderators`表加了`pending_display_name`欄位,申請當下存入LINE顯示名稱,**只在`status='pending'`時存在**,一核准或拒絕就立刻清空(`approveModerator`/`rejectModerator`裡面做)。擁有者審核清單只看得到這個暫時欄位,不會有任何永久的「誰是誰」對照表。
2. **舊的共用密碼系統怎麼跟新schema共存**(指令要求不能撤銷`ADMIN_PASSCODE`,但`events.moderator_id`現在是NOT NULL):建了一個合成的`mod_legacy_admin`版主列(migration裡seed),舊的`POST/PUT /api/events`(密碼保護)建立的活動都掛在這個假版主底下。這純粹是為了不讓舊路徑直接因為NOT NULL壞掉,**第五階段正式切換時這個合成列跟舊路徑要一起刪掉**。
3. **舊的公開參加者端點**(`GET /api/events/:id`,`liff.html`在用)原本是`SELECT *`,現在events表多了`moderator_id`欄位會跟著外洩,已經改成走白名單(`toPublicEvent`)。這不是PRD原本列的範圍,但不動它就是個資外洩,所以在這個分支一起修了。
4. **CSRF cookie的值不需要存DB**:用標準的double-submit模式(cookie跟header字串相等即可),沒有額外存一份到session表,減少一次資料表。
5. **CSP的script-src**:新頁面(`mod.html`、`mod-apply.html`、`owner.html`)完全沒有inline script,CSP給最嚴格的設定;`liff.html`/`admin.html`的JS還是寫在頁面裡,這兩個路徑CSP還留`unsafe-inline`——完整抽出inline script風險(尤其`liff.html`是正式在跑的參加者報名流程)比這次owner-access範圍本身還大,所以沒有在這個分支動它,算是明確留下的技術債,不是漏掉。
6. **Rate limiting**:沒辦法確認這個Worker掛在`*.workers.dev`共用網域上,James的Cloudflare方案能不能設zone層級的Rate Limiting Rules(那是給你自己管理的網域用的,不確定`*.workers.dev`適不適用,也沒有在這個分支去戳Cloudflare帳號設定做確認)。改用D1自己做一個簡單的固定時間窗計數器當保底方案,量體小、不依賴帳號方案,在`src/lib/ratelimit.ts`。
7. **資料保留的`ends_at`**:events表新增`ends_at`(ISO日期,NOT NULL),專門給保留期限計算用,原本的`event_date`(自由文字,例如"10/29(四)")維持不變當顯示用。新建/編輯活動的表單多了一個必填的日期欄位。
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
