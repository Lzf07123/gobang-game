# 联机五子棋 (Online Gomoku)

**C 核心 + Python 后端 + Web 前端** 的双人联机五子棋。支持用户注册登录、JWT 鉴权、自动匹配、房间系统、观战、聊天、对局计时器、棋谱回放、落子动画、房间浏览、匹配退出等丰富功能。

---

## 快速启动

### Docker 部署（推荐）

```bash
# 1. 配置环境变量
cp .env.example .env
cp python-server/.env.example python-server/.env
# 编辑两个文件，确保 DB_PASSWORD 一致

# 2. 一键启动 (MySQL + 后端 + 前端)
docker compose -f docker-compose.yaml up --build

# 3. 浏览器访问 http://localhost:3000
```

### 手动启动（开发调试）

```bash
# 1. 编译 C 动态库
cd c-core && make run    # 自动复制 libgobang.so 到 python-server/

# 2. 安装 Python 依赖
cd ../python-server && pip install -r requirements.txt

# 3. 配置环境变量
cp .env.example .env     # 编辑 .env: DB_HOST=localhost, 填入本地 MySQL 信息

# 4. 启动后端 (HTTP + WebSocket, 默认 8080 端口)
python server.py

# 5. 新终端: 启动前端静态服务
cd ../public && python -m http.server 3000

# 6. 浏览器访问 http://localhost:3000
```

---

## 项目结构

```
gobang/
├── .env                       docker-compose 变量 (git 忽略)
├── .env.example               根目录环境变量模板
├── docker-compose.yaml        Docker 编排 (app + auth + db 三容器)
├── CLAUDE.md                  Claude Code 配置
├── c-core/                    C 核心: 15×15 棋盘、落子校验、五子连珠判定
│   ├── gobang.c
│   ├── gobang.h
│   └── Makefile
├── python-server/             Python 后端: HTTP + WebSocket 服务
│   ├── .env                   应用配置 (git 忽略)
│   ├── .env.example           后端环境变量模板
│   ├── server.py              主服务 (aiohttp) — HTTP 认证 + WebSocket 对局
│   ├── auth.py                注册/登录/JWT (自动生成密钥)
│   ├── db.py                  MySQL 连接池
│   ├── game_engine.py         C 库 ctypes 封装 + Python 棋盘逻辑
│   ├── test_db.py             数据库连通性测试
│   └── requirements.txt
├── docker/
│   └── gobang-app/
│       └── Dockerfile         前端容器 (Python http.server :3000)
│   └── gobang-auth/
│       └── Dockerfile         后端容器 (多阶段: 编译 C + 运行 Python)
├── public/                    前端 (无框架 HTML5)
│   ├── index.html
│   ├── style.css
│   └── client.js
└── README.md
```

---

## 功能一览

| 功能 | 说明 |
|------|------|
| 用户注册/登录 | bcrypt 密码加密，JWT 令牌认证，毛玻璃登录界面 |
| 快速匹配 | FIFO 队列，自动分配对手，支持随时退出匹配 |
| 房间系统 | 创建/加入 4 位房间码，好友对战 |
| 房间浏览 | 实时查看等待中的房间列表，一键加入 |
| 观众模式 | 输入房间码观战，实时同步棋局 |
| 对局聊天 | 房内文本聊天，玩家+观众均可发言 |
| 落子计时 | 每步 30 秒，超时判负 |
| 落子动画 | 棋子缩放动画 + Web Audio 音效 |
| 最后落子标记 | 红点标记最后一步位置 |
| 棋谱回放 | 自动存储对局记录，支持逐手回放 |
| 断线安全 | Token 移至 WebSocket 认证消息，不暴露在 URL |
| 频率限制 | 登录/注册接口基于 IP 滑动窗口限流防暴力破解 |
| 服务端清理 | 定时清理过期连接、超时房间、断线用户 |

---

## 环境变量

### 根目录 `.env` — docker-compose 变量注入

| 变量          | 默认值   | 说明                   |
| ------------- | -------- | ---------------------- |
| `DB_PASSWORD` | —        | MySQL root 密码 (必填) |
| `DB_NAME`     | `gobang` | MySQL 数据库名         |
| `AUTHPORT`    | `8080`   | 后端容器端口映射       |
| `APPPORT`     | `3000`   | 前端容器端口映射       |

### `python-server/.env` — 后端应用配置

| 变量          | 手动开发值   | Docker 环境值 | 说明                 |
| ------------- | ------------ | ------------- | -------------------- |
| `DB_HOST`     | `localhost`  | `gobang-db`   | MySQL 地址           |
| `DB_PORT`     | `3306`       | `3306`        | MySQL 端口           |
| `DB_USER`     | `root`       | `root`        | 数据库用户名         |
| `DB_PASSWORD` | `your_pass`  | `your_pass`   | 数据库密码           |
| `DB_NAME`     | `gobang`     | `gobang`      | 数据库名             |
| `JWT_SECRET`  | _自动生成_   | 同上          | JWT 签名密钥 (HS256) |
| `PORT`        | `8080`       | `8080`        | 服务监听端口         |

> **JWT 密钥安全**: 如果 `.env` 中 `JWT_SECRET` 为空或为默认值 `your_jwt_secret_key_change_me`，服务器启动时会自动生成 64 位随机十六进制密钥并打印到控制台。

---

## 技术架构

