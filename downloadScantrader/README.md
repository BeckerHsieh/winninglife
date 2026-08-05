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

若遠端 HLS 因 ffmpeg 與 CDN/TLS 相容性導致 mp4 封裝失敗，程式仍會改走 `.ts` 暫存與後處理流程，但後處理完成後不保留原始影像檔。

### 顯示瀏覽器視窗（方便除錯）
```bash
node index.js --no-headless
```

### 獨立腳本：SRT 彙整
```bash
node .\downloadScantrader\summarize-srt.js <srt檔案或資料夾> [輸出md檔]
```

PowerShell 路徑若包含 `#`、`(`、`)`、空白，請用單引號包住參數：
```bash
node .\downloadScantrader\summarize-srt.js '.\downloads\0001_xxx\asr' 'xx.md'
```

### 獨立腳本：簡報擷取（mp4/ts）
```bash
node .\downloadScantrader\extract-slides.js <mp4/ts檔案或資料夾>
```

PowerShell 同樣建議：
```bash
node .\downloadScantrader\extract-slides.js '.\downloads\0001_xxx.ts'
```

可直接指定擷取張數參數（不依賴環境變數）：
```bash
node .\downloadScantrader\extract-slides.js '.\downloadScantrader\downloads\0001_xxx.ts' --max-frames 800 --min-frames 600 --interval 1
```

若要在 PowerShell 設定環境變數，請用：
```bash
$env:SLIDE_MAX_FRAMES='800'
$env:SLIDE_MIN_FRAMES='600'
$env:SLIDE_FALLBACK_INTERVAL_SECONDS='1'
node .\downloadScantrader\extract-slides.js '.\downloadScantrader\downloads\0001_xxx.ts'
```

### 獨立腳本：批次處理影片 + 對應 SRT + 總索引
```bash
node .\downloadScantrader\batch-media-process.js <資料夾或影片檔> [索引md輸出路徑]
```

### 獨立腳本：YouTube 受限影片下載（Cookie）
```bash
node .\downloadScantrader\yt-private-download.js --cookies-file .\downloadScantrader\.session\yt-cookies.txt <youtube-url>
```

僅列格式（建議先執行，確認可用格式）：
```bash
node .\downloadScantrader\yt-private-download.js --cookies-file .\downloadScantrader\.session\yt-cookies.txt --list-formats <youtube-url>
```

若看到 `n challenge solving failed` 或 `Only images are available`：
- 先更新 yt-dlp：`pip install -U yt-dlp`
- 腳本已內建 `--remote-components ejs:github`，首次可能會自動下載 challenge solver
- 若仍失敗，多半是 YouTube 對帳號/區域的臨時限制，可先用 `--list-formats` 檢查是否仍只有 `sb*` 圖片格式

也可使用 npm scripts：
```bash
npm run summarize-srt -- <路徑>
npm run extract-slides -- <路徑>
npm run batch-process -- <路徑>
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

後處理完成後，不保留原始 `.mp4` / `.ts` 影片檔；`downloads/` 主要保留以下產物：

每支影片下載後，會額外產生：

1. 字幕文字 Markdown
```
downloads/0001_文章標題/0001_文章標題_字幕文字.md
```

2. 簡報換頁擷取圖（.jpg）
```
downloads/slides/20260703_00001.jpg
downloads/slides/20260703_00002.jpg
...
```

簡報圖目前改為 Playwright 瀏覽器截圖流程，會先在 `slides_tmp/` 產生多張暫存圖，再做 OCR 與股票辨識。

3. 股票彙整 Markdown（依「代碼+名稱」命名）
```
downloads/stocks/2330台積電.md
downloads/stocks/2317鴻海.md
...
```

> 註：字幕改為 ASR（Whisper 語音辨識），簡報股票辨識仍使用 OCR。

## 字幕 ASR 需求

請先安裝任一種 Whisper 執行方式（擇一即可）：

1. whisper CLI（建議）
2. `py -3 -m whisper`
3. `python -m whisper`

若未安裝 Whisper，程式會顯示「找不到可用 Whisper 執行環境」。

可用環境變數調整模型：

```bash
set WHISPER_MODEL=small
set WHISPER_LANGUAGE=zh
set SLIDE_MIN_FRAMES=200
set SLIDE_FALLBACK_INTERVAL_SECONDS=5
```

可用環境變數調整簡報擷取張數：

```bash
set SLIDE_MAX_FRAMES=200
```

PowerShell 寫法：
```bash
$env:SLIDE_MAX_FRAMES='200'
```

- `SLIDE_MIN_FRAMES`：瀏覽器截圖流程期望至少擷取的張數
- `SLIDE_FALLBACK_INTERVAL_SECONDS`：瀏覽器 seek 抽圖時，兩張截圖之間的最大秒數

## 注意事項

- HLS 串流（`.m3u8`）需安裝 `ffmpeg` 才能下載
- 若無法登入，可加上 `--no-headless` 觀察瀏覽器行為
- 除錯截圖會存放在 `debug-*.png`
