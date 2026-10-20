@echo off
chcp 65001 >nul
rem web-rpa 를 실행한다. 이 창을 닫으면 서버도 멈춘다.
title web-rpa (http://127.0.0.1:4800)
cd /d "%~dp0"
if not exist node_modules (
  echo 처음 실행: 의존성을 설치합니다...
  call pnpm install || call npm install
)
start "" http://127.0.0.1:4800
node src\server.js --port 4800
pause
