# 專案 AI 開發規範 (AGENTS.md)

## 專案現況
本 workspace 目前以 `downloadScantrader/` 的 Node.js 自動化流程為主，功能包含：
- 下載 Scantrader 影片
- 產生 ASR 字幕（Whisper）
- 擷取簡報畫面與 OCR
- 輸出股票彙整 Markdown

根目錄另包含 `mc/` 交易語法檔與工具腳本，主要為既有資產維護。

## 主要技術與依賴
- Runtime: Node.js 18+
- 自動化: Playwright
- 媒體處理: ffmpeg / ffmpeg-static
- OCR: tesseract.js（搭配 `chi_tra.traineddata`、`eng.traineddata`）
- ASR: Whisper CLI（外部 Python 環境）

## 常用操作指令

在 `downloadScantrader/` 目錄：
- 安裝依賴：`npm install`
- 安裝瀏覽器：`npm run install-browser`
- 下載頻道影片：`npm start`
- SRT 彙整：`npm run summarize-srt -- <路徑>`
- 簡報擷取：`npm run extract-slides -- <路徑>`
- 批次後處理：`npm run batch-process -- <路徑>`

在專案根目錄也可直接執行：
- `node .\downloadScantrader\index.js`
- `node .\downloadScantrader\summarize-srt.js <srt檔案或資料夾> [輸出md檔]`
- `node .\downloadScantrader\extract-slides.js <mp4/ts檔案或資料夾> [--max-frames N] [--min-frames N] [--interval 秒]`
- `node .\downloadScantrader\batch-media-process.js <資料夾或影片檔> [索引md輸出路徑]`

## 代碼規範與維護原則
1. 以現有 Node.js 腳本風格延伸，避免引入與既有流程衝突的框架。
2. 新增或修改 CLI 腳本時，需同步更新 `downloadScantrader/README.md` 的用法範例。
3. 涉及下載、轉檔、OCR、ASR 的流程需保留明確錯誤訊息與 fallback 邏輯。
4. 嚴禁覆寫 `mc/` 目錄下的既有語法檔，修改前需先備份。
5. 不可將帳密或 token 寫死在程式碼；敏感資訊一律使用環境變數或互動輸入。
6. 大型二進位資產（例如 `*.traineddata`）如需新增，先確認是否可重用既有檔案，避免重複存放。

## 目錄重點
- `downloadScantrader/`: 下載與後處理主程式
- `downloadScantrader/downloads/`: 輸出資料（字幕、簡報圖、股票彙整）
- `downloadScantrader/.session/`: 登入 session（本機狀態）
- `mc/`: 交易語法檔（高風險區，禁止直接覆寫）