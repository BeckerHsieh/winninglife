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

---

## 架構規格（Spec）

### 模組清單與職責

| 檔案 | 職責 |
|------|------|
| `index.js` | 主程式：CLI 解析、登入、文章列表、下載調度、後處理協調 |
| `login.js` | Playwright 登入 + session 持久化（`.session/auth.json`）|
| `scraper.js` | 取得頻道所有文章 URL；從文章頁面攔截真實影片 URL |
| `downloader.js` | 下載影片：HLS（ffmpeg）或直連 mp4（axios）|
| `postprocess.js` | 後處理三管線：ASR 字幕、簡報擷取、股票 OCR 彙整 |
| `extract-slides.js` | 獨立執行的簡報擷取腳本（可對資料夾批次處理）|
| `summarize-srt.js` | 獨立執行的 SRT 彙整腳本，輸出 Markdown |
| `batch-media-process.js` | 批次後處理：影片 + SRT + 總索引 |
| `yt-private-download.js` | YouTube 受限影片下載（Cookie + yt-dlp）|

---

### 完整處理流程

```
runDownload.bat
│
├─ node index.js --article <url>
│   │
│   ├─ [1] 前置檢查  checkAsrPreflight()          ← postprocess.js
│   │       ├─ ffmpeg 是否存在（ffmpeg-static 或系統）
│   │       └─ Whisper 是否可用（CLI / py -m whisper / python -m whisper）
│   │
│   ├─ [2] 登入      login()                       ← login.js
│   │       ├─ 讀取 .session/auth.json（有效時跳過輸入）
│   │       └─ Playwright Chromium 登入 scantrader.com
│   │
│   ├─ [3] 爬取      getArticleUrls()              ← scraper.js
│   │       └─ 頻道模式：掃描 /u/77340 取得所有文章 URL
│   │           （單篇模式：直接使用 --article 參數）
│   │
│   ├─ [4] 解析影片  getVideoUrlsFromArticle()     ← scraper.js
│   │       ├─ 攔截 Response content-type 判定影片 URL
│   │       ├─ 依 manifest score 排序（JWPlayer signed > canonical > m3u8 > mp4）
│   │       └─ 去重（同 provider key 只保留最高分）
│   │
│   ├─ [5] 下載      downloadVideo()               ← downloader.js
│   │       ├─ HLS（.m3u8）→ ffmpeg -c copy 輸出 .mp4
│   │       │   ├─ 失敗時嘗試多組 ffmpeg 參數組合
│   │       │   └─ 最終 fallback 輸出 .ts 暫存
│   │       ├─ 直連 mp4 → axios stream 寫檔
│   │       ├─ 403 / EOF 錯誤 → 重新解析文章取新 URL 後重試
│   │       └─ 已存在同名檔案 → 略過（skipped）
│   │
│   └─ [6] 後處理    processDownloadedVideo()      ← postprocess.js
│           │
│           ├─ [6a] ASR 字幕
│           │       ├─ ffmpeg 抽音訊 → audio.wav
│           │       ├─ whisper CLI 或 python -m whisper → asr/*.srt
│           │       ├─ 解析 SRT → timeline[]
│           │       ├─ buildSubtitleSummary() 抽出重點句（最多 8 條）
│           │       └─ 輸出 {baseName}_字幕文字.md
│           │
│           ├─ [6b] 簡報擷取
│           │       ├─ 主流程：Playwright 開啟本機 video URL
│           │       │   ├─ .ts 需先 ffmpeg → browser_preview.mp4
│           │       │   ├─ 依時間軸 seek → 截圖暫存至 slides_tmp/
│           │       │   └─ 目標張數 SLIDE_MIN_FRAMES（預設 200）
│           │       ├─ fallback：ffmpeg fps=1/N 抽幀（SLIDE_FALLBACK_INTERVAL_SECONDS）
│           │       ├─ OCR（tesseract.js）辨識每張截圖文字
│           │       ├─ 過濾非中文、UI 浮水印、重複畫面
│           │       └─ 輸出 downloads/slides/YYYYMMDD_NNNNN.jpg
│           │
│           └─ [6c] 股票彙整
│                   ├─ 從 OCR 文字 regex 抽取台股代碼+名稱
│                   ├─ 每集彙整 mentions[]
│                   └─ writeStockMarkdowns() → downloads/stocks/{代碼名稱}.md
│
└─ node extract-slides.js ./downloadScantrader/downloads   （下載成功後執行）
        └─ 對 downloads/ 資料夾內所有影片再次執行簡報擷取
```

---

### 輸出產物對應

| 管線 | 輸出路徑 | 說明 |
|------|----------|------|
| ASR 字幕 | `downloads/{標題}/{標題}_字幕文字.md` | SRT 時間軸 + 重點摘要 |
| ASR SRT | `downloads/{標題}/asr/*.srt` | Whisper 原始字幕檔 |
| ASR 錯誤 | `downloads/{標題}/asr/asr_error.log` | 僅 ASR 失敗時產生 |
| 簡報截圖 | `downloads/slides/YYYYMMDD_NNNNN.jpg` | 所有影片共用同一資料夾 |
| 股票彙整 | `downloads/stocks/{代碼名稱}.md` | 跨影片累計提及 |
| 預覽中繼 | `downloads/{標題}/browser_preview.mp4` | TS 轉 mp4 暫存（供 Playwright seek）|

---

### 關鍵環境變數

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `SLIDE_MAX_FRAMES` | `200` | 簡報擷取上限張數 |
| `SLIDE_MIN_FRAMES` | `200` | Playwright seek 流程目標張數 |
| `SLIDE_FALLBACK_INTERVAL_SECONDS` | `5` | ffmpeg fallback 抽幀間隔（秒）|
| `WHISPER_MODEL` | `small` | Whisper 模型大小 |
| `WHISPER_LANGUAGE` | `zh` | ASR 語言 |
| `SKIP_ASR_PREFLIGHT` | — | 設為 `1` 可略過前置環境檢查 |
| `SCANTRADER_EMAIL` | — | 帳號（不設則互動輸入）|
| `SCANTRADER_PASSWORD` | — | 密碼（不設則互動輸入）|

---

### 錯誤處理策略

| 情境 | 處理方式 |
|------|----------|
| 下載 403 / EOF | 重新解析文章取新 URL，重試一次 |
| ffmpeg 封裝失敗 | 降級 fallback 輸出 `.ts` |
| Playwright 簡報截圖失敗 | ffmpeg fps 抽幀 fallback |
| ASR 全部 backend 失敗 | 輸出錯誤版字幕 md + asr_error.log，不中止主流程 |
| Session 過期 | 偵測到後重新要求輸入帳密 |
