# 联机五子棋 (Online Gomoku)

基于 **C 核心 + Python 后端 + Web 前端** 的双人联机五子棋游戏。支持用户注册登录、JWT 鉴权、自动匹配对局、五子连珠胜负判定和断线处理。

## 快速启动

### Docker 部署（推荐）

```bash
# 一键启动所有服务（MySQL + 后端 + 前端）
docker compose -f docker/docker-compose.yaml up --build

# 浏览器访问 http://localhost:8080
```

### 手动启动

```bash
# 1. 编译 C 动态库
cd c_core && make && cp libgobang.so ../python_server/

# 2. 安装 Python 依赖
cd ../python_server && pip install -r requirements.txt

# 3. 配置数据库
cp .env.example .env   # 编辑 .env 填写 MySQL 连接信息

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
├── c_core/             # C 核心: 棋盘状态、落子校验、胜负判定 (编译为 libgobang.so)
├── python_server/      # Python 后端: aiohttp HTTP + WebSocket 服务
├── public/             # 前端: Canvas 棋盘 + WebSocket 客户端
├── docker/             # Docker 部署 (docker-compose + Dockerfile)
└── README.md
```

## 技术架构

| 层 | 技术 | 职责 |
|----|------|------|
| C 核心 | ANSI C | 15×15 棋盘管理 (静态数组)、落子校验、四方向连珠判定 |
| Python 后端 | aiohttp + WebSocket | HTTP 注册/登录、WebSocket 对局通信、ctypes 调用 C 库、MySQL 查询 |
| 前端 | 原生 HTML5 + CSS3 + JS | Canvas 绘制棋盘、WebSocket 通信、用户交互 |
| 数据库 | MySQL | 用户账号存储 |

## 数据流

```
浏览器                     Python 服务器                    MySQL
  │                            │                             │
  ├── POST /register ────────→ │ bcrypt 加密                 │
  │←──── 成功/失败 ────────────│── INSERT INTO users ───────→ │
  │                            │                             │
  ├── POST /login ───────────→ │ 验证密码 + JWT (2h)         │
  │←── {token, username} ──────│── SELECT FROM users ───────→│
  │                            │                             │
  ├── WS /ws?token=JWT ──────→ │ 鉴权后进入匹配或对局         │
  │   {type:"match"}          │ FIFO 等待队列 → 创建房间      │
  │   {type:"move",x,y}       │ ctypes 调 C 库落子 + 判胜    │
  │←── {type:"move/turn/       │                             │
  │      game_over/error}      │                             │
```

## 功能说明

- **用户系统**: 注册 (用户名 2-50 字符, 密码 4+ 位), 登录, JWT 鉴权 (HS256, 2h 有效期)
- **匹配对局**: 登录后点击"开始匹配"进入 FIFO 队列, 匹配后随机分配黑白棋
- **游戏规则**: 黑先白后, 15×15 棋盘交叉点落子, 横竖斜任意方向五子连珠获胜
- **断线处理**: 断线视为认输, 对手直接获胜
- **技术特点**: C 库通过 ctypes 桥接, 无动态内存分配; 线程池隔离 DB 查询, 不阻塞事件循环

## 环境变量

编辑 `python_server/.env`:

| 变量 | 说明 | 必填 |
|------|------|------|
| `DB_HOST` | MySQL 主机地址 | 是 |
| `DB_PORT` | MySQL 端口 (默认 3306) | 否 |
| `DB_USER` | 数据库用户名 | 是 |
| `DB_PASSWORD` | 数据库密码 | 是 |
| `DB_NAME` | 数据库名 | 是 |
| `JWT_SECRET` | JWT 签名密钥 | 否 |
| `PORT` | 服务器监听端口 (默认 8080) | 否 |

## 环境要求

- GCC 或 Clang (编译 C 动态库)
- Python 3.8+, MySQL 服务器, 现代浏览器
- 或 Docker & Docker Compose
- Python 依赖: websockets, aiohttp, mysql-connector-python, bcrypt, PyJWT, python-dotenv

## 常见问题

**MySQL 远程连接不上？** 检查数据库远程访问权限和防火墙。

**C 动态库加载失败？** 确保执行了 `cd c_core && make && cp libgobang.so ../python_server/`。

**WebSocket 连接失败？** 确认后端已启动, 端口未被占用。前端通过 `<meta name="api-port">` 确定后端地址。

**同一台电脑测试联机？** 打开两个浏览器窗口 (普通 + 无痕), 分别注册账号, 各自登录后点击匹配。
