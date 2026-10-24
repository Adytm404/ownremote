@echo off
title OwnRemote
cd /d "%~dp0"
if not exist node_modules (
  echo Menginstall dependensi...
  call npm install --omit=dev
)
node cli.js %*
