# MCP 工具清單：讓 Copilot CLI 不只聊天，還能幫你做事

> ⭐ 初學者友善｜每個工具 3-5 分鐘｜Windows（macOS/Linux 見底部說明）

## 什麼是 MCP？

MCP（Model Context Protocol）是讓 AI 連接外部工具的標準協議。裝了 MCP，Copilot CLI 就能幫你讀網頁、存取更多資料夾、操作瀏覽器、串接 Google 服務。不再只是聊天，而是真的幫你做事。

## 你可能遇過這個問題

用 Copilot CLI 覺得很厲害，但它只能讀寫你啟動時所在的專案目錄。想讓它幫你：

- 「幫我看今天有什麼信」→ 它說：我沒有 Gmail 權限
- 「幫我查這個網頁的內容」→ 它說：我無法瀏覽網頁
- 「幫我操作瀏覽器填個表單」→ 它說：我沒有瀏覽器控制能力
- 「幫我讀桌面那個 PDF」→ 它說：我只能讀專案目錄的檔案

裝 MCP 就是解決這些問題。每個 MCP 工具讓 AI 多一個能力。

## 推薦工具清單

以下工具依「對新手的實用程度」排序。不用全裝，挑你需要的就好。

### 1. 🔍 Firecrawl — 讓 AI 能讀懂任何網頁

**你會用到的場景：**
- 「幫我摘要這篇文章」貼一個網址，AI 就能讀
- 「幫我比較這三個產品的功能」AI 自己去抓網頁資料
- 「把這個網頁的表格整理成 CSV」

**使用心得：**
用它抓新聞、研究工具、整理競品資料非常方便。比起叫 AI 用瀏覽器慢慢爬，Firecrawl 直接把網頁轉成乾淨的文字，速度快很多。免費方案每月 500 次，個人使用絕對夠。

### 2. 📁 Filesystem — 讓 AI 讀寫專案目錄以外的檔案

**你會用到的場景：**
- 「幫我讀桌面那個 Excel 檔」
- 「把這份報告存到我的 Documents 資料夾」
- 「整理我 Downloads 裡面的檔案」

**使用心得：**
Copilot CLI 預設只能讀寫你啟動時所在的那個專案目錄。裝了 Filesystem MCP，你可以指定讓它存取其他資料夾（例如桌面、下載、文件），但只限你授權的路徑，不會亂碰其他東西。

### 3. 🌐 Playwright — 讓 AI 能操作瀏覽器

**你會用到的場景：**
- 「幫我登入這個網站截個圖」
- 「幫我填這個表單」
- 「幫我抓這個需要登入才能看的頁面」
- 抓社群媒體內容（Facebook、Instagram、Threads 等需要登入的平台）

**使用心得：**
Firecrawl 能處理 80% 的網頁抓取需求，但遇到需要登入、需要滾動載入、或需要點擊互動的網頁，就需要 Playwright。它就像給 AI 一個真正的瀏覽器，可以像人一樣操作網頁。主要用於抓社群媒體內容和做網頁截圖。

> ⚠️ **注意**：Copilot CLI 預設已內建 Playwright MCP，不一定需要額外安裝。如果 `/mcp` 清單裡已有 playwright，可以跳過工具 3。

### 4. 🔗 Google Workspace — 讓 AI 串接 Gmail、行事曆、雲端硬碟

**你會用到的場景：**
- 「幫我看今天有什麼未讀信」
- 「幫我建一個明天下午 2 點的會議」
- 「幫我把這份文件上傳到 Google Drive」
- 「幫我讀那個 Google Sheets」

**使用心得：**
這是 Google 工程師主導的開源專案，一次 OAuth 登入就能串接 Gmail、Calendar、Drive、Sheets 等多個 Google 服務。設定較複雜（約 15 分鐘），如果你重度依賴 Google 生態系值得裝起來試試；如果只是偶爾用，可以先跳過。

## 怎麼裝？

把這份文件丟給 Copilot CLI，跟它說：

> 照這份文件幫我安裝 MCP 工具

AI 會讀完這份文件，列出選項讓你選，然後幫你一步步安裝。

---

<!-- 以下是給 Copilot CLI 讀的安裝指令 -->

## AI 執行指引

> **🤖 AI 互動規範（給 Copilot CLI 的指引）**
>
> 執行此設定檔時，請遵守以下原則：
>
> 1. **需要個人化資訊時，用 `ask_user` 工具跳出互動框**：不要猜測用戶的路徑、偏好、或選擇。例如：要安裝哪些工具、API Key、要授權哪些資料夾。
> 2. **偵測到既有配置時，先確認再行動**：如果發現 `~/.copilot/mcp-config.json` 已存在且有相關設定，用 `ask_user` 說明現狀，讓用戶決定要覆蓋、跳過、還是合併。
> 3. **安裝完成後，用白話文條列總結**：列出你做了什麼、改了哪些檔案、怎麼驗證成功。讓非工程師用戶也能看懂、放心。

> **給 Copilot CLI 的總覽**：這份文件要你幫用戶安裝 MCP 工具。請先介紹每個工具（用 1-2 句話說明用途），然後用 `ask_user` 問用戶想裝哪些，不要自動全部安裝。完成後請按 Section 順序執行。全程用繁體中文跟用戶互動，語氣親切。

---

## MCP 設定格式說明

Copilot CLI 的 MCP 設定存放在：

```
%USERPROFILE%\.copilot\mcp-config.json
```

JSON 格式如下：

```json
{
  "mcpServers": {
    "工具名稱": {
      "command": "執行指令",
      "args": ["參數1", "參數2"],
      "env": {
        "環境變數名": "值"
      }
    }
  }
}
```

**兩種安裝方式：**
1. **互動式**：在 Copilot CLI 中輸入 `/mcp add`，按 Tab 填寫欄位，按 `Ctrl+S` 儲存
2. **直接編輯 JSON**：手動或由 AI 幫你修改 `mcp-config.json`（推薦，可一次設定多個工具）

---

### 工具 1：Firecrawl 安裝

**前置條件：** 需要 Firecrawl API Key（免費方案每月 500 次）

1. 到 https://www.firecrawl.dev/ 免費註冊，取得 API Key
2. 使用 `ask_user` 取得 API Key
3. 在 `mcp-config.json` 的 `mcpServers` 加入：

```json
"firecrawl": {
  "command": "npx",
  "args": ["-y", "firecrawl-mcp"],
  "env": {
    "FIRECRAWL_API_KEY": "你的API_KEY"
  }
}
```

**驗證：** 重新開啟 Copilot CLI，說「幫我摘要這篇文章：https://github.com/microsoft/playwright 」，能回傳內容摘要即成功。

---

### 工具 2：Filesystem 安裝

**前置條件：** 無（使用 npx 直接執行）

用 `ask_user` 詢問用戶要授權哪些資料夾（建議：桌面、文件、下載），然後在 `mcp-config.json` 加入：

```json
"filesystem": {
  "command": "npx",
  "args": [
    "-y",
    "@modelcontextprotocol/server-filesystem",
    "C:\\Users\\USERNAME\\Desktop",
    "C:\\Users\\USERNAME\\Documents",
    "C:\\Users\\USERNAME\\Downloads"
  ]
}
```

> 請將 `USERNAME` 替換為用戶的實際使用者名稱（執行 `$env:USERNAME` 查詢）。
> 用戶可以自行增減路徑來控制 AI 能存取的資料夾範圍。

**驗證：** 重新開啟 Copilot CLI，說「幫我列出桌面上有什麼檔案」。

---

### 工具 3：Playwright 安裝

**前置條件：** 需要先安裝 Playwright 瀏覽器

> ⚠️ 先用 `/mcp` 確認 Copilot CLI 是否已內建 Playwright。若已有，可跳過此工具。

```powershell
# 安裝 Chromium 瀏覽器（Windows PowerShell）
npx playwright install chromium
```

在 `mcp-config.json` 加入：

```json
"playwright": {
  "command": "npx",
  "args": ["-y", "@playwright/mcp"]
}
```

**驗證：** 重新開啟 Copilot CLI，說「幫我用瀏覽器打開 https://github.com 並截圖」。

---

### 工具 4：Google Workspace 安裝

**前置條件：** 需要 Google Cloud Project + OAuth 設定（較複雜，約 15 分鐘）

> ⚠️ **開始前必讀（避免帳號異常）**
>
> 這段是 OAuth 流程，請注意以下事項：
>
> 1. **建議用平常有在使用的 Google 帳號**，而非全新帳號。新帳號 + 第一次碰 GCP + OAuth 失敗重試，容易被 Google 反詐欺機制判定異常。
> 2. **OAuth 失敗時，先停下來看錯誤訊息，不要連續重試**。多半是「沒把自己加進 Test users」或「scope 選太多」，先排查再重跑。

#### Step 1：安裝 gws CLI

```powershell
# Windows（需要 Node.js）
npm install -g @googleworkspace/cli
```

