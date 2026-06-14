# GitHub Copilot CLI 設定包

可在不同主機間移轉 Copilot CLI 設定的完整工具包。

## 目錄結構

```
copilot-settings-pkg/
├── export.ps1                        ← 從目前主機匯出設定
├── import.ps1                        ← 匯入設定至新主機
├── .env.example                      ← API Key 範本（可提交）
├── .env                              ← 實際 API Key（不可提交！）
└── settings/
    ├── mcp-config.template.json      ← MCP 設定範本（含佔位符）
    ├── copilot-instructions.md       ← 全域 AI 指令
    └── settings.json                 ← 允許的 URL 設定
```

## 匯出（在舊主機執行）

```powershell
cd copilot-settings-pkg
.\export.ps1
```

執行後會產生：
- `settings/` 中所有設定檔（路徑已參數化）
- `.env`（含實際 API Key，**請勿提交至 Git**）

## 匯入（在新主機執行）

### 步驟 1：複製設定包至新主機

### 步驟 2：建立 .env
```powershell
Copy-Item .env.example .env
notepad .env   # 填入實際 API Key 及目錄路徑
```

### 步驟 3：執行匯入
```powershell
.\import.ps1
```

### 步驟 4：驗證
在 Copilot CLI 中執行：
```
/env
/mcp
```

## 佔位符說明

| 佔位符 | 說明 |
|--------|------|
| `{{FIRECRAWL_API_KEY}}` | Firecrawl API Key |
| `{{FILESYSTEM_DIR_1}}` | Filesystem MCP 允許目錄 1 |
| `{{FILESYSTEM_DIR_2}}` | Filesystem MCP 允許目錄 2 |
| `{{FILESYSTEM_DIR_3}}` | Filesystem MCP 允許目錄 3 |

## 注意事項

- `.env` 包含敏感資訊，加入 `.gitignore` 避免提交
- 匯入時會自動備份舊設定至 `~/.copilot/backup_<timestamp>/`
- 匯入後需重新啟動 Copilot CLI 才會套用
