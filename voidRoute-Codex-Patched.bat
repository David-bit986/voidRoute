@echo off
title voidRoute Codex Desktop (patched picker)
cd /d "%~dp0"
bun run tools/patch-codex-desktop.mjs --launch
pause
