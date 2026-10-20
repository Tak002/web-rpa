@echo off
chcp 65001 >nul
rem 화면(브라우저)을 열지 않고 서버만 실행한다. 작업 스케줄러 등으로 로그인한 사용자 세션에서 띄울 때 쓴다. 이 창을 닫으면 서버가 멈춘다.
title web-rpa (port 4800)
cd /d "%~dp0"
node src\server.js --port 4800
