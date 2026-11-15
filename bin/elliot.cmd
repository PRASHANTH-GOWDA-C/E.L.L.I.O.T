@echo off
rem Runs Elliot from this folder (used when bin\ is on PATH, e.g. from start-elliot.bat).
node "%~dp0..\app\cli\index.js" %*
