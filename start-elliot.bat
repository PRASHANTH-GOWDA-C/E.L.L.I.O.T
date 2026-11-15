@echo off
rem ======================================================================
rem  start-elliot.bat - double-click to start Elliot.
rem
rem  Works from any drive letter or folder:
rem    pendrive  X:\start-elliot.bat  +  X:\elliot\app, models, runtime ...
rem    repo/SSD  D:\E.L.L.I.O.T\start-elliot.bat  +  app, bin ...
rem
rem  Steps: find Elliot, set Ollama options, start Ollama if needed, wait
rem  for it, warm up the coder model, open a terminal with `elliot` ready.
rem  Uses goto instead of ( ) blocks so paths like "Program Files (x86)"
rem  can't break the script.
rem ======================================================================
setlocal EnableExtensions
title E.L.L.I.O.T
cd /d "%~dp0"

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

rem ---- 1. Where is Elliot? (pendrive layout first, then repo layout) ----
set "ELLIOT_HOME="
if exist "%HERE%\elliot\app\cli\index.js" set "ELLIOT_HOME=%HERE%\elliot"
if not defined ELLIOT_HOME if exist "%HERE%\app\cli\index.js" set "ELLIOT_HOME=%HERE%"
if defined ELLIOT_HOME goto :found_elliot
echo [Elliot] Cannot find Elliot's app folder next to this script:
echo          %HERE%
goto :fail
:found_elliot

rem ---- 2. Ollama options ----
rem Models on the pendrive (X:\elliot\models) are used only if that folder
rem exists; otherwise Ollama keeps its default folder (repo on the SSD).
if exist "%HERE%\elliot\models\" set "OLLAMA_MODELS=%HERE%\elliot\models"
set "OLLAMA_KEEP_ALIVE=-1"
set "OLLAMA_MAX_LOADED_MODELS=3"

rem ---- 3. Node.js and the elliot command on PATH (this session only) ----
if exist "%ELLIOT_HOME%\runtime\node\node.exe" set "PATH=%ELLIOT_HOME%\runtime\node;%PATH%"
set "PATH=%ELLIOT_HOME%\bin;%PATH%"
where node >nul 2>nul
if not errorlevel 1 goto :have_node
echo [Elliot] Node.js was not found. Install Node.js 22+ from https://nodejs.org
echo          or put a portable copy in %ELLIOT_HOME%\runtime\node
goto :fail
:have_node

rem ---- 4. Find Ollama (portable copy first, then the installed one) ----
set "OLLAMA_EXE="
if exist "%ELLIOT_HOME%\runtime\ollama\ollama.exe" set "OLLAMA_EXE=%ELLIOT_HOME%\runtime\ollama\ollama.exe"
if defined OLLAMA_EXE goto :have_ollama_exe
for /f "delims=" %%i in ('where ollama 2^>nul') do if not defined OLLAMA_EXE set "OLLAMA_EXE=%%i"
:have_ollama_exe

rem ---- 5. Start Ollama unless it is already running ----
call :ollama_up
if not errorlevel 1 goto :ollama_was_running
tasklist /FI "IMAGENAME eq ollama.exe" 2>nul | find /I "ollama.exe" >nul
if not errorlevel 1 goto :wait_for_ollama
if defined OLLAMA_EXE goto :start_ollama
echo [Elliot] Ollama is not installed.
echo          Download it from https://ollama.com/download
echo          or put a portable copy in %ELLIOT_HOME%\runtime\ollama
goto :fail

:start_ollama
echo [Elliot] Starting Ollama ...
start "Ollama" /min "%OLLAMA_EXE%" serve
goto :wait_for_ollama

:ollama_was_running
echo [Elliot] Ollama is already running.
if defined OLLAMA_MODELS echo [Elliot] Note: it keeps its own models folder. To use %OLLAMA_MODELS%, quit Ollama from the tray and run this again.
goto :ollama_ready

rem ---- 6. Wait until http://127.0.0.1:11434 answers (max 60 s) ----
:wait_for_ollama
echo [Elliot] Waiting for Ollama ...
set /a WAITED=0
:wait_loop
call :ollama_up
if not errorlevel 1 goto :ollama_ready
if %WAITED% GEQ 60 goto :ollama_timeout
rem ping as a 1-second sleep: unlike "timeout" it works without a console input
ping -n 2 127.0.0.1 >nul
set /a WAITED+=1
goto :wait_loop

:ollama_timeout
echo [Elliot] Ollama did not answer at http://127.0.0.1:11434 within 60 seconds.
echo          Try running "ollama serve" in a terminal to see the error.
goto :fail

:ollama_ready
echo [Elliot] Ollama is ready.

rem ---- 7. Warm up the coder model in the background ----
start "Elliot warm-up" /min node "%ELLIOT_HOME%\scripts\warmup.js"

rem ---- 8. Open a terminal in the home folder with `elliot` ready ----
start "Elliot" /d "%USERPROFILE%" cmd /k "echo. & echo   E.L.L.I.O.T is ready - type: elliot & echo   (the coder model is loading in the background) & echo."
echo [Elliot] Elliot is ready - type: elliot
ping -n 4 127.0.0.1 >nul
endlocal
exit /b 0

:fail
echo.
pause
endlocal
exit /b 1

rem ---- helper: errorlevel 0 if Ollama answers on its HTTP port ----
:ollama_up
curl.exe -s -o nul -m 2 http://127.0.0.1:11434/api/version >nul 2>nul
exit /b %errorlevel%
