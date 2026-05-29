# 联机五子棋 (Online Gomoku)

**C 核心 + Python 后端 + Web 前端** 的双人联机五子棋。支持注册登录、JWT 鉴权、自动匹配、房间系统、观战、聊天、对局计时、棋谱回放、悔棋、再来一局、棋盘皮肤切换等功能。

---

## 快速启动

### Docker 部署（推荐）

```bash
# 1. 配置环境变量
cp .env.example .env
cp python-server/.env.example python-server/.env
# 编辑两个文件，确保 DB_PASSWORD 和 JWT_SECRET 一致

# 2. 准备前端页面（从模板复制，api-port 留空使用同源访问）
cp public/index.html.example public/index.html

# 3. 一键启动 (MySQL + 后端 + 前端)
docker compose -f docker-compose.yaml up --build

# 4. 浏览器访问 http://localhost:3000
```

### 手动启动（开发调试）

```bash
# 1. 编译 C 动态库
cd c-core && make clean && make all

# 2. 复制 libgobang.so 到 python-server/
cp libgobang.so ../python-server/

# 3. 安装 Python 依赖
cd ../python-server && pip install -r requirements.txt

# 4. 配置环境变量
cp .env.example .env     # 编辑 .env: DB_HOST=localhost, 填入本地 MySQL 信息

# 5. 准备前端页面（模板的 api-port 默认 8080，指向本地后端）
cp ../public/index.html.example ../public/index.html

# 6. 启动后端 (HTTP + WebSocket, 默认 8080 端口)
python server.py

# 7. 新终端: 启动前端静态服务
cd ../public && python -m http.server 3000

# 8. 浏览器访问 http://localhost:3000
```

---

## 项目结构

```
gobang/
├── .env.example                根目录环境变量模板
├── docker-compose.yaml         Docker 编排
├── c-core/                     C 核心: 棋盘管理、五子连珠判定、禁手检测、局面评估
│   ├── board.c / board.h       棋盘状态、初始化、落子
│   ├── rules.c / rules.h       赢棋检测、禁手(三三/四四/长连)、获胜线提取
│   ├── evaluate.c / evaluate.h 局面评估函数（为 AI 预留）
│   └── Makefile
├── python-server/              Python 后端: HTTP + WebSocket 服务
│   ├── .env.example            后端环境变量模板
│   ├── server.py               主服务 (aiohttp) — HTTP 认证 + WebSocket 对局
│   ├── auth.py                 注册/登录/JWT/会话管理
│   ├── db.py                   MySQL 连接池 + 对局持久化
│   ├── game_engine.py          C 库 ctypes 封装（每房间独立棋盘，服务端 C 库判胜）
│   ├── test_db.py              数据库连通性测试
│   ├── test_core.py            C 库接口测试
│   └── requirements.txt
├── docker/
│   ├── gobang-app/Dockerfile   前端容器（Python HTTP Server）
│   └── gobang-auth/Dockerfile  后端容器（多阶段: GCC 编译 C 库 + Python 运行时）
├── public/                     前端 (原生 HTML5)
│   ├── index.html.example      页面模板（需复制为 index.html 使用）
│   ├── style.css               样式 + 4 套棋盘主题 + 响应式
│   └── client.js               WebSocket 通信、棋盘绘制、音效、回放
└── README.md
```

---

## 功能一览

| 功能 | 说明 |
|------|------|
| 用户注册/登录 | bcrypt 密码加密，JWT 令牌认证（7 天有效） |
| 账号体系 | 账号（字母数字 2-20 位）用于登录，显示名（中英文/数字/下划线 2-20 位）用于对局展示 |
| 自动登录 | 本地存储 Token，页面刷新后自动恢复登录态 |
| 会话管理 | 单设备登录，新设备登录后旧连接被踢出；断线 5 秒宽限期支持快速重连 |
| 快速匹配 | FIFO 队列，自动分配对手，支持随时退出匹配 |
| 房间系统 | 创建/加入 4 位房间码，好友对战，一键复制房间码 |
| 房间可见性 | 公开房间出现在浏览列表中，私人房间仅通过房间码加入 |
| 房间浏览 | 实时查看等待中的公开房间，一键加入 |
| 观众模式 | 输入房间码观战，实时同步棋局 |
| 对局聊天 | 房内文本聊天，最大 200 字符，100 条消息缓存 |
| 落子计时 | 每步 30 秒，超时判负 |
| 禁手规则 | 黑棋禁手检测（双活三、双四、长连），C 库实现 |
| 悔棋 | 每局每人 3 次，需对手同意 |
| 再来一局 | 对局结束后 60 秒内双方可快速重开，自动交换黑白 |
| 终局高亮 | 五连子金色脉冲高亮，C 库提取获胜线坐标 |
| 棋盘皮肤 | 4 套主题：经典木纹 / 简约白 / 暗夜 / 竹林，偏好存 localStorage |
| 音效开关 | Web Audio 音效，一键静音，偏好持久化 |
| 棋谱回放 | 本地存储 + 服务端数据库双源，支持逐手/自动回放，可调速 |
| 断线重连 | 5 秒宽限期保留房间状态，指数退避策略（最多 8 次） |
| 游戏持久化 | 进行中的游戏写入 MySQL `active_games` 表，服务器重启后归档 |
| 频率限制 | HTTP 接口基于 IP 滑动窗口限流（30 次/60 秒），WebSocket 消息限流（20 条/秒） |
| 服务端清理 | 定时清理过期认证连接、超时房间（5 分钟）、断线客户端 |

---

## 环境变量

### 根目录 `.env` — docker-compose 变量注入

| 变量          | 默认值   | 说明                   |
| ------------- | -------- | ---------------------- |
| `DB_PASSWORD` | —        | MySQL root 密码 (必填) |
| `DB_NAME`     | `gobang` | MySQL 数据库名         |
| `JWT_SECRET`  | —        | JWT 签名密钥 (必填)    |
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

> **JWT 密钥**: 如果 `.env` 中 `JWT_SECRET` 为空或为占位值，服务器启动时会提示错误并退出。生产环境必须手动配置固定值。生成方式：
> ```bash
> python3 -c "import secrets; print(secrets.token_hex(32))"
> ```

---

## 技术架构

| 层          | 技术                     | 职责 |
| ----------- | ------------------------ | ---- |
| C 核心      | ANSI C (`-shared -fPIC`) | 棋盘状态、落子校验、四方向五子连珠判定、禁手检测（三三/四四/长连）、局面评估 |
| Python 后端 | aiohttp + WebSocket      | HTTP 认证、WebSocket 对局通信、房间管理、聊天、计时、会话管理、多局并发 |
| 前端        | 原生 HTML5 + CSS3 + JS   | Canvas 棋盘绘制、4 套皮肤、WebSocket 通信、动画音效、棋谱存储与回放 |
| 数据库      | MySQL                    | 用户账号、对局记录、活跃游戏持久化、会话状态 |

### 关键设计

- **前端后端连接**: `public/index.html` 中的 `<meta name="api-port">` 控制 WebSocket/HTTP 连接目标。留空 = 同源访问（Docker 反代模式），设为 `8080` = 直连本地后端（手动开发模式）。前端自动检测 HTTPS 决定使用 `wss:` 还是 `ws:`。
- **C 库判胜**: 服务端通过 `game_engine.py` 调用 C 库的 `check_winner_on()` / `get_win_line_on()`，每个房间独立维护 ctypes 棋盘，直接传入无需同步开销。禁手检测通过 asyncio 锁保护全局静态棋盘。
- **消息认证**: WebSocket 连接后首条消息发送 `{type:"auth", token}` 完成认证，10 秒超时。后续所有消息均需认证。
- **会话管理**: 每次登录生成唯一 `session_id` 存入数据库。WebSocket 连接时校验会话一致性，新登录会使旧连接的 Token 失效。
- **断线宽限期**: 客户端断开后保留房间状态 5 秒，期间同会话重连可无缝恢复对局（包括棋盘状态、落子历史、当前回合）。
- **频率限制**: HTTP 接口基于 IP 滑动窗口限流（30 次/60 秒）。WebSocket 消息限流（20 条/秒/连接）。
- **游戏持久化**: 对局进行中将棋盘状态写入 `active_games` 表。服务器崩溃重启后自动归档未完成对局并清理残留数据。
- **并发控制**: 线程池按 CPU 核心数自动缩放（`cpu_count × 5`，上限 32）。匹配/加入房间使用 asyncio.Lock 防竞态。最大连接数 500、最大房间数 1000。
- **定期清理**: 后台任务每 60 秒清理过期认证连接、超时等待房间（5 分钟）、IP 限流记录、断线客户端残留。

---

## HTTP API

所有需要认证的接口需在请求头携带 `Authorization: Bearer <token>`。

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | `/register` | 否 | 用户注册 (`account`, `display_name`, `password`) |
| POST | `/login` | 否 | 用户登录，返回 JWT + `display_name` |
| GET | `/health` | 否 | 健康检查 |
| GET | `/api/rooms` | 否 | 获取等待中的公开房间列表 |
| GET | `/api/games` | 是 | 获取当前用户的对局历史 |
| GET | `/api/games/{id}` | 是 | 获取对局棋谱详情（含每步坐标） |
| GET | `/api/profile` | 是 | 获取当前用户统计（总对局、胜场、胜率） |
| POST | `/api/profile/update` | 是 | 修改显示名 (`display_name`) |

