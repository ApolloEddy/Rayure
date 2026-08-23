#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# 安装 ARDY(editable)。pybind11 用 pip 版 2.11.1(apt 版 2.9.2 与 Py3.12 不兼容),
# 通过 CMAKE_PREFIX_PATH 让 CMake 找到 pip 版 cmake config,跳过 GitHub FetchContent。
set -euo pipefail

cd /root/autodl-tmp/rayure-autodl
export CMAKE_PREFIX_PATH=/root/miniconda3/lib/python3.12/site-packages/pybind11/share/cmake/pybind11
echo "cwd: $(pwd)"
ls pyproject.toml setup.py
python3 -m pip install -e . --index-url https://pypi.tuna.tsinghua.edu.cn/simple
