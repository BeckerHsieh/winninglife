@echo off
setlocal enabledelayedexpansion

if "%~1"=="" (
	echo Usage: ytDownloadYT.bat ^<youtube-url^>
	echo Example: ytDownloadYT.bat https://www.youtube.com/watch?v=7vIh-Il7ciU
	exit /b 1
)

set "URL=%~1"
set SLIDE_MAX_FRAMES=600

set "VIDEO_ID="
for /f "tokens=2 delims==" %%A in ("%URL%") do set "VIDEO_ID=%%A"
if defined VIDEO_ID (
	for /f "tokens=1 delims=&" %%A in ("!VIDEO_ID!") do set "VIDEO_ID=%%A"
	if defined VIDEO_ID set "URL=https://youtu.be/!VIDEO_ID!"
)

node ./downloadScantrader/yt-private-download.js --cookies-file .\downloadScantrader\.session\yt-cookies.txt "!URL!"