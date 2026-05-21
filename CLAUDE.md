# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

联机五子棋 — C 语言大作业，混合语言架构：

- **C 层**：五子棋核心逻辑（棋盘状态、落子校验、五子连珠判定），编译为动态库 `.so` / `.dll`
- **Python 层**：WebSocket + HTTP 服务器，通过 `ctypes` 调用 C 动态库，使用 `mysql-connector-python` 连接远程 MySQL
- **前端层**：原生 HTML/CSS/JS，Canvas 绘制棋盘，WebSocket 通信

## Build & Run

```bash
# 1. 编译 C 动态库
cd c_core && make && cp libgobang.so ../python_server/

# 2. 安装 Python 依赖
cd python_server && pip install -r requirements.txt

# 3. 配置环境变量（复制模板并填写）
cp .env.example .env
# 编辑 .env: 填写远程 MySQL 地址、端口、用户名、密码、数据库名

# 4. 启动后端（HTTP + WebSocket，默认 8080 端口）
python server.py

# 5. 启动前端静态服务
cd ../public && python -m http.server 3000
# 打开浏览器访问 http://localhost:3000
```

## Project Structure

```
gobang/
├── c_core/               # C 核心逻辑
│   ├── gobang.h          # 接口头文件（board_init, place_piece, check_winner 等）
│   ├── gobang.c          # 实现（15×15 棋盘，全局数组，无指针）
│   └── Makefile          # 编译为 libgobang.so
├── python_server/        # Python 后端
│   ├── db.py             # 数据库连接（从环境变量读取参数）
│   ├── auth.py           # 注册/登录（bcrypt 密码哈希 + JWT）
│   ├── game_engine.py    # ctypes 封装 C 动态库（单例）
│   ├── server.py         # 主服务器（aiohttp HTTP + WebSocket）
│   ├── requirements.txt  # Python 依赖
│   └── .env.example      # 环境变量模板
├── public/               # 前端静态页面
│   ├── index.html
│   ├── style.css
│   └── client.js
├── CLAUDE.md
└── README.md
```

## Key Architecture

### C Core (`c_core/`)
- 纯 C 实现，零外部依赖
- 全局 `board[15][15]` 数组管理状态，无指针
- `place_piece(x, y, color)` 返回 1=成功 / 0=失败
- `check_winner()` 遍历四个方向（水平/垂直/正斜/反斜）检测五子连珠

### Python Server (`python_server/`)
- `server.py`：aiohttp 单进程同时提供 HTTP（注册/登录）和 WebSocket（对局）
- `game_engine.py`：单例模式封装 C 动态库调用
- `db.py`：mysql-connector-python 同步调用，通过 `run_in_executor` 避免阻塞事件循环
- `auth.py`：bcrypt 哈希密码，JWT 令牌（2 小时过期）

### 服务器内存状态
- `clients[ws]` — WebSocket 连接 → 用户名和房间 ID
- `rooms[room_id]` — 对局房间 → 两名玩家及其 WebSocket
- `waiting_queue[ws]` — 匹配队列（先到先得）

### WebSocket 协议
| 方向 | type | 说明 |
|------|------|------|
| C→S | `match` | 请求匹配 |
| C→S | `move` | 落子（附带 x, y） |
| S→C | `waiting` | 等待对手 |
| S→C | `start` | 对局开始（附带 color 1=黑/2=白） |
| S→C | `move` | 对手落子通知 |
| S→C | `turn` | 轮到谁走棋 |
| S→C | `game_over` | 游戏结束（附带 winner 描述） |
| S→C | `error` | 错误信息 |

### 断线处理
- WebSocket 断开 → 检查玩家是否在对局中
- 在对局中 → 对手直接获胜，销毁房间
- 在匹配队列 → 从队列移除

## Tests

```bash
# 测试 C 核心逻辑
python3 -c "
import ctypes
lib = ctypes.CDLL('./c_core/libgobang.so')
lib.place_piece.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
lib.place_piece.restype = ctypes.c_int
lib.check_winner.restype = ctypes.c_int
lib.board_init()
# 验证落子、胜负判定等
"
```
