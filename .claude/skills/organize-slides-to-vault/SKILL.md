---
name: organize-slides-to-vault
description: 將 Scantrader 擷取的 slides_MMDD 簡報圖逐張檢視後，整理成摘要並寫入 Obsidian vault（0000_2026大盤.md 的日期區塊＋個股/貴金屬等筆記檔的圖片）。只要使用者提到「整理 slides_XXXX」、「把簡報寫進 vault / Obsidian / 大盤」、「我是金錢爆 / 速效錠 摘要」、「slides 摘要」、「個股檔插圖」，或給了 downloads/slides_* 資料夾要彙整，就務必使用本技能，即使沒明講 organize-slides-to-vault。
---

# 整理 slides_* 並寫入 Obsidian vault

把 `downloadScantrader/downloads/slides_MMDD/` 的投影片圖，經人工/AI 逐張檢視後，寫成分段摘要放進 vault 的大盤日誌，並把相關圖片插到對應個股檔。腳本是 `downloadScantrader/organize-slides-to-vault.js`，它冪等（以 `<!-- slides-organizer:日期 -->` 標記取代既有區塊），所以計畫可以反覆修改、重跑。

核心分工：**腳本負責寫檔，你負責看圖並寫出計畫 JSON**。摘要品質全取決於逐張看圖，不要只靠檔名或 OCR 猜。

## 流程

1. **確認輸入**：slides 資料夾（如 `downloads/slides_1002`）、對應日期 `YYYY.MMDD`（大盤.md 裡的 `# YYYY.MMDD` 標題）、vault 路徑（`--vault` 或環境變數 `SCANTRADER_VAULT_PATH`；缺就問使用者，不要寫死）。
2. **產生計畫骨架**（在專案根目錄）：
   ```
   node .\downloadScantrader\organize-slides-to-vault.js --init .\downloadScantrader\downloads\slides_MMDD --date YYYY.MMDD
   ```
   輸出 `downloadScantrader/plans/slides_MMDD.json`；已存在不會覆寫。
3. **用 Read 逐張看圖**（圖片可直接讀）。依講者/單元切成 `sections`，並記下哪些圖是個股 K 線、法人報表、貴金屬等。可參考 `plans/slides_1002.json` 當範例。
4. **編輯計畫 JSON**：
   - `sections[]`：`{ title: "講者（職稱）：主題", images[], bullets[] }`。bullets 寫講者風格、關鍵數字、個股範例（開高低收、量、均線、前高等圖上可見的資訊）。
   - `stockEntries[]`：`{ code: "4位數", tag: "#講者(職稱)", images[] }`，圖片會插到該個股檔最前面。
   - `noteEntries[]`：非個股檔（如 `0000貴金屬.md`）的同類插入。
   - `source`：摘要來源（必填，見下）。
   - bullets 內提到有個股檔的股票，一律寫 `[[@6488|環球晶]]`；執行時會轉成 `[[6488環球晶|環球晶]]`，找不到個股檔則退回純文字並註明「尚無個股檔」。
5. **先 dry-run 預覽**，確認無誤再正式寫入：
   ```
   node .\downloadScantrader\organize-slides-to-vault.js .\downloadScantrader\plans\slides_MMDD.json --dry-run
   node .\downloadScantrader\organize-slides-to-vault.js .\downloadScantrader\plans\slides_MMDD.json
   ```
6. **回報**：寫入了哪些檔、幾張圖、哪些股票因無個股檔而退回純文字、有哪些單元因圖片缺漏而未摘要。

## 寫入規範（使用者的固定要求）

- **wikilink**：大盤日誌裡提到有個股檔的股票必須是 wikilink，讓大盤與個股筆記互相連結。
- **不備份**：vault 不產生 `.bak-*`（使用者視為雜訊）；腳本預設即不備份，不要加 `--backup`。仍採暫存檔＋原子 rename。
- **摘要來源**：每個日期區塊末尾必須寫明「摘要來源」：節目名稱、日期、單元、依 slides_MMDD 共幾張畫面逐張檢視整理、非逐字稿；若某單元沒有畫面也要寫明。這是讓日後讀者知道內容可信度與限制，所以不能省。
- **使用者可能同時在 Obsidian 編輯**：正式寫入前確認區塊現況，別覆蓋他們手改的內容；腳本只取代自己標記的區塊。
- 日期在大盤.md 找不到或對到多筆時，腳本會在任何寫入前中止；把它列出的可用日期回報給使用者，不要自行改日期硬寫。
- vault 位於 repo 之外、不受 git 版控，所以務必先 dry-run。

## 注意

- 圖片檔名必須真的存在於 slides 資料夾，否則腳本驗證失敗；改計畫而不是改圖。
- 只寫圖上看得到的事實，看不清楚的數字寧可省略，不要推測補齊。
- 若修改腳本或其 CLI 用法，依專案規範同步更新 `downloadScantrader/README.md`。
