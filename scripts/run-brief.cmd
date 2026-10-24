@echo off
setlocal
rem Daily weather brief launcher. ASCII only: cmd.exe parses this file in the
rem system code page, so non-ASCII comments can corrupt the batch.
rem Usage: run-brief.cmd [--json] [--webhook] [--config <path>]

set "NODE=C:\Users\daniel\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" (
  echo [brief] node not found: %NODE% 1>&2
  exit /b 1
)

"%NODE%" "%~dp0brief.js" %*
