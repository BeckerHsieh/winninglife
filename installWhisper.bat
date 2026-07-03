@echo off
setlocal

echo [1/3] 檢查 Python...
python --version >nul 2>&1
if errorlevel 1 (
  echo 找不到 Python，嘗試使用 winget 安裝 Python 3.12...
  winget --version >nul 2>&1
  if errorlevel 1 (
    echo 找不到 winget，請先手動安裝 Python 3.10+ 並勾選 Add to PATH
    exit /b 1
  )
  winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo winget 安裝 Python 失敗，請手動安裝後重試
    exit /b 1
  )

  echo 重新檢查 Python...
  python --version >nul 2>&1
  if errorlevel 1 (
    echo Python 仍不可用，請重新開啟終端機後再執行一次 installWhisper.bat
    exit /b 1
  )
)

echo [2/3] 安裝/升級 pip...
python -m pip install --upgrade pip
if errorlevel 1 exit /b 1

echo [3/3] 安裝 Whisper 與 ffmpeg-python 相依...
python -m pip install -U openai-whisper
if errorlevel 1 exit /b 1

echo 完成：請重新執行 runDownload.bat
exit /b 0
