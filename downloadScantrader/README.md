# Scantrader 影片下載器

下載 [我是金錢爆「速效錠」](https://scantrader.com/u/77340) 頻道的所有影片。

## 前置需求

- Node.js 18+
- ffmpeg（下載 HLS 串流必須）：https://ffmpeg.org/download.html

## 安裝

```bash
cd downloadScantrader
npm install
npm run install-browser   # 安裝 Playwright Chromium
```

## 使用方式

### 下載整個頻道所有影片
```bash
node index.js
```

### 只下載單篇文章
```bash
node index.js --article https://scantrader.com/article/019efe1021b30000122cdd000000000000
```

下載完成後會顯示檔案大小與影片時長，例如：`[完成] 0001_xxx.mp4 (512.3 MB, 34:02)`
可用這行快速確認是否抓到完整影片（例如你這支約 34 分鐘）。

若遠端 HLS 因 ffmpeg 與 CDN/TLS 相容性導致 mp4 封裝失敗，程式會自動保留完整 `.ts` 檔，仍會顯示實際時長，可直接播放或再自行轉檔。

### 顯示瀏覽器視窗（方便除錯）
```bash
node index.js --no-headless
```

### 透過環境變數傳入帳密（CI/自動化用）
```bash
set SCANTRADER_EMAIL=poyenhsieh@gmail.com
set SCANTRADER_PASSWORD=你的密碼
node index.js
```

## 登入流程

1. 程式啟動後會提示輸入 LINE 帳號密碼
2. 第一次登入後 session 會儲存在 `.session/auth.json`
3. 之後重新執行不需要再輸入密碼（直到 session 過期）

## 下載位置

所有影片存放於 `downloads/` 資料夾，命名格式：
```
0001_文章標題.mp4
0002_文章標題.mp4
...
```

## 注意事項

- HLS 串流（`.m3u8`）需安裝 `ffmpeg` 才能下載
- 若無法登入，可加上 `--no-headless` 觀察瀏覽器行為
- 除錯截圖會存放在 `debug-*.png`
