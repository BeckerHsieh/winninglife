@REM 讀取 .env 取得 API Key 和目錄設定
@REM 備份 ~\.copilot\ 下現有的設定
@REM 複製 copilot-instructions.md 和 settings.json 到 ~\.copilot\
@REM 從 template 產生 mcp-config.json（填入 API Key 和目錄）
PowerShell -ExecutionPolicy Bypass -File "d:\DOC\Winstock\winninglife\copilot-settings-pkg\import.ps1"
pause