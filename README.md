# line-event-rsvp

LINE 活動報名統計工具 MVP。參加者在 LINE 裡打開一個連結報名/取消,任何人都能即時看到人數和名單(含開車/共乘);活動群連結報名時就直接顯示,不用等成團。

## 架構

- Cloudflare Workers + D1(跟 fathub-web 處理 Lemon webhook 同一套,不用學新部署方式)
- LIFF(LINE 內建瀏覽器頁面,自動帶入使用者身分,排重複靠 LINE user ID)
- 報名/取消/名單都是公開 API,沒有隱藏後台

## 現在能跑的部分

- `POST /api/events` 建立活動(主題/主揪/日期/集合地點時間/費用/乘客車資/人數/截止日/活動群連結/備註)
- `GET /api/events/:id` 活動資訊
- `GET /api/events/:id/roster` 即時人數(含開車/共乘分計) + 名單
- `POST /api/events/:id/register` / `.../cancel` 報名 / 取消(以 LINE userId 排重複,報名要帶 `role: "driver" | "passenger"`)
- `public/liff.html` 報名頁面:顯示活動資訊、即時人數、開車或共乘選擇、報名後顯示活動群連結
- `POST /api/events/:id/invite-link` **先不用管**——這是等以後要做「成團才建群、自動推播邀請」的活動類型才需要,目前範本是活動群連結一開始就知道,不需要這個

## 還沒做,先知道有這個缺口

- **沒有管理後台**:`POST /api/events` 現在誰都能打,沒有驗證主持人身分。先用 curl/Postman 手動呼叫建活動,等有真人要用再補權限。
- **額滿自動關閉只擋得住超額報名,沒有自動通知主持人額滿了**
- **提醒功能完全沒做**(截止前提醒大家還沒報名的人)
- **免責聲明/備註是自由文字**,沒有存成結構化資料,每次建活動要自己貼進 `notes` 欄位

## 要先去 LINE Developers Console 做的事(只有你能做,需要你的 LINE 帳號)

**V1 測試只需要這樣,不用申請官方帳號:**

1. 建立一個 provider,底下建一個 **LINE Login channel**
2. 在這個 channel 裡加一個 **LIFF app**:
   - Size 選 Full
   - Endpoint URL 填你的 Worker 網址 + `/liff.html`(例如 `https://line-event-rsvp.<你的子網域>.workers.dev/liff.html`)
   - Scope 勾 `profile`
   - 拿到 LIFF ID,填進 `wrangler.toml` 的 `LIFF_ID`

**之後如果要做「截止後自動私訊提醒/推播邀請連結」才需要額外做這些**(現在可以跳過):

- 另外建一個 Messaging API channel(官方帳號),拿到 Channel secret + Channel access token,用 `wrangler secret put` 設定——這是 `/webhook` 和 `/invite-link` 這兩個端點在用的,沒設定不影響報名/取消/查名單這些核心功能。

## 本機/部署步驟

```bash
npm install

# 建立 D1 資料庫(第一次)
npx wrangler d1 create line_event_rsvp
# 把輸出的 database_id 貼進 wrangler.toml

npm run db:migrate:local   # 本機測試用
npm run db:migrate:remote  # 部署後的正式資料庫

# wrangler.toml 裡的 LIFF_ID 換成 LINE Login channel 底下 LIFF app 的 ID

npm run dev      # 本機測試
npm run deploy   # 部署到 Cloudflare
```

## 測一個活動的最短路徑

```bash
curl -X POST https://<your-worker>/api/events \
  -H 'Content-Type: application/json' \
  -d '{
    "title":"週末北插天山健走",
    "organizer":"James",
    "eventDate":"2026-11-08",
    "meetingLocation":"捷運動物園站2號出口",
    "meetingTime":"07:00",
    "fee":"免費",
    "passengerFee":"200元",
    "capacity":20,
    "cutoffAt":"2026-11-05",
    "groupLink":"https://line.me/ti/g/xxxxxx",
    "notes":"1. 報名後要取消,按取消就好,不用刪文\n2. 自行評估安全狀況,建議自行投保"
  }'
# 回傳 { "id": "ev_xxxx" }

# 把這個連結丟進 LINE 群組測試:
# https://liff.line.me/<LIFF_ID>?event=ev_xxxx
```
