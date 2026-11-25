@echo off
rem Starts MCNetwork. Needs Node.js 22 or newer. The data (servers, settings) lives in the "data" folder next to this file.
cd /d "%~dp0"
node mcnetwork.js --data "%~dp0data" %*
if errorlevel 1 pause
