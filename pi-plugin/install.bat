@echo off
setlocal

set "SRC=%~dp0"
set "PI_DIR=%USERPROFILE%\.pi"

echo Installing pi-plugin files to %PI_DIR%
echo.

if not exist "%PI_DIR%\agent\extensions" mkdir "%PI_DIR%\agent\extensions"

echo [1/4] APPEND_SYSTEM.md -^> %PI_DIR%\agent
copy /Y "%SRC%APPEND_SYSTEM.md" "%PI_DIR%\agent\APPEND_SYSTEM.md"
echo.

echo [2/4] ssh.ts -^> %PI_DIR%\agent\extensions
copy /Y "%SRC%ssh.ts" "%PI_DIR%\agent\extensions\ssh.ts"
echo.

echo [3/4] pi-tracker -^> %PI_DIR%\agent\extensions\pi-tracker
xcopy /Y /E /I "%SRC%pi-tracker" "%PI_DIR%\agent\extensions\pi-tracker"
echo.

echo [4/4] web-search.json -^> %PI_DIR%
copy /Y "%SRC%web-search.json" "%PI_DIR%\web-search.json"
echo.

echo Done.
pause
