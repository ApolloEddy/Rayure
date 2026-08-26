@echo off
chcp 65001 > nul
title 茜特拉莉 2.5D Live 实时交互演示系统
echo 正在启动茜特拉莉 2.5D Live 演示服务...
cd /d "%~dp0"
python start_demo.py
pause
