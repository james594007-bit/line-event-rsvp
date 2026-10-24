# line-event-rsvp

LINE 活動報名統計工具 MVP。參加者在 LINE 裡打開一個連結報名/取消,任何人都能即時看到人數和名單;截止後主持人貼上活動小群的邀請連結,系統自動私訊給每個確認報名的人。

## 架構

- Cloudflare Workers + D1(跟 fathub-web 處理 Lemon webhook 同一套,不用學新部署方式)
- LIFF(LINE 內建瀏覽器頁面,自動帶入使用者身分,排重複靠 LINE user ID)
- 報名/取消/名單都是公開 API,沒有隱藏後台

## 現在能跑的部分

- `POST /api/events` 建立活動
- `GET /api/events/:id` 活動資訊
- `GET /api/events/:id/roster` 即時人數 + 名單
- `POST /api/events/:id/register` / `.../cancel` 報名 / 取消(以 LINE userId 排重複)
- `POST /api/events/:id/invite-link` 設定小群邀請連結,觸發對所有已報名者的推播
- `public/liff.html` 陽春的報名頁面(人數 + 名單 + 兩個按鈕)

## 還沒做,先知道有這個缺口

- **沒有管理後台**:`POST /api/events` 和 `/invite-link` 現在誰都能打,沒有驗證主持人身分。先用 curl/Postman 手動呼叫測試,等有真人要用再補權限。
- **額滿自動關閉只擋得住超額報名,沒有自動通知主持人額滿了**
- **提醒功能完全沒做**(截止前提醒大家還沒報名的人)

## 要先去 LINE Developers Console 做的事(只有你能做,需要你的 LINE 帳號)

1. 建立一個 **Messaging API channel**(官方帳號),拿到:
   - Channel secret
   - Channel access token(long-lived)
2. 在同一個 provider 下建立一個 **LIFF app**:
   - Size 選 Full
   - Endpoint URL 填你的 Worker 網址 + `/liff.html`(例如 `https://line-event-rsvp.<你的子網域>.workers.dev/liff.html`)
   - 拿到 LIFF ID
3. 把官方帳號加為好友的流程要先確定——**推播訊息只能發給已加好友的人**,所以報名頁最好掛在官方帳號的圖文選單或自動回覆裡,引導大家先加好友再報名。

## 本機/部署步驟

```bash
npm install

# 建立 D1 資料庫(第一次)
npx wrangler d1 create line_event_rsvp
# 把輸出的 database_id 貼進 wrangler.toml

npm run db:migrate:local   # 本機測試用
npm run db:migrate:remote  # 部署後的正式資料庫

# 填入 secrets(不要寫進 wrangler.toml)
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET

# wrangler.toml 裡的 LIFF_ID 換成第 2 步拿到的值

npm run dev      # 本機測試
npm run deploy   # 部署到 Cloudflare
```

## 測一個活動的最短路徑

```bash
curl -X POST https://<your-worker>/api/events \
  -H 'Content-Type: application/json' \
  -d '{"title":"週末爬山團","capacity":20,"cutoffAt":"2026-10-30"}'
# 回傳 { "id": "ev_xxxx" }

# 把這個連結丟進 LINE 群組測試:
# https://liff.line.me/<LIFF_ID>?event=ev_xxxx
```