#### Step 2：建立 Google Cloud Project + OAuth Client（手動操作）

1. **建專案**：到 https://console.cloud.google.com/ → 建立新專案
2. **啟用 API**：Gmail API、Google Calendar API、Google Drive API、Google Sheets API
3. **設定 OAuth consent screen**（左側選單 → APIs & Services → OAuth consent screen）：
   - User Type 選 **External**（testing 模式即可）
   - **⚠️ 一定要在「Test users」加入你自己的 Google 帳號 email**
4. **建 OAuth 2.0 Client ID**（APIs & Services → Credentials → Create credentials → OAuth client ID）：
   - 類型選 **Desktop app**
5. **下載 JSON 憑證檔**，建立設定目錄並放入：

```powershell
New-Item -Path "$HOME\.config\gws" -ItemType Directory -Force
# 把下載的 client_secret_*.json 改名後移到這裡
Rename-Item "$HOME\Downloads\client_secret_*.json" "client_secret.json"
Move-Item "$HOME\Downloads\client_secret.json" "$HOME\.config\gws\client_secret.json"
```

#### Step 3：登入（限縮 scope，很重要）

> ⚠️ **不要用 `gws auth login` 不帶參數**，預設 scope 太多，`@gmail.com` 帳號會失敗。
> 用 `-s` 參數指定你實際會用到的服務：

```powershell
# 最常見組合（信箱 + 行事曆 + 雲端硬碟 + 試算表）
gws auth login -s gmail,calendar,drive,sheets
```

依序完成瀏覽器 OAuth 流程後，驗證：

```powershell
gws auth status        # 看到 auth_method: oauth2 即成功
gws drive files list --params '{"pageSize":3}'
```

#### Step 4：加入 Copilot CLI MCP 設定

在 `mcp-config.json` 加入：

```json
"google-workspace": {
  "command": "gws",
  "args": ["mcp", "serve"],
  "env": {}
}
```

**最終驗證：** 重新開啟 Copilot CLI，說「幫我看今天的行事曆」。

> ⚠️ gws-cli 目前是 pre-v1.0（2026 年初推出），更新頻繁，可能偶爾遇到 breaking changes。

---

### 安裝完成後

請告訴用戶：
1. **每次新增 MCP 後都需要重新開啟 Copilot CLI** 才會生效
2. 可以用 `/mcp` 指令查看目前已安裝的 MCP 工具清單
3. 未來想加更多工具，可以直接編輯 `%USERPROFILE%\.copilot\mcp-config.json`

---

## 踩坑紀錄

- **為什麼 Copilot CLI 用 mcp-config.json 而不是 claude mcp add 指令？** Claude Code 有 `claude mcp add` 這個 CLI 指令，Copilot CLI 則是用 `/mcp add` 互動指令或直接編輯 `~/.copilot/mcp-config.json`，兩者格式相似但管理方式不同。
- **Playwright 可能已內建**：Copilot CLI 預設已有 GitHub MCP Server，部分版本也預設包含 Playwright。先用 `/mcp` 確認現有清單再決定是否安裝。
- **Filesystem 路徑 Windows 格式**：JSON 中的 Windows 路徑反斜線需要跳脫，寫成 `C:\\Users\\poyen\\Desktop`，或用正斜線 `C:/Users/poyen/Desktop` 也可以。
- **Google Workspace scope 限制**：`@gmail.com` 個人帳號在 testing 模式下，每次 OAuth 最多授權約 25 個 scope。不要用官方的 recommended preset（包含 85+ scope），用 `-s` 指定需要的服務即可。

### 常見問題

**Q：裝了以後 `/mcp` 沒看到工具？**
確認 `mcp-config.json` 的 JSON 格式正確（括號、逗號不要少）。重新開啟 Copilot CLI 再試。

**Q：macOS / Linux 怎麼辦？**
安裝 Playwright 改用：`npx playwright install chromium`（macOS/Linux 相同）。Filesystem 路徑改為 Unix 格式：`/Users/USERNAME/Desktop`。其他設定完全一樣。

**Q：想移除某個 MCP 工具？**
直接刪除 `mcp-config.json` 中對應的區塊，重新開啟 Copilot CLI 即生效。

**Q：mcp-config.json 在哪裡？**
預設位置：`%USERPROFILE%\.copilot\mcp-config.json`（Windows）或 `~/.copilot/mcp-config.json`（macOS/Linux）。也可以透過 `COPILOT_HOME` 環境變數改變路徑。

---

> 📖 更多 Copilot CLI 說明 → [GitHub Copilot 官方文件](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview)
