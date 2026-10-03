# mc-automation

以 pywinauto 模擬使用者操作 MultiCharts 的 GUI 自動化腳本。
只做「開啟」動作，不會修改或儲存 `.wsp` 與 `mc/` 目錄下的語法檔。

## 安裝

```powershell
pip install -r .\mc-automation\requirements.txt
```

## open_workspace.py — 開啟工作區

```powershell
# 預設開啟 C:\Users\MC12\Desktop\康和MultiCharts12\MC_wsp\IRF.wsp
python .\mc-automation\open_workspace.py

# 指定工作區並截圖
python .\mc-automation\open_workspace.py --wsp "C:\Users\MC12\Desktop\康和MultiCharts12\MC_wsp\TXF.wsp" --screenshot .\irf.png

# 開啟 IRF 後套入訊號 0_NO6_MACD_STOCK（已套用則略過）
python .\mc-automation\open_workspace.py --signal 0_NO6_MACD_STOCK

# 指定 MultiCharts 執行檔（或設定環境變數 MC_EXE）
python .\mc-automation\open_workspace.py --exe "C:\...\MultiCharts64.exe" --timeout 120
```

| 參數 | 說明 | 預設 |
|---|---|---|
| `--wsp` | 工作區檔案路徑 | IRF.wsp |
| `--exe` | MultiCharts64.exe 路徑 | 環境變數 `MC_EXE`，否則用開始選單捷徑 |
| `--timeout` | 等待 MultiCharts 啟動秒數 | 90 |
| `--load-timeout` | 等待工作區載入秒數 | 60 |
| `--screenshot` | 完成後主視窗截圖路徑 | 不截圖 |
| `--force` | 工作區已開啟時仍重新開檔 | 關閉 |
| `--signal` | 開啟後套入目前圖表的訊號名稱 | 不套用 |

流程：attach 執行中的 MultiCharts（未啟動則自動啟動；以 `*MultiCharts64.exe` 比對，涵蓋康和版 `Concord MultiCharts64.exe`；最小化時自動還原）→ 若標題已含工作區名稱則略過（MultiCharts 啟動時會自動還原上次工作區）→ 焦點移到圖表後送 `Ctrl+O`，未開出對話框則改點選單「檔案 → 開啟工作底稿」→ 在開檔對話框填入路徑 → 等待標題出現工作區名稱 →（`--signal`）讀取「設定 → 訊號」確認未套用後，以「新增 → 訊號」選取並套入，再驗證已出現在「設定物件」清單。

- `--signal` 需要訊號已在 PowerLanguage Editor 匯入並編譯（`mc/*.pla` 只是原始碼，腳本不會匯入或編譯）。
- 套入只做回測顯示，不會開啟「自動交易」。

## add_symbol.py — 新增商品並建立工作底稿

```powershell
# 新增 OWF：QuoteManager 加入 OWF1，並建立 MC_wsp\OWF.wsp（OWF1 圖表、蠟燭線）
python .\mc-automation\add_symbol.py OWF

# 不帶參數則互動輸入商品代號（亦可雙擊根目錄的 runAddSymbol.bat）
python .\mc-automation\add_symbol.py

# 工作底稿已存在時重建並覆寫；或只建工作底稿、略過 QuoteManager
python .\mc-automation\add_symbol.py OWF --force
python .\mc-automation\add_symbol.py OWF --skip-qm --screenshot .\owf.png
```

| 參數 | 說明 | 預設 |
|---|---|---|
| `symbol` | 商品代號（例如 `OWF`，連續月1 即 `OWF1`） | 互動輸入 |
| `--wsp-dir` | 工作底稿存放資料夾 | `C:\Users\MC12\Desktop\康和MultiCharts12\MC_wsp` |
| `--exe` | MultiCharts64.exe 路徑 | 環境變數 `MC_EXE`，否則用開始選單捷徑 |
| `--timeout` | 等待程式啟動 / 搜尋結果秒數 | 90 |
| `--force` | 工作底稿已存在時仍重建並覆寫 | 關閉 |
| `--skip-qm` | 略過 QuoteManager 新增商品步驟 | 關閉 |
| `--screenshot` | 完成後 MultiCharts 主視窗截圖路徑 | 不截圖 |

流程：
1. QuoteManager（未啟動則透過捷徑啟動）：左側樹狀選「所有商品 → 期貨 → TAIFEX」，已有 `OWF1` 則略過新增；否則 商品(I) → 新增商品(A) → 從數據源取得 → Concord Futures64 → 「期貨」頁 → 商品源輸入 `OWF` → 搜尋 → 選 `OWF1` → 新增，完成後再回「期貨 → TAIFEX」確認 `OWF1` 存在。
2. MultiCharts：`MC_wsp\OWF.wsp` 已存在則略過（除非 `--force`）；否則 檔案 → 新增 → 工作底稿，再 檔案 → 新增 → 圖表視窗 → 設定商品（數據源 Concord Futures64、「期貨」頁選 `OWF1`、「樣式」頁圖表類型選「蠟燭線」）→ 確定 → 檔案 → 另存工作底稿 → `OWF.wsp`。

- 康和版 MultiCharts 最多同時開 10 個圖表視窗；達上限時腳本會回報訊息並關閉剛新增的空白工作底稿，請先關閉部分工作底稿後重跑。
- 圖表週期沿用 MultiCharts 預設（目前為 1 分鐘）。

注意：
- 執行期間請勿操作滑鼠鍵盤，且桌面不可鎖定（GUI 自動化需要前景視窗）。
- 若 MultiCharts 啟動時有登入視窗，請先手動登入。
- 腳本與 MultiCharts 需同權限執行（MultiCharts 若以系統管理員執行，腳本也要）。
- 本機 Python 安裝於 `C:\Users\MC12\AppData\Local\Programs\Python\Python312\python.exe`；若 `python` 指令無反應（指到 Microsoft Store 捷徑），請改用完整路徑或重開終端機讓 PATH 生效。
