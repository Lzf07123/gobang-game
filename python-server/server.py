import json
import os
import asyncio
import secrets
import time
import random
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict, OrderedDict

from aiohttp import web
from dotenv import load_dotenv

from db import init_db, execute_query, check_env
from auth import register, login, verify_token
from game_engine import check_winner_on_board, make_board, BOARD_SIZE

load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

# Concurrency: scale thread pool with available cores
_executor = ThreadPoolExecutor(max_workers=min(32, (os.cpu_count() or 1) * 5))

# ===== In-memory game state =====
clients = {}       # ws -> {'username': str, 'room_id': str|None, 'authenticated': bool}
pending_auth = {}  # ws -> timestamp (unauthenticated connections)
rooms = {}         # room_id -> dict
waiting_queue = OrderedDict()  # ws -> True (O(1) insert/remove/pop)

# Rate limiting
_ratelimit = defaultdict(list)
_RATELIMIT_MAX = 30
_RATELIMIT_WINDOW = 60

# Timer tasks
_timer_tasks = {}  # room_id -> asyncio.Task

AUTH_TIMEOUT = 10  # seconds to wait for auth message
TIMER_SECONDS = 30  # seconds per move
ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

# Safety limits
MAX_ROOMS = 1000
MAX_CONNECTIONS = 500
ROOM_WAIT_TIMEOUT = 300  # 5 min before cancelling a waiting room


# ===== Helpers =====

def _check_ratelimit(ip):
    now = time.time()
    _ratelimit[ip] = [t for t in _ratelimit[ip] if now - t < _RATELIMIT_WINDOW]
    if len(_ratelimit[ip]) >= _RATELIMIT_MAX:
        return False
    _ratelimit[ip].append(now)
    return True


def _generate_room_id():
    while True:
        rid = ''.join(random.choices(ROOM_ID_CHARS, k=4))
        if rid not in rooms:
            return rid


async def _run_db(fn, *args):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, fn, *args)


async def _send(ws, data):
    try:
        await ws.send_json(data)
    except (ConnectionResetError, ConnectionAbortedError):
        pass


async def _broadcast_room(room_id, data, exclude=None):
    room = rooms.get(room_id)
    if not room:
        return
    targets = []
    for p in room.get('players', []):
        if p and p != exclude:
            targets.append(p)
    for s in room.get('spectators', set()):
        if s != exclude:
            targets.append(s)
    for t in targets:
        await _send(t, data)


async def _broadcast_to_player(room, player_idx, data):
    """Send to a specific player in a room."""
    ws = room['players'][player_idx]
    if ws:
        await _send(ws, data)


async def _start_timer(room_id):
    """Start a 30-second countdown for the current player."""
    await _cancel_timer(room_id)
    task = asyncio.create_task(_timer_loop(room_id))
    _timer_tasks[room_id] = task


async def _cancel_timer(room_id):
    old = _timer_tasks.pop(room_id, None)
    if old:
        old.cancel()
        try:
            await old
        except asyncio.CancelledError:
            pass


async def _timer_loop(room_id):
    """Countdown from TIMER_SECONDS to 0 for the current room."""
    try:
        remaining = TIMER_SECONDS
        while remaining > 0:
            await _broadcast_room(room_id, {'type': 'timer', 'remaining': remaining})
            await asyncio.sleep(1)
            remaining -= 1
        # Timer expired — current player loses
        room = rooms.get(room_id)
        if not room or room['state'] != 'playing':
            return
        color = room['current_player']
        winner_idx = 1 if color == 1 else 0
        winner_username = room['usernames'][winner_idx] or ('白方' if winner_idx == 1 else '黑方')
        room['state'] = 'finished'
        for ws in room['players']:
            if ws:
                await _send(ws, {'type': 'game_over', 'winner': winner_username, 'reason': '对方超时'})
        await _broadcast_room(room_id, {'type': 'chat', 'username': '系统', 'message': f'{winner_username}获胜（对方超时）'})
        _cleanup_room(room_id)
    except asyncio.CancelledError:
        pass


def _cleanup_room(room_id):
    """Remove room and reset connected clients."""
    _timer_task = _timer_tasks.pop(room_id, None)
    if _timer_task:
        _timer_task.cancel()
    room = rooms.pop(room_id, None)
    if room:
        for ws in room.get('players', []):
            if ws:
                info = clients.get(ws)
                if info and info['room_id'] == room_id:
                    info['room_id'] = None
        for ws in room.get('spectators', set()):
            info = clients.get(ws)
            if info and info['room_id'] == room_id:
                info['room_id'] = None


