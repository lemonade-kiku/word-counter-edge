@echo off
chcp 65001 >nul
title Claude 论文审查桥接服务 (localhost:8899)
cd /d "%~dp0"
echo ============================================================
echo   Claude 论文审查桥接服务
echo   地址: http://127.0.0.1:8899
echo   保持本窗口开启，然后去浏览器选中文字，点悬浮窗上的"论文审查"
echo   第一次运行需要等待 Claude Code 输出（约 30~90 秒）
echo   按 Ctrl+C 退出
echo ============================================================
node bridge.js
echo.
echo 服务已退出。按任意键关闭窗口...
pause >nul