### 注册/登录字段

**注册** (`POST /register`):
| 字段 | 说明 |
|------|------|
| `account` | 账号，仅字母和数字，2-20 字符 |
| `display_name` | 显示名，中英文/数字/下划线，2-20 字符 |
| `password` | 密码，6-128 字符 |

**登录** (`POST /login`):
| 字段 | 说明 |
|------|------|
| `account` | 账号 |
| `password` | 密码 |

## WebSocket 协议

连接路径: `/ws`。连接后 **首条消息必须为 `auth`**，10 秒内未认证则断开。

### 客户端 → 服务端

| type            | 字段                       | 说明                    |
| --------------- | -------------------------- | ----------------------- |
| `auth`          | `token`                    | 认证（连接后第一条消息）|
| `match`         | —                          | 请求匹配对局            |
| `cancel_match`  | —                          | 取消匹配排队            |
| `create_room`   | `is_public`                | 创建房间（可选，默认 false） |
| `join_room`     | `room_id`, `as_spectator`  | 加入房间 / 观众模式     |
| `leave_room`    | —                          | 离开当前房间            |
| `move`          | `x`, `y`                   | 落子 (0-14)             |
| `chat`          | `message`                  | 发送聊天消息（最长 200）|
| `request_undo`  | —                          | 请求悔棋                |
| `undo_response` | `accept`                   | 同意/拒绝悔棋           |
| `resign`        | —                          | 认输                    |
| `rematch`       | —                          | 请求再来一局            |

### 服务端 → 客户端

| type               | 字段                                          | 说明                    |
| ------------------ | --------------------------------------------- | ----------------------- |
| `auth_ok`          | `username`, `display_name`                    | 认证成功                |
| `waiting`          | `message`                                     | 等待对手中              |
| `match_cancelled`  | `message`                                     | 匹配已取消              |
| `start`            | `color`, `message`, `room_id`, `usernames`    | 对局开始（color: 1=黑 2=白） |
| `move`             | `x`, `y`, `color`                             | 落子通知                |
| `turn`             | `color`                                       | 轮到谁落子              |
| `timer`            | `remaining`                                   | 倒计时更新（秒）        |
| `game_over`        | `winner`, `reason`, `moves`, `win_line`       | 对局结束 + 五连高亮坐标 |
| `error`            | `error`                                       | 错误消息                |
| `kicked`           | `message`                                     | 账号在其他设备登录，被踢出 |
| `room_created`     | `room_id`                                     | 房间创建成功            |
| `room_joined`      | `room_id`, `players`, `state`, `as_spectator` | 加入房间成功            |
| `player_joined`    | `username`                                    | 玩家加入房间            |
| `player_left`      | `username`                                    | 玩家离开房间            |
| `spectator_count`  | `count`, `username`                           | 观众人数变更            |
| `room_closed`      | `message`                                     | 房间关闭                |
| `chat`             | `username`, `message`                         | 聊天消息                |
| `request_undo`     | `from`                                        | 对手请求悔棋            |
| `undo_response`    | `accepted`, `message`                         | 悔棋请求结果            |
| `undo`             | `board`, `moves`                              | 棋盘状态回退            |
| `rematch_request`  | `from`                                        | 对手邀请再来一局        |
| `rematch_waiting`  | `message`                                     | 等待对方确认再来一局    |

---

## 常见问题

**同一台电脑测试联机？**
打开两个浏览器窗口（普通 + 无痕），分别注册账号，各自登录后一方创建房间、另一方输入房间码加入。

**MySQL 连接失败？**
- 手动运行: 检查 MySQL 服务是否启动，`DB_HOST` 是否为 `localhost`，密码是否正确
- Docker 运行: 确保 `python-server/.env` 中 `DB_HOST=gobang-db`

**C 动态库加载失败？**
```bash
cd c-core && make clean && make all
cp libgobang.so ../python-server/
```

**端口被占用？**
修改 `python-server/.env` 中的 `PORT` 值，同时更新 `public/index.html` 中 `<meta name="api-port">` 保持一致。

**JWT_SECRET 未配置？**
服务器启动时会提示错误并退出。运行以下命令生成密钥并写入 `python-server/.env`：
```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

---

## 环境要求

- GCC 或 Clang（编译 C 动态库）
- Python 3.8+
- MySQL 8.0+
- 现代浏览器（支持 Canvas、WebSocket、Web Audio API）
- Docker & Docker Compose（可选）
