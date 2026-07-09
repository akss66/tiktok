@echo off
setlocal
set "NODE_EMBEDDED=%~dp0.tools\node-v22.23.1-win-x64\node.exe"
set "NODE_EXE=node.exe"

if exist "%NODE_EMBEDDED%" (
  set "NODE_EXE=%NODE_EMBEDDED%"
) else (
  where node >nul 2>nul || (
    echo [err] 找不到 node.exe，请先安装 Node.js 或在同目录放置 .tools\node-v22.23.1-win-x64\node.exe
    exit /b 1
  )
)

"%NODE_EXE%" "%~dp0server.js" %*
