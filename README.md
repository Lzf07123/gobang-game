# 联机五子棋

基于 C 语言核心 + Python 后端 + Web 前端的双人联机五子棋游戏。支持用户注册登录、自动匹配对局、五子连珠胜负判定和断线处理。

## 快速开始

```bash
# 1. 编译 C 动态库
cd c_core && make && cp libgobang.so ../python_server/

# 2. 安装 Python 依赖
cd ../python_server && pip install -r requirements.txt

# 3. 配置数据库（复制模板填写）
cp .env.example .env
# 编辑 .env：填写远程 MySQL 的地址、端口、用户名、密码、数据库名

# 4. 启动后端（HTTP + WebSocket，默认 8080 端口）
python server.py

# 5. 新终端：启动前端静态服务
cd ../public && python -m http.server 3000

# 6. 打开浏览器访问 http://localhost:3000
```

## 技术架构

### 分层设计

| 层 | 技术 | 职责 |
|----|------|------|
| C 核心 | ANSI C | 棋盘状态管理、落子校验、五子连珠判定，编译为 `.so` 动态库 |
| Python 后端 | aiohttp + WebSocket | HTTP API（注册/登录）、WebSocket 对局通信、ctypes 调用 C 库、MySQL 数据存储 |
| 前端 | 原生 HTML5 + CSS3 + JavaScript | Canvas 绘制棋盘、WebSocket 通信、用户交互 |
| 数据库 | 远程 MySQL | 用户账号存储（用户名、bcrypt 加密密码、注册时间） |

### 项目结构

```
gobang/
├── c_core/               # C 核心逻辑
│   ├── gobang.h          # 接口声明
│   ├── gobang.c          # 实现代码
│   └── Makefile          # 编译脚本
├── python_server/        # Python 后端服务
│   ├── server.py         # 主服务器（HTTP + WebSocket）
│   ├── game_engine.py    # C 动态库封装
│   ├── auth.py           # 注册/登录逻辑
│   ├── db.py             # MySQL 数据库操作
│   ├── requirements.txt  # Python 依赖
│   └── .env.example      # 环境变量模板
├── public/               # 前端静态页面
│   ├── index.html        # 页面结构
│   ├── style.css         # 样式
│   └── client.js         # 游戏客户端
├── CLAUDE.md             # 项目指引
└── README.md             # 本文件
```

### 数据流

```
浏览器                    Python 服务器                   远程 MySQL
  │                          │                              │
  │── POST /register ──────→ │  bcrypt 加密                 │
  │←──── 成功/失败 ──────────│── INSERT INTO users ────────→│
  │                          │                              │
  │── POST /login ─────────→ │  验证密码 + 生成 JWT         │
  │←── {token, username} ────│── SELECT FROM users ───────→│
  │                          │                              │
  │── WS /ws?token=JWT ────→ │  verify_token               │
  │                          │                              │
  │── {"type":"match"} ────→ │  加入匹配队列                │
  │←── {"type":"start"} ─────│  -- 配对对手 --              │
  │                          │                              │
  │── {"type":"move",...} ──→│  ctypes 调用 C 库校验落子    │
  │←── {"type":"move",...} ──│  └─ place_piece(x, y, color) │
  │←── {"type":"turn",...} ──│  └─ check_winner()           │
  │←── {"type":"game_over"} ─│  产生胜者 / 断线             │
```

## 功能说明

### 用户系统
- **注册**：用户名（2-50 字符）+ 密码（至少 4 位），bcrypt 加密存储
- **登录**：验证密码后返回 JWT 令牌（有效期 2 小时）

### 匹配对局
- 登录后点击"开始匹配"进入等待队列
- 系统自动配对两名玩家，黑棋先行
- 棋盘 15×15，通过 Canvas 绘制

### 游戏规则
- 黑棋先手，双方轮流在交叉点落子
- 横、竖、斜任意方向率先形成五子连珠者获胜
- 落子后服务器校验合法性并判定胜负
- 强行关闭页面或断线视为认输，对手直接获胜

### WebSocket 协议

| 方向 | type | 说明 |
|------|------|------|
| 客户端 → 服务器 | `match` | 请求匹配 |
| 客户端 → 服务器 | `move` | 落子（附带 x, y 坐标） |
| 服务器 → 客户端 | `waiting` | 等待对手加入 |
| 服务器 → 客户端 | `start` | 对局开始（color: 1=黑, 2=白） |
| 服务器 → 客户端 | `move` | 对手落子通知 |
| 服务器 → 客户端 | `turn` | 轮到谁走棋 |
| 服务器 → 客户端 | `game_over` | 游戏结束（含胜方信息） |
| 服务器 → 客户端 | `error` | 错误提示 |

## 环境变量配置

所有敏感信息通过环境变量配置，不硬编码在代码中：

| 变量 | 说明 | 必填 |
|------|------|------|
| `DB_HOST` | MySQL 远程主机地址 | 是 |
| `DB_PORT` | MySQL 端口（默认 3306） | 否 |
| `DB_USER` | 数据库用户名 | 是 |
| `DB_PASSWORD` | 数据库密码 | 是 |
| `DB_NAME` | 数据库名 | 是 |
| `JWT_SECRET` | JWT 签名密钥 | 否（有默认值，建议修改） |
| `PORT` | 服务器监听端口（默认 8080） | 否 |

## 环境要求

### 编译环境
- GCC 或 Clang（编译 C 动态库）
- Make

### 运行时
- Python 3.8+
- MySQL 远程服务器（需开启远程连接权限）
- 现代浏览器（Chrome / Firefox / Edge）

### Python 依赖
```
websockets
aiohttp
mysql-connector-python
bcrypt
PyJWT
python-dotenv
```

## 常见问题

**Q: 远程 MySQL 连接不上？**
检查数据库是否开启远程访问：`GRANT ALL ON db_name.* TO 'user'@'%' IDENTIFIED BY 'password'`；检查防火墙是否开放了 MySQL 端口（默认 3306）。

**Q: C 动态库加载失败？**
确保已执行 `make && cp libgobang.so ../python_server/`，且 `.so` 文件位于 `python_server/` 目录下。

**Q: WebSocket 连接失败？**
确认后端已启动且端口未被占用，检查 `PORT` 环境变量。前端默认连接 `localhost:8080`。

**Q: 如何在同一台电脑上测试联机？**
打开两个浏览器窗口（或一个普通窗口 + 一个无痕窗口），分别注册不同账号，各自登录后点击"开始匹配"。

## 开发备注

本项目为 C 语言大作业，代码约 800 行。核心游戏逻辑由 C 实现并编译为动态库，Python 负责网络通信和数据库交互，前端提供 Web 界面，展示了混合语言协作的完整流程。