| 层          | 技术                     | 职责                                                                 |
| ----------- | ------------------------ | -------------------------------------------------------------------- |
| C 核心      | ANSI C (`-shared -fPIC`) | 15×15 棋盘状态、落子校验、横/竖/斜四方向五子连珠判定                 |
| Python 后端 | aiohttp + WebSocket      | HTTP 注册/登录、WebSocket 对局通信、房间管理、聊天、计时、多棋局支持 |
| 前端        | 原生 HTML5 + CSS3 + JS   | Canvas 绘制棋盘、WebSocket 通信、动画音效、棋谱本地存储              |
| 数据库      | MySQL                    | 用户账号与密码哈希存储                                               |

### 关键设计

- **Python 棋盘逻辑**: 每个房间独立维护 15×15 棋盘状态，支持多局并发。`check_winner_on_board()` 用纯 Python 实现五子连珠检测，不依赖 C 单例。
- **消息认证**: WebSocket 连接时不携带 Token，连接后发送 `{type:"auth", token}` 消息完成认证，避免 Token 泄露到日志。
- **频率限制**: 基于 IP 的滑动窗口限流（30次/分钟），保护注册登录接口。
- **断线即负**: WebSocket 断开时对手自动获胜，房间清理。
- **定时器**: 每步 30 秒倒计时，超时自动判负。服务端异步任务驱动。
- **并发控制**: 线程池按 CPU 核心数自动缩放，等待队列 O(1) 操作，限制最大连接数(500)和房间数(1000)。
- **定期清理**: 后台任务每 60 秒清理过期认证连接、超时等待房间、IP 限流记录。
- **登录界面**: 毛玻璃卡片设计，动态渐变背景，棋盘网格纹路叠加，棋子装饰动画。

---

## HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/register` | 用户注册 |
| POST | `/login` | 用户登录，返回 JWT |
| GET | `/health` | 健康检查 |
| GET | `/api/rooms` | 获取等待中的房间列表 |

## WebSocket 协议

### 客户端 → 服务端

| type           | 字段                       | 说明                           |
| -------------- | -------------------------- | ------------------------------ |
| `auth`         | `token`                    | 认证 (连接后第一条消息)        |
| `match`        | —                          | 请求匹配对局                   |
| `cancel_match` | —                          | 取消匹配排队                   |
| `create_room`  | —                          | 创建房间                       |
| `join_room`    | `room_id`, `as_spectator`  | 加入房间 / 以观众身份加入      |
| `leave_room`   | —                          | 离开当前房间                   |
| `move`         | `x`, `y`                   | 落子 (行列坐标 0-14)           |
| `chat`         | `message`                  | 发送聊天消息                   |

### 服务端 → 客户端

| type              | 字段                                    | 说明                    |
| ----------------- | --------------------------------------- | ----------------------- |
| `auth_ok`         | `username`                              | 认证成功                |
| `waiting`         | `message`                               | 等待中                  |
| `match_cancelled` | `message`                               | 匹配已取消              |
| `start`           | `color`, `message`, `room_id`, `usernames` | 对局开始            |
| `move`            | `x`, `y`, `color`                       | 落子通知                |
| `turn`            | `color`                                 | 轮到谁                  |
| `timer`           | `remaining`                             | 倒计时更新 (秒)         |
| `game_over`       | `winner`, `reason`, `moves`             | 游戏结束                |
| `error`           | `error`                                 | 错误消息                |
| `room_created`    | `room_id`                               | 房间创建成功            |
| `room_joined`     | `room_id`, `players`, `state`           | 加入房间成功            |
| `player_joined`   | `username`                              | 玩家加入房间            |
| `player_left`     | `username`                              | 玩家离开房间            |
| `spectator_count` | `count`, `username`                     | 观众人数变更            |
| `chat`            | `username`, `message`                   | 聊天消息                |

### 连接流程

```
客户端                          Python 服务器                   MySQL
  │                                │                            │
  ├── POST /register ────────────→ │ bcrypt 加密                 │
  │←──── 成功/失败 ────────────────│── INSERT INTO users ──────→ │
  │                                │                            │
  ├── POST /login ───────────────→ │ 验证密码 + JWT (2h)        │
  │←── {token, username} ──────────│── SELECT FROM users ──────→│
  │                                │                            │
  ├── WS /ws ────────────────────→ │ 建立 WebSocket (无Token)   │
  │   {type:"auth", token}         │ 验证 Token                 │
  │←── {type:"auth_ok"} ───────────│                            │
  │                                │                            │
  │   {type:"match"} /             │ 快速匹配 / 创建房间 /       │
  │   {type:"create_room"} /       │ 加入房间 / 观战            │
  │   {type:"join_room",...}       │                            │
  │←── {type:"start",...}          │ 对局开始                   │
  │   {type:"move",x,y}            │ 落子 + 判胜                │
  │←── {type:"move/turn/timer/     │                            │
  │      chat/game_over"}          │                            │
```

---

## 常见问题

**同一台电脑测试联机？**
打开两个浏览器窗口（普通 + 无痕/隐私），分别注册账号，各自登录后一方创建房间、另一方输入房间码加入。

**MySQL 连接失败？**

- 手动运行: 检查 MySQL 服务是否启动，`DB_HOST` 是否为 `localhost`，密码是否正确
- Docker 运行: 确保 `python-server/.env` 中 `DB_HOST=gobang-db`（Docker 内部服务名）

**C 动态库加载失败？**

```bash
cd c-core && make && cp libgobang.so ../python-server/
```

**端口被占用？**
修改 `python-server/.env` 中的 `PORT` 值，同时更新 `public/index.html` 中 `<meta name="api-port">` 保持一致。注意根目录 `.env` 中的 `AUTHPORT` 也需要同步修改。

---

## 环境要求

- GCC 或 Clang（编译 C 动态库）
- Python 3.8+
- MySQL 8.0+
- 现代浏览器（支持 Canvas, WebSocket, Web Audio API）
- Docker & Docker Compose（可选，容器化部署）
