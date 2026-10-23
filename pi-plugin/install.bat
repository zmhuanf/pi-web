@echo off
setlocal

set "SRC=%~dp0"
set "PI_DIR=%USERPROFILE%\.pi"

echo Installing pi-plugin files to %PI_DIR%
echo.

if not exist "%PI_DIR%\agent\extensions" mkdir "%PI_DIR%\agent\extensions"

echo [1/5] SYSTEM.md -^> %PI_DIR%\agent
set "SYSTEM_TARGET=%PI_DIR%\agent\SYSTEM.md"
if not exist "%SYSTEM_TARGET%" (
    copy /Y "%SRC%SYSTEM.md" "%SYSTEM_TARGET%" >nul
    echo   installed
) else (
    fc /b "%SRC%SYSTEM.md" "%SYSTEM_TARGET%" >nul 2>nul
    if errorlevel 1 (
        copy /Y "%SYSTEM_TARGET%" "%SYSTEM_TARGET%.bak" >nul
        copy /Y "%SRC%SYSTEM.md" "%SYSTEM_TARGET%" >nul
        echo   replaced, previous version kept at SYSTEM.md.bak
    ) else (
        echo   unchanged
    )
)
echo.

echo [2/5] APPEND_SYSTEM.md -^> %PI_DIR%\agent
copy /Y "%SRC%APPEND_SYSTEM.md" "%PI_DIR%\agent\APPEND_SYSTEM.md"
echo.

echo [3/5] ssh.ts -^> %PI_DIR%\agent\extensions
copy /Y "%SRC%ssh.ts" "%PI_DIR%\agent\extensions\ssh.ts"
echo.

echo [4/5] pi-tracker -^> %PI_DIR%\agent\extensions\pi-tracker
xcopy /Y /E /I "%SRC%pi-tracker" "%PI_DIR%\agent\extensions\pi-tracker"
echo.

echo [5/5] web-search.json -^> %PI_DIR%
copy /Y "%SRC%web-search.json" "%PI_DIR%\web-search.json"
echo.

echo Done.
pause