def _format_room_info(room_id, room):
    return {
        'room_id': room_id,
        'players': room['usernames'],
        'spectator_count': len(room.get('spectators', set())),
        'state': room.get('state', 'waiting'),
    }


# ===== HTTP handlers =====

async def handle_register(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({'success': False, 'error': '无效的JSON'}, status=400)

    username = body.get('username', '').strip()
    password = body.get('password', '')
    try:
        ok, err = await _run_db(register, username, password)
    except Exception:
        return web.json_response({'success': False, 'error': '服务器内部错误'}, status=500)
    if ok:
        return web.json_response({'success': True, 'user': {'username': username}})
    return web.json_response({'success': False, 'error': err})


async def handle_login(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({'success': False, 'error': '无效的JSON'}, status=400)

    username = body.get('username', '').strip()
    password = body.get('password', '')
    try:
        ok, result = await _run_db(login, username, password)
    except Exception:
        return web.json_response({'success': False, 'error': '服务器内部错误'}, status=500)
    if ok:
        return web.json_response({'success': True, 'token': result, 'username': username})
    return web.json_response({'success': False, 'error': result})


async def handle_health(request):
    return web.json_response({'status': 'ok'})


async def handle_list_rooms(request):
    """List all waiting rooms for the room browser."""
    now = time.time()
    room_list = []
    for room_id, room in rooms.items():
        if room['state'] == 'waiting' and room['players'][0]:
            created = room.get('_created_at', now)
            room_list.append({
                'room_id': room_id,
                'creator': room['usernames'][0],
                'waiting_seconds': int(now - created),
            })
    return web.json_response({'rooms': room_list})


# ===== WebSocket handler =====

async def handle_ws(request):
    ws = web.WebSocketResponse(max_msg_size=65536)
    await ws.prepare(request)

    # Connection limit check
    if len(clients) >= MAX_CONNECTIONS:
        await _send(ws, {'type': 'error', 'error': '服务器繁忙，请稍后再试'})
        await ws.close()
        return ws

    pending_auth[ws] = time.time()

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                await _on_message(ws, msg.data)
            elif msg.type == web.WSMsgType.ERROR:
                break
    finally:
        await _on_disconnect(ws)

    return ws


async def _on_message(ws, raw):
    # Check auth timeout
    if ws in pending_auth:
        if time.time() - pending_auth[ws] > AUTH_TIMEOUT:
            await _send(ws, {'type': 'error', 'error': '认证超时'})
            await ws.close()
            return

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        await _send(ws, {'type': 'error', 'error': '无效的消息格式'})
        return

    msg_type = data.get('type', '')

    # auth must be first message
    if msg_type == 'auth':
        await _handle_auth(ws, data.get('token', ''))
        return

    # All other messages require authentication
    if ws not in clients:
        await _send(ws, {'type': 'error', 'error': '请先发送认证消息'})
        return

    handlers = {
        'match': lambda: _handle_match(ws),
        'cancel_match': lambda: _handle_cancel_match(ws),
        'create_room': lambda: _handle_create_room(ws),
        'join_room': lambda: _handle_join_room(ws, data.get('room_id', ''), data.get('as_spectator', False)),
        'leave_room': lambda: _handle_leave_room(ws),
        'move': lambda: _handle_move(ws, int(data['x']), int(data['y'])),
        'chat': lambda: _handle_chat(ws, data.get('message', '')),
    }

    handler = handlers.get(msg_type)
    if handler:
        await handler()
    else:
        await _send(ws, {'type': 'error', 'error': f'未知消息类型: {msg_type}'})


async def _handle_auth(ws, token):
    username = verify_token(token)
    if not username:
        await _send(ws, {'type': 'error', 'error': 'Token无效或已过期'})
        await ws.close()
        return

    pending_auth.pop(ws, None)
    clients[ws] = {'username': username, 'room_id': None, 'authenticated': True}
    await _send(ws, {'type': 'auth_ok', 'username': username})


async def _handle_match(ws):
    info = clients.get(ws)
    if not info or info['room_id']:
        return

    if len(rooms) >= MAX_ROOMS:
        await _send(ws, {'type': 'error', 'error': '服务器繁忙，请稍后再试'})
        return

    if waiting_queue:
        # Find a valid opponent (skip disconnected clients)
        opponent = None
        for candidate in list(waiting_queue.keys()):
            del waiting_queue[candidate]
            if candidate in clients:
                opponent = candidate
                break
        if not opponent:
            waiting_queue[ws] = True
            await _send(ws, {'type': 'waiting', 'message': '等待对手...'})
            return

        o_info = clients.get(opponent)
        if not o_info:
            waiting_queue[ws] = True
            await _send(ws, {'type': 'waiting', 'message': '等待对手...'})
            return

        # Create room for matched pair
        room_id = _generate_room_id()
        rooms[room_id] = {
            'players': [opponent, ws],
            'usernames': [o_info['username'], info['username']],
            'spectators': set(),
            'board': make_board(),
            'current_player': 1,
            'moves': [],
            'state': 'playing',
            'creator': opponent,
            'matchmade': True,
            '_created_at': time.time(),
        }
        info['room_id'] = room_id
        o_info['room_id'] = room_id

        await _send(opponent, {
            'type': 'start', 'color': 1,
            'message': '您执黑（先手）',
            'room_id': room_id,
            'usernames': [o_info['username'], info['username']],
        })
        await _send(ws, {
            'type': 'start', 'color': 2,
            'message': '您执白（后手），黑棋先走',
            'room_id': room_id,
            'usernames': [o_info['username'], info['username']],
        })
        await _send(opponent, {'type': 'turn', 'color': 1})
        await _start_timer(room_id)
    else:
        waiting_queue[ws] = True
        await _send(ws, {'type': 'waiting', 'message': '等待对手...'})


async def _handle_cancel_match(ws):
    if ws in waiting_queue:
        del waiting_queue[ws]
    await _send(ws, {'type': 'match_cancelled', 'message': '已取消匹配'})


async def _handle_create_room(ws):
    info = clients.get(ws)
    if not info:
        return
    if info['room_id']:
        await _send(ws, {'type': 'error', 'error': '您已在房间中'})
        return
    if len(rooms) >= MAX_ROOMS:
        await _send(ws, {'type': 'error', 'error': '服务器房间已满，请稍后再试'})
        return

    room_id = _generate_room_id()
    rooms[room_id] = {
        'players': [ws, None],
        'usernames': [info['username'], None],
        'spectators': set(),
        'board': make_board(),
        'current_player': 1,
        'moves': [],
        'state': 'waiting',
        'creator': ws,
        'matchmade': False,
        '_created_at': time.time(),
    }
    info['room_id'] = room_id

    await _send(ws, {'type': 'room_created', 'room_id': room_id})
    await _send(ws, {'type': 'waiting', 'message': f'房间 {room_id} 已创建，等待对手加入...'})


async def _handle_join_room(ws, room_id, as_spectator):
    info = clients.get(ws)
    if not info:
        return
    if info['room_id']:
        await _send(ws, {'type': 'error', 'error': '您已在房间中'})
        return

    room = rooms.get(room_id)
    if not room:
        await _send(ws, {'type': 'error', 'error': f'房间 {room_id} 不存在'})
        return

    # Spectator mode: if explicitly requested, or room is not in waiting state
    if as_spectator or room['state'] != 'waiting':
        # Spectator mode
        room.setdefault('spectators', set()).add(ws)
        info['room_id'] = room_id
        await _send(ws, {
            'type': 'room_joined',
            'room_id': room_id,
            'as_spectator': True,
            'players': room['usernames'],
            'state': room['state'],
            'spectator_count': len(room['spectators']),
        })

        # Send current board state to spectator
        if room['state'] == 'playing' or room['state'] == 'finished':
            for move in room.get('moves', []):
                await _send(ws, {'type': 'move', 'x': move[0], 'y': move[1], 'color': move[2]})
            if room['state'] == 'playing':
                await _send(ws, {'type': 'turn', 'color': room['current_player']})
            if room['state'] == 'finished':
                await _send(ws, {'type': 'game_over', 'winner': '游戏已结束'})

        await _broadcast_room(room_id, {
            'type': 'spectator_count',
            'count': len(room['spectators']),
            'username': info['username'],
        })
        return

    # Join as player
    slot = 0 if room['players'][0] is None else 1
    room['players'][slot] = ws
    room['usernames'][slot] = info['username']
    info['room_id'] = room_id

    await _send(ws, {
        'type': 'room_joined',
        'room_id': room_id,
        'as_spectator': False,
        'players': room['usernames'],
        'state': room['state'],
    })

    # Notify the other player
    other_idx = 1 - slot
    await _broadcast_to_player(room, other_idx, {
        'type': 'player_joined', 'username': info['username']
    })

    # If both players present, start the game
    if room['players'][0] is not None and room['players'][1] is not None:
        room['state'] = 'playing'
        room['board'] = make_board()
        room['current_player'] = 1
        room['moves'] = []

        await _broadcast_to_player(room, 0, {
            'type': 'start', 'color': 1,
            'message': '您执黑（先手）',
            'room_id': room_id,
            'usernames': room['usernames'],
        })
        await _broadcast_to_player(room, 1, {
            'type': 'start', 'color': 2,
            'message': '您执白（后手），黑棋先走',
            'room_id': room_id,
            'usernames': room['usernames'],
        })
        await _broadcast_to_player(room, 0, {'type': 'turn', 'color': 1})
        await _start_timer(room_id)

        # Notify spectators
        for s in room.get('spectators', set()):
            await _send(s, {'type': 'chat', 'username': '系统', 'message': '对局已开始！'})


async def _handle_leave_room(ws):
    info = clients.get(ws)
    if not info or not info['room_id']:
        await _send(ws, {'type': 'error', 'error': '您不在房间中'})
        return

    room_id = info['room_id']
    room = rooms.get(room_id)
    if not room:
        info['room_id'] = None
        return

    username = info['username']
    info['room_id'] = None

    # Check if spectator
    spectators = room.get('spectators', set())
    if ws in spectators:
        spectators.discard(ws)
        await _broadcast_room(room_id, {
            'type': 'spectator_count',
            'count': len(spectators),
            'username': username,
        })
        return

    # Check if player
    player_idx = None
    for i, p in enumerate(room['players']):
        if p == ws:
            player_idx = i
            room['players'][i] = None
            room['usernames'][i] = None
            break

    if player_idx is None:
        return

    # Notify others
    await _broadcast_room(room_id, {
        'type': 'player_left',
        'username': username,
    })

    other_idx = 1 - player_idx
    if room['players'][other_idx] and room['state'] == 'playing':
        # The game was in progress, other player wins
        room['state'] = 'finished'
        await _cancel_timer(room_id)
        winner_username = room['usernames'][other_idx] or '对手'
        await _broadcast_to_player(room, other_idx, {
            'type': 'game_over', 'winner': winner_username, 'reason': '对方离开了房间'
        })
        _cleanup_room(room_id)
    else:
        # Clean up if room is empty
        if room['players'][0] is None and room['players'][1] is None:
            _cleanup_room(room_id)


async def _handle_move(ws, x, y):
    info = clients.get(ws)
    if not info or not info['room_id']:
        await _send(ws, {'type': 'error', 'error': '您不在对局中'})
        return

    room_id = info['room_id']
    room = rooms.get(room_id)
    if not room or room['state'] != 'playing':
        await _send(ws, {'type': 'error', 'error': '对局未开始或已结束'})
        return

    if x < 0 or x >= BOARD_SIZE or y < 0 or y >= BOARD_SIZE:
        await _send(ws, {'type': 'error', 'error': '坐标超出范围'})
        return

    if room['board'][y][x] != 0:
        await _send(ws, {'type': 'error', 'error': '该位置已有棋子'})
        return

    if room['players'][0] == ws:
        player_idx = 0
    elif room['players'][1] == ws:
        player_idx = 1
    else:
        await _send(ws, {'type': 'error', 'error': '您不是对局玩家'})
        return

    color = 1 if player_idx == 0 else 2
    if room['current_player'] != color:
        await _send(ws, {'type': 'error', 'error': '还没轮到您'})
        return

    # Place piece
    room['board'][y][x] = color
    room['current_player'] = 2 if color == 1 else 1
    room['moves'].append((x, y, color))

    # Cancel timer, will restart after broadcast
    await _cancel_timer(room_id)

    # Broadcast move
    await _broadcast_room(room_id, {'type': 'move', 'x': x, 'y': y, 'color': color})

    # Check winner
    winner = check_winner_on_board(room['board'])
    if winner:
        room['state'] = 'finished'
        winner_username = room['usernames'][player_idx]
        for i, p in enumerate(room['players']):
            if p:
                await _send(p, {
                    'type': 'game_over',
                    'winner': winner_username,
                    'reason': '五子连珠',
                    'moves': room['moves'],
                })
        for s in room.get('spectators', set()):
            await _send(s, {'type': 'game_over', 'winner': winner_username, 'reason': '五子连珠'})
        await _broadcast_room(room_id, {
            'type': 'chat', 'username': '系统', 'message': f'{winner_username} 获胜（五子连珠）！'
        })
        _cleanup_room(room_id)
    else:
        # Check for draw (board full)
        if len(room['moves']) >= BOARD_SIZE * BOARD_SIZE:
            room['state'] = 'finished'
            for p in room['players']:
                if p:
                    await _send(p, {'type': 'game_over', 'winner': '平局', 'reason': '棋盘已满'})
            _cleanup_room(room_id)
            return

        # Notify next turn
        next_color = room['current_player']
        next_idx = 0 if next_color == 1 else 1
        await _broadcast_to_player(room, next_idx, {'type': 'turn', 'color': next_color})
        await _start_timer(room_id)


async def _handle_chat(ws, message):
    info = clients.get(ws)
    if not info or not info['room_id']:
        return

    if not message or len(message.strip()) == 0:
        return
    if len(message) > 200:
        message = message[:200]

    room = rooms.get(info['room_id'])
    if not room:
        return

    await _broadcast_room(info['room_id'], {
        'type': 'chat',
        'username': info['username'],
        'message': message.strip(),
    })


async def _periodic_cleanup(app):
    """Periodic cleanup of stale state (runs every 60s)."""
    while True:
        await asyncio.sleep(60)
        now = time.time()

        # Clean stale pending auth connections
        stale_auth = [ws for ws, t in list(pending_auth.items()) if now - t > AUTH_TIMEOUT]
        for ws in stale_auth:
            pending_auth.pop(ws, None)
            try:
                await ws.close()
            except Exception:
                pass

        # Clean old rate limit entries
        for ip in list(_ratelimit.keys()):
            _ratelimit[ip] = [t for t in _ratelimit[ip] if now - t < _RATELIMIT_WINDOW]
            if not _ratelimit[ip]:
                del _ratelimit[ip]

        # Clean stale waiting rooms (> 5 min)
        stale_rooms = [rid for rid, r in list(rooms.items())
                       if r.get('state') == 'waiting'
                       and now - r.get('_created_at', now) > ROOM_WAIT_TIMEOUT]
        for rid in stale_rooms:
            room = rooms.get(rid)
            if room:
                creator = room.get('players', [None])[0]
                if creator:
                    await _send(creator, {'type': 'error', 'error': '房间已超时'})
                _cleanup_room(rid)

        # Clean empty waiting queue entries (disconnected clients)
        stale_queue = [ws for ws in waiting_queue if ws not in clients]
        for ws in stale_queue:
            del waiting_queue[ws]


async def _on_disconnect(ws):
    if ws in pending_auth:
        pending_auth.pop(ws, None)
        return

    if ws in waiting_queue:
        del waiting_queue[ws]

    # Leave room if in one
    if ws in clients:
        await _handle_leave_room(ws)

    clients.pop(ws, None)


# ===== Middleware =====

@web.middleware
async def rate_limit_middleware(request, handler):
    ip = request.remote
    if ip and not _check_ratelimit(ip):
        return web.json_response({'success': False, 'error': '请求过于频繁，请稍后再试'}, status=429)
    return await handler(request)


@web.middleware
async def cors_middleware(request, handler):
    if request.method == 'OPTIONS':
        response = web.Response()
    else:
        response = await handler(request)
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    return response


# ===== Main =====

def main():
    port = int(os.getenv('PORT', '8080'))

    print("检查数据库连接...")
    try:
        init_db()
        print("数据库初始化成功")
    except Exception as e:
        print(f"数据库初始化失败: {e}")
        return

    print("游戏引擎已就绪")

    app = web.Application(middlewares=[rate_limit_middleware, cors_middleware])
    app.router.add_post('/register', handle_register)
    app.router.add_post('/login', handle_login)
    app.router.add_get('/health', handle_health)
    app.router.add_get('/api/rooms', handle_list_rooms)
    app.router.add_get('/ws', handle_ws)

    # Periodic cleanup task (fire-and-forget, don't await the infinite loop)
    async def _start_cleanup(app):
        asyncio.create_task(_periodic_cleanup(app))

    app.on_startup.append(_start_cleanup)

    async def _on_shutdown(app):
        """Cancel all pending timer tasks on shutdown."""
        for task in _timer_tasks.values():
            task.cancel()
        _timer_tasks.clear()
        # Clean up any remaining state
        for ws in list(pending_auth.keys()):
            try:
                await ws.close()
            except Exception:
                pass
        pending_auth.clear()
        rooms.clear()
        clients.clear()
        waiting_queue.clear()

    app.on_shutdown.append(_on_shutdown)

    print(f"服务器启动，监听端口 {port}")
    web.run_app(app, host='0.0.0.0', port=port)


if __name__ == '__main__':
    main()
