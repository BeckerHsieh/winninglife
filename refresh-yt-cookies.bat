@echo off
setlocal
set COOKIES_PATH=%~dp0downloadScantrader\.session\yt-cookies.txt

echo.
echo =====================================================
echo  YouTube Cookies 更新步驟
echo =====================================================
echo.
echo  [重要] yt-dlp 每次執行後會更新 cookies 檔案，
echo         可能導致 session 過期。請定期重新匯出。
echo.
echo  1. 在 Chrome 安裝擴充套件（只需第一次）：
echo     https://chromewebstore.google.com/detail/cclelndahbckbenkjhflpdbgdldlbecc
echo     名稱：Get cookies.txt LOCALLY
echo.
echo  2. 開啟 Chrome，登入 YouTube，前往 https://www.youtube.com
echo.
echo  3. 點擊擴充套件圖示 → 確認下拉選「youtube.com」→ 點「Export」→
echo     另存新檔至以下路徑（覆蓋舊檔）：
echo.
echo     %COOKIES_PATH%
echo.
echo  4. 完成後回到這裡按任意鍵繼續驗證...
echo.
pause

if not exist "%COOKIES_PATH%" (
  echo [錯誤] 找不到 cookies 檔案，請確認已儲存至上述路徑。
  pause
  exit /b 1
)

echo.
echo [驗證] 正在驗證 cookies...
yt-dlp --cookies "%COOKIES_PATH%" --flat-playlist --playlist-items 1 --print title "https://www.youtube.com/watch?v=dQw4w9WgXcQ" 2>nul
if %ERRORLEVEL%==0 (
  echo [成功] Cookies 有效！
) else (
  echo [警告] 驗證失敗，可能是 cookies 格式不對或已過期，請重新匯出。
)
echo.
pause
yt-dlp --cookies-from-browser chrome --cookies .\downloadScantrader\.session\yt-cookies.txt -o NUL --flat-playlist --playlist-items 1 "https://www.youtube.com/" 2>&1
if %ERRORLEVEL%==0 (
  echo [Cookie] Cookies saved to .\downloadScantrader\.session\yt-cookies.txt
) else (
  echo [Cookie] Failed. Make sure Chrome is fully closed and you are logged into YouTube in Chrome.
)
pause