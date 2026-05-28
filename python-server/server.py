import json
import logging
import os
import asyncio
import secrets
import time
import random
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict, OrderedDict

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(name)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
)
logger = logging.getLogger('gobang')

from aiohttp import web
from dotenv import load_dotenv

# Must load .env BEFORE importing auth — auth reads JWT_SECRET at module level
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

from db import (init_db, execute_query, check_env, save_game,
    get_user_games, get_game_moves, get_user_stats,
    init_active_games_table, save_active_game, update_active_game,
    delete_active_game, get_user_session, clear_user_session,
    load_active_games,
    update_display_name as db_update_display_name)
from auth import register, login, verify_token
from game_engine import check_winner_on_board, check_forbidden_on_board, make_board, board_to_list, BOARD_SIZE
import re

_DISPLAY_NAME_RE = re.compile(r'^[\w一-鿿]{2,20}$')

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

# Per-connection WebSocket message rate limiting
_ws_ratelimit = defaultdict(list)
_WS_RATELIMIT_MAX = 20  # max messages per second
_WS_RATELIMIT_WINDOW = 1.0

# Timer tasks
_timer_tasks = {}     # room_id -> asyncio.Task
_rematch_tasks = {}   # room_id -> asyncio.Task (delayed cleanup after game end)
_disconnect_grace = {}  # (username, session_id) -> {'task': asyncio.Task, 'ws': ws, 'room_id': str|None}
_GRACE_PERIOD = 5  # seconds
_cleanup_task = None  # periodic cleanup task

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


def _submit_db(fn, *args):
    """Submit a DB task to the executor with error logging."""
    def _done(fut):
        try:
            fut.result()
        except Exception as e:
            logger.error(f"DB task {fn.__name__} failed: {e}", exc_info=True)
    fut = _executor.submit(fn, *args)
    fut.add_done_callback(_done)
    return fut


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
        room['_winner'] = winner_idx
        await _broadcast_room(room_id, {'type': 'game_over', 'winner': winner_username, 'reason': '对方超时'})
        await _broadcast_room(room_id, {'type': 'chat', 'username': '系统', 'message': f'{winner_username}获胜（对方超时）'})
        _save_game_record(room_id, winner_username, '对方超时')
        _submit_db(delete_active_game, room_id)
        _start_rematch_timer(room_id)
    except asyncio.CancelledError:
        pass


def _save_game_record(room_id, winner_username, reason):
    """Persist finished game to database (fire-and-forget)."""
    room = rooms.get(room_id)
    if not room or not room.get('moves'):
        return
    accounts = room.get('accounts', room.get('usernames', []))
    usernames = room.get('usernames', [])
    black = accounts[0] if len(accounts) > 0 else None
    white = accounts[1] if len(accounts) > 1 else None
    # Resolve winner display name → account for DB consistency
    winner_account = winner_username
    if winner_username != '平局' and winner_username in usernames:
        idx = usernames.index(winner_username)
        if idx < len(accounts):
            winner_account = accounts[idx]
    moves_snapshot = list(room.get('moves', []))  # copy before submitting to executor
    moves = list(enumerate(moves_snapshot, 1))
    move_rows = [(i, m[0], m[1], m[2]) for i, m in moves]
    _submit_db(save_game, room_id, black, white, winner_account, reason, move_rows)


def _cleanup_room(room_id):
    """Remove room and reset connected clients."""
    t = _timer_tasks.pop(room_id, None)
    if t:
        t.cancel()
    t = _rematch_tasks.pop(room_id, None)
    if t:
        t.cancel()
    room = rooms.pop(room_id, None)
    _submit_db(delete_active_game, room_id)
    if room:
        # Notify spectators before cleanup (fire-and-forget, suppress task warnings)
        for ws in room.get('spectators', set()):
            t = asyncio.ensure_future(_send(ws, {'type': 'room_closed', 'message': '房间已关闭'}))
            t.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
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


def _get_auth_user(request):
    """Extract authenticated username from Authorization header. Returns None if invalid."""
    auth = request.headers.get('Authorization', '')
    if not auth.startswith('Bearer '):
        return None
    username, _ = verify_token(auth[7:])
    return username


# ===== HTTP handlers =====

async def handle_register(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({'success': False, 'error': '无效的JSON'}, status=400)

    account = body.get('account', '').strip()
    display_name = body.get('display_name', '').strip()
    password = body.get('password', '')
    try:
        ok, err = await _run_db(register, account, display_name, password)
    except Exception as e:
        logger.error(f"注册失败: {e}", exc_info=True)
        return web.json_response({'success': False, 'error': '服务器内部错误'}, status=500)
    if ok:
        return web.json_response({'success': True, 'user': {'account': account, 'display_name': display_name}})
    return web.json_response({'success': False, 'error': err})


async def handle_login(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({'success': False, 'error': '无效的JSON'}, status=400)

    account = body.get('account', '').strip()
    password = body.get('password', '')
    try:
        ok, result = await _run_db(login, account, password)
    except Exception as e:
        logger.error(f"登录失败: {e}", exc_info=True)
        return web.json_response({'success': False, 'error': '服务器内部错误'}, status=500)
    if ok:
        token, display_name = result
        return web.json_response({'success': True, 'token': token, 'account': account, 'display_name': display_name})
    return web.json_response({'success': False, 'error': result})


async def handle_health(request):
    return web.json_response({'status': 'ok'})


async def handle_list_rooms(request):
    """List all rooms (waiting + playing) for the room browser."""
    now = time.time()
    room_list = []
    for room_id, room in rooms.items():
        if room['state'] in ('waiting', 'playing') and room['players'][0]:
            if not room.get('is_public', False):
                continue
            spectators = len(room.get('spectators', set()))
            room_list.append({
                'room_id': room_id,
                'creator': room['usernames'][0],
                'players': [u for u in room.get('usernames', []) if u],
                'state': room['state'],
                'spectator_count': spectators,
                'is_public': room.get('is_public', False),
                'waiting_seconds': int(now - room.get('_created_at', now)) if room['state'] == 'waiting' else 0,
            })
    return web.json_response({'rooms': room_list})


async def handle_games(request):
    """Get game history for a user (requires auth)."""
    username = _get_auth_user(request)
    if not username:
        return web.json_response({'error': '未登录'}, status=401)
    try:
        games = await _run_db(get_user_games, username)
        result = []
        for g in (games or []):
            result.append({
                'id': g['id'],
                'room_id': g['room_id'],
                'black_username': g['black_username'],
                'white_username': g['white_username'],
                'winner': g['winner'],
                'reason': g['reason'],
                'total_moves': g['total_moves'],
                'created_at': g['created_at'].isoformat() if hasattr(g['created_at'], 'isoformat') else str(g['created_at']),
            })
        return web.json_response({'games': result})
    except Exception as e:
        logger.error(f"查询对局记录失败: {e}", exc_info=True)
        return web.json_response({'games': []})


async def handle_game_detail(request):
    """Get full game detail with moves (requires auth)."""
    if not _get_auth_user(request):
        return web.json_response({'error': '未登录'}, status=401)
    game_id = request.match_info.get('id', '')
    if not game_id or not game_id.isdigit():
        return web.json_response({'error': '无效的游戏ID'}, status=400)
    try:
        moves = await _run_db(get_game_moves, int(game_id))
        return web.json_response({'moves': moves or []})
    except Exception as e:
        logger.error(f"查询棋谱详情失败: {e}", exc_info=True)
        return web.json_response({'moves': []})


async def handle_profile(request):
    """Get user profile and stats (requires auth)."""
    account = _get_auth_user(request)
    if not account:
        return web.json_response({'error': '未登录'}, status=401)
    try:
        stats = await _run_db(get_user_stats, account)
        display_name = await _run_db(_get_display_name, account)
        return web.json_response({
            'account': account,
            'display_name': display_name or account,
            'total_games': stats['total'] if stats else 0,
            'wins': stats['wins'] if stats else 0,
        })
    except Exception as e:
        logger.error(f"查询用户统计失败: {e}", exc_info=True)
        return web.json_response({'account': account, 'display_name': account, 'total_games': 0, 'wins': 0})


def _get_display_name(account):
    rows = execute_query("SELECT display_name FROM users WHERE account = %s", (account,))
    return rows[0]['display_name'] if rows else None


async def handle_update_profile(request):
    """Update display_name for the authenticated user."""
    # Verify JWT from Authorization header
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return web.json_response({'success': False, 'error': '未登录'}, status=401)
    account, _ = verify_token(auth_header[7:])
    if not account:
        return web.json_response({'success': False, 'error': 'Token无效或已过期'}, status=401)

    try:
        body = await request.json()
    except Exception:
        return web.json_response({'success': False, 'error': '无效的JSON'}, status=400)

    new_name = body.get('display_name', '').strip()
    if not new_name:
        return web.json_response({'success': False, 'error': '参数不完整'}, status=400)
    if not _DISPLAY_NAME_RE.match(new_name):
        return web.json_response({'success': False, 'error': '用户名仅支持中英文、数字、下划线，2-20个字符'}, status=400)

    try:
        ok = await _run_db(db_update_display_name, account, new_name)
        if ok:
            # Update in-memory clients display name
            for ws, info in clients.items():
                if info['username'] == account:
                    info['display_name'] = new_name
            return web.json_response({'success': True, 'display_name': new_name})
        return web.json_response({'success': False, 'error': '用户名已被占用'})
    except Exception as e:
        logger.error(f"更新用户名失败: {e}", exc_info=True)
        return web.json_response({'success': False, 'error': '服务器内部错误'}, status=500)


# ===== WebSocket handler =====

async def handle_ws(request):
    ws = web.WebSocketResponse(max_msg_size=65536, heartbeat=30, receive_timeout=60)
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
    # WebSocket rate limiting
    now = time.time()
    bucket = _ws_ratelimit[id(ws)]
    bucket[:] = [t for t in bucket if now - t < _WS_RATELIMIT_WINDOW]
    if len(bucket) >= _WS_RATELIMIT_MAX:
        return
    bucket.append(now)

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
        'create_room': lambda: _handle_create_room(ws, data.get('is_public', False)),
        'join_room': lambda: _handle_join_room(ws, data.get('room_id', ''), data.get('as_spectator', False)),
        'leave_room': lambda: _handle_leave_room(ws),
        'move': lambda: _handle_move(ws, data.get('x'), data.get('y')),
        'chat': lambda: _handle_chat(ws, data.get('message', '')),
        'request_undo': lambda: _handle_request_undo(ws),
        'undo_response': lambda: _handle_undo_response(ws, data.get('accept', False)),
        'resign': lambda: _handle_resign(ws),
        'rematch': lambda: _handle_rematch(ws),
    }

    handler = handlers.get(msg_type)
    if handler:
        await handler()
    else:
        await _send(ws, {'type': 'error', 'error': f'未知消息类型: {msg_type}'})


async def _handle_auth(ws, token):
    username, session_id = verify_token(token)
    if not username:
        await _send(ws, {'type': 'error', 'error': 'Token无效或已过期'})
        await ws.close()
        return

    # Look up display_name from database
    display_name = None
    try:
        rows = await _run_db(execute_query, "SELECT display_name FROM users WHERE account = %s", (username,))
        if rows:
            display_name = rows[0]['display_name']
    except Exception:
        pass
    if not display_name:
        display_name = username

    # Kick existing connection with different session_id
    to_kick = []
    for existing_ws, info in list(clients.items()):
        if info['username'] == username and info.get('session_id') != session_id:
            to_kick.append(existing_ws)
    for old_ws in to_kick:
        # Remove from waiting queue if present
        waiting_queue.pop(old_ws, None)
        # Clean up room/game state before disconnecting
        try:
            await _handle_leave_room(old_ws)
        except Exception:
            pass
        # Pop before close so _on_disconnect skips this connection
        clients.pop(old_ws, None)
        try:
            await _send(old_ws, {'type': 'kicked', 'message': '账号在其他设备登录'})
            await old_ws.close()
        except Exception:
            pass

    pending_auth.pop(ws, None)
    # Cancel any pending disconnect grace period for this session
    key = (username, session_id)
    grace = _disconnect_grace.pop(key, None)
    if grace:
        grace['task'].cancel()

    # Only transfer state from grace-period (disconnected) connections, never
    # from active clients which belong to another tab.  Otherwise refreshing one
    # tab would steal the room from an active tab with the same session.
    transferred_room_id = None
    old_ws = None
    if grace:
        old_ws = grace.get('ws')
        transferred_room_id = grace.get('room_id')

    if old_ws and old_ws != ws:
        clients.pop(old_ws, None)
        # Replace old ws references in waiting_queue
        if waiting_queue.pop(old_ws, None) is not None:
            waiting_queue[ws] = True
        if transferred_room_id and transferred_room_id in rooms:
            room = rooms[transferred_room_id]
            for i, p in enumerate(room.get('players', [])):
                if p is old_ws:
                    room['players'][i] = ws
            if old_ws in room.get('spectators', set()):
                room['spectators'].discard(old_ws)
                room['spectators'].add(ws)
            if room.get('creator') is old_ws:
                room['creator'] = ws
        try:
            await old_ws.close()
        except Exception:
            pass

    clients[ws] = {
        'username': username,
        'display_name': display_name,
        'room_id': transferred_room_id,
        'authenticated': True,
        'session_id': session_id,
    }
    await _send(ws, {'type': 'auth_ok', 'username': username, 'display_name': display_name})

    # If reconnected to an active room, sync state to the client
    if transferred_room_id and transferred_room_id in rooms:
        room = rooms[transferred_room_id]
        if room['state'] in ('waiting', 'playing'):
            player_idx = None
            for i, p in enumerate(room.get('players', [])):
                if p is ws:
                    player_idx = i
                    break
            if player_idx is not None:
                if room['state'] == 'waiting':
                    # Host reconnecting to a waiting room
                    await _send(ws, {'type': 'room_created', 'room_id': transferred_room_id})
                    await _send(ws, {'type': 'waiting', 'message': f'房间 {transferred_room_id} 已创建，等待对手加入...'})
                else:
                    color = 1 if player_idx == 0 else 2
                    await _send(ws, {
                        'type': 'start', 'color': color,
                        'message': f'您执{"黑" if color == 1 else "白"}',
                        'room_id': transferred_room_id,
                        'usernames': room['usernames'],
                    })
                    # Replay moves on new client
                    for move in room.get('moves', []):
                        await _send(ws, {'type': 'move', 'x': move[0], 'y': move[1], 'color': move[2]})
                    await _send(ws, {'type': 'turn', 'color': room['current_player']})
            else:
                # Spectator reconnecting
                await _send(ws, {
                    'type': 'room_joined',
                    'room_id': transferred_room_id,
                    'as_spectator': True,
                    'players': room['usernames'],
                    'state': room['state'],
                    'spectator_count': len(room.get('spectators', set())),
                })
                for move in room.get('moves', []):
                    await _send(ws, {'type': 'move', 'x': move[0], 'y': move[1], 'color': move[2]})
                if room['state'] == 'playing':
                    await _send(ws, {'type': 'turn', 'color': room['current_player']})


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
            if candidate != ws and candidate in clients:
                waiting_queue.pop(candidate, None)
                opponent = candidate
                break
            # Candidate is stale — clean it up
            waiting_queue.pop(candidate, None)
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
        od = o_info.get('display_name', o_info['username'])
        md = info.get('display_name', info['username'])
        oa = o_info['username']
        ma = info['username']
        rooms[room_id] = {
            'players': [opponent, ws],
            'usernames': [od, md],
            'accounts': [oa, ma],
            'spectators': set(),
            'board': make_board(),
            'current_player': 1,
            'moves': [],
            'state': 'playing',
            'creator': opponent,
            'matchmade': True,
            'is_public': False,
            '_created_at': time.time(),
        }
        info['room_id'] = room_id
        o_info['room_id'] = room_id

        await _send(opponent, {
            'type': 'start', 'color': 1,
            'message': '您执黑（先手）',
            'room_id': room_id,
            'usernames': [od, md],
        })
        await _send(ws, {
            'type': 'start', 'color': 2,
            'message': '您执白（后手），黑棋先走',
            'room_id': room_id,
            'usernames': [od, md],
        })
        await _send(opponent, {'type': 'turn', 'color': 1})
        await _start_timer(room_id)
        # Persist active game
        _submit_db(save_active_game, room_id,
                         o_info['username'], info['username'],
                         board_to_list(rooms[room_id]['board']), 1, [])
    else:
        waiting_queue[ws] = True
        await _send(ws, {'type': 'waiting', 'message': '等待对手...'})


async def _handle_cancel_match(ws):
    waiting_queue.pop(ws, None)
    await _send(ws, {'type': 'match_cancelled', 'message': '已取消匹配'})


async def _handle_create_room(ws, is_public=False):
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
        'usernames': [info.get('display_name', info['username']), None],
        'accounts': [info['username'], None],
        'spectators': set(),
        'board': make_board(),
        'current_player': 1,
        'moves': [],
        'state': 'waiting',
        'creator': ws,
        'matchmade': False,
        'is_public': is_public,
        '_created_at': time.time(),
    }
    waiting_queue.pop(ws, None)
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
        if room['state'] in ('playing', 'finished'):
            for move in room.get('moves', []):
                await _send(ws, {'type': 'move', 'x': move[0], 'y': move[1], 'color': move[2]})
            if room['state'] == 'playing':
                await _send(ws, {'type': 'turn', 'color': room['current_player']})
            if room['state'] == 'finished':
                w_idx = room.get('_winner')
                if w_idx is not None and w_idx >= 0 and w_idx < len(room.get('usernames', [])):
                    winner_name = room['usernames'][w_idx]
                elif w_idx == -1:
                    winner_name = '平局'
                else:
                    winner_name = '游戏已结束'
                await _send(ws, {'type': 'game_over', 'winner': winner_name, 'reason': '对局已结束'})

        await _broadcast_room(room_id, {
            'type': 'spectator_count',
            'count': len(room['spectators']),
            'username': info['username'],
        })
        return

    # Join as player
    waiting_queue.pop(ws, None)
    slot = 0 if room['players'][0] is None else 1
    room['players'][slot] = ws
    room['usernames'][slot] = info.get('display_name', info['username'])
    room['accounts'][slot] = info['username']
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
        'type': 'player_joined', 'username': info.get('display_name', info['username'])
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

        # Persist active game for crash recovery
        _submit_db(save_active_game, room_id,
                   room['accounts'][0], room['accounts'][1],
                   board_to_list(room['board']), 1, [])

        # Notify spectators
        for s in room.get('spectators', set()):
            await _send(s, {'type': 'chat', 'username': '系统', 'message': '对局已开始！'})


async def _handle_leave_room(ws):
    info = clients.get(ws)
    if not info or not info['room_id']:
        await _send(ws, {'type': 'error', 'error': '您不在房间中'})
        return

    # Clean up any lingering matchmaking state
    waiting_queue.pop(ws, None)

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
            if room.get('accounts'):
                room['accounts'][i] = None
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
        room['_winner'] = other_idx
        winner_username = room['usernames'][other_idx] or '对手'
        # Save BEFORE any await to prevent room cleanup race
        _save_game_record(room_id, winner_username, '对方离开了房间')
        await _cancel_timer(room_id)
        await _broadcast_room(room_id, {
            'type': 'game_over', 'winner': winner_username, 'reason': '对方离开了房间'
        })
        _cleanup_room(room_id)
    else:
        # Clean up if room is empty
        if room['players'][0] is None and room['players'][1] is None:
            _cleanup_room(room_id)


async def _handle_move(ws, x, y):
    try:
        x = int(x)
        y = int(y)
    except (ValueError, TypeError):
        await _send(ws, {'type': 'error', 'error': '无效的坐标格式'})
        return

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

    # Forbidden move check for black (Renju rules)
    if color == 1:
        forbid = check_forbidden_on_board(room['board'], x, y)
        if forbid != 0:
            reasons = {1: '禁手：双活三', 2: '禁手：双四', 3: '禁手：长连'}
            await _send(ws, {'type': 'error', 'error': reasons.get(forbid, '禁手')})
            return

    # Place piece (defer current_player flip until after broadcast)
    room['board'][y][x] = color
    room['moves'].append((x, y, color))
    next_color = 2 if color == 1 else 1

    # Persist updated game state
    _submit_db(update_active_game, room_id,
                     board_to_list(room['board']),
                     next_color,
                     list(room['moves']))

    # Cancel timer, will restart after broadcast
    await _cancel_timer(room_id)

    # Broadcast move
    await _broadcast_room(room_id, {'type': 'move', 'x': x, 'y': y, 'color': color})

    # Check winner (only around the last placed piece)
    winner, win_line = check_winner_on_board(room['board'], x, y)
    if winner:
        if winner != color:
            logger.error(f"Winner color mismatch: C returned {winner}, expected {color} at ({x},{y})")
        room['state'] = 'finished'
        room['_winner'] = player_idx
        winner_username = room['usernames'][player_idx] or info.get('display_name', info['username'])
        game_over_msg = {
            'type': 'game_over',
            'winner': winner_username,
            'reason': '五子连珠',
            'moves': room['moves'],
            'win_line': win_line,
        }
        for i, p in enumerate(room['players']):
            if p:
                await _send(p, game_over_msg)
        for s in room.get('spectators', set()):
            await _send(s, game_over_msg)
        await _broadcast_room(room_id, {
            'type': 'chat', 'username': '系统', 'message': f'{winner_username} 获胜（五子连珠）！'
        })
        _save_game_record(room_id, winner_username, '五子连珠')
        _submit_db(delete_active_game, room_id)
        _start_rematch_timer(room_id)
    else:
        # Flip current_player AFTER broadcast to prevent turn race
        room['current_player'] = next_color

        # Check for draw (board full)
        if len(room['moves']) >= BOARD_SIZE * BOARD_SIZE:
            room['state'] = 'finished'
            room['_winner'] = -1
            await _broadcast_room(room_id, {'type': 'game_over', 'winner': '平局', 'reason': '棋盘已满'})
            _save_game_record(room_id, '平局', '棋盘已满')
            _submit_db(delete_active_game, room_id)
            _start_rematch_timer(room_id)
            return

        # Notify next turn
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
        'username': info.get('display_name', info['username']),
        'message': message.strip(),
    })


async def _handle_request_undo(ws):
    info = clients.get(ws)
    if not info or not info['room_id']:
        return

    room_id = info['room_id']
    room = rooms.get(room_id)
    if not room or room['state'] != 'playing':
        return

    if room['players'][0] == ws:
        player_idx = 0
    elif room['players'][1] == ws:
        player_idx = 1
    else:
        return

    # Can only request undo on your own turn
    color = 1 if player_idx == 0 else 2
    if room['current_player'] != color:
        await _send(ws, {'type': 'error', 'error': '只能在自己回合请求悔棋'})
        return

    # Need at least 2 moves to undo
    if len(room['moves']) < 2:
        await _send(ws, {'type': 'error', 'error': '暂无棋子可悔'})
        return

    # Limit undo requests to 3 per player per game
    undo_key = f'_undo_count_{player_idx}'
    count = room.setdefault(undo_key, 0)
    if count >= 3:
        await _send(ws, {'type': 'error', 'error': '本局悔棋次数已用完（3次）'})
        return

    # Forward request to opponent
    other_idx = 1 - player_idx
    other_ws = room['players'][other_idx]
    if other_ws:
        await _send(other_ws, {
            'type': 'request_undo',
            'from': info.get('display_name', info['username']),
        })


async def _handle_undo_response(ws, accept):
    info = clients.get(ws)
    if not info or not info['room_id']:
        return

    room_id = info['room_id']
    room = rooms.get(room_id)
    if not room or room['state'] != 'playing':
        return

    if room['players'][0] == ws:
        player_idx = 0
    elif room['players'][1] == ws:
        player_idx = 1
    else:
        return

    other_idx = 1 - player_idx
    other_ws = room['players'][other_idx]
    if not other_ws:
        return

    if not accept:
        await _send(other_ws, {
            'type': 'undo_response',
            'accepted': False,
            'message': '对方拒绝了悔棋请求',
        })
        return

    # Validate moves: need at least 2 moves from different players
    moves = room['moves']
    if len(moves) < 2:
        await _send(other_ws, {'type': 'error', 'error': '暂无棋子可悔'})
        return

    last_color = moves[-1][2]
    prev_color = moves[-2][2]

    # Remove opponent's last move and requester's last move
    if last_color != prev_color:
        moves.pop()
        moves.pop()
    else:
        # Edge case: consecutive moves by same color (shouldn't happen, but handle gracefully)
        moves.pop()

    # Rebuild board from scratch with empty board as base
    room['board'] = make_board()
    for mx, my, mc in moves:
        if 0 <= mx < BOARD_SIZE and 0 <= my < BOARD_SIZE:
            room['board'][my][mx] = mc

    # Increment undo count for requester
    undo_key = f'_undo_count_{other_idx}'
    room[undo_key] = room.get(undo_key, 0) + 1

    # Restore turn to the requester (since we removed opponent's and requester's last moves)
    request_color = 1 if other_idx == 0 else 2
    room['current_player'] = request_color

    # Cancel timer, restart for requester
    await _cancel_timer(room_id)

    # Broadcast undo to both players
    await _broadcast_to_player(room, other_idx, {
        'type': 'undo', 'board': board_to_list(room['board']), 'moves': room['moves'],
    })
    await _broadcast_to_player(room, player_idx, {
        'type': 'undo', 'board': board_to_list(room['board']), 'moves': room['moves'],
    })
    for s in room.get('spectators', set()):
        await _send(s, {'type': 'undo', 'board': board_to_list(room['board']), 'moves': room['moves']})

    await _broadcast_to_player(room, other_idx, {'type': 'turn', 'color': request_color})
    await _start_timer(room_id)


async def _handle_resign(ws):
    info = clients.get(ws)
    if not info or not info['room_id']:
        return

    room_id = info['room_id']
    room = rooms.get(room_id)
    if not room or room['state'] != 'playing':
        return

    if room['players'][0] == ws:
        player_idx = 0
    elif room['players'][1] == ws:
        player_idx = 1
    else:
        return

    room['state'] = 'finished'
    room['_winner'] = 1 - player_idx
    await _cancel_timer(room_id)

    other_idx = 1 - player_idx
    winner_username = room['usernames'][other_idx] or '对手'
    loser_username = info.get('display_name', info['username'])

    game_over_msg = {
        'type': 'game_over',
        'winner': winner_username,
        'reason': f'{loser_username} 认输',
    }
    # Save BEFORE any await to prevent room cleanup race
    _save_game_record(room_id, winner_username, '认输')
    _submit_db(delete_active_game, room_id)
    for i, p in enumerate(room['players']):
        if p:
            await _send(p, {**game_over_msg, 'moves': room['moves']})
    for s in room.get('spectators', set()):
        await _send(s, game_over_msg)

    await _broadcast_room(room_id, {
        'type': 'chat', 'username': '系统', 'message': f'{loser_username} 认输，{winner_username} 获胜！'
    })
    _start_rematch_timer(room_id)


async def _start_rematch_timer(room_id):
    """Give players 60 seconds to rematch before cleaning up."""
    # Cancel any existing cleanup task for this room
    old = _rematch_tasks.pop(room_id, None)
    if old:
        old.cancel()

    async def _delayed_cleanup():
        try:
            await asyncio.sleep(60)
            room = rooms.get(room_id)
            if room and room['state'] == 'finished':
                _cleanup_room(room_id)
        except asyncio.CancelledError:
            pass

    _rematch_tasks[room_id] = asyncio.create_task(_delayed_cleanup())


async def _handle_rematch(ws):
    """Handle rematch request from a player."""
    info = clients.get(ws)
    if not info or not info['room_id']:
        return

    room_id = info['room_id']
    room = rooms.get(room_id)
    if not room or room['state'] != 'finished':
        await _send(ws, {'type': 'error', 'error': '当前无法再来一局'})
        return

    if room['players'][0] == ws:
        player_idx = 0
    elif room['players'][1] == ws:
        player_idx = 1
    else:
        return

    rematch_key = '_rematch_ready'
    ready = room.setdefault(rematch_key, set())
    ready.add(player_idx)

    other_idx = 1 - player_idx
    other_ws = room['players'][other_idx]

    # If opponent disconnected, auto-decline rematch
    if other_ws is None:
        await _send(ws, {'type': 'error', 'error': '对手已离开房间'})
        ready.discard(player_idx)
        return

    if len(ready) >= 2:
        # Both ready, restart game with swapped colors
        room.pop(rematch_key, None)
        room.pop('_undo_count_0', None)
        room.pop('_undo_count_1', None)
        room['board'] = make_board()
        room['moves'] = []
        room['state'] = 'playing'

        # Swap colors for rematch: loser becomes black.
        # For draws (_winner == -1), keep original assignment.
        winner = room.get('_winner', 0)
        if winner == -1:
            new_black_idx = 1  # white becomes black
        else:
            new_black_idx = 1 - winner  # loser becomes black
        room['players'] = [room['players'][new_black_idx], room['players'][1 - new_black_idx]]
        room['usernames'] = [room['usernames'][new_black_idx], room['usernames'][1 - new_black_idx]]
        if room.get('accounts'):
            room['accounts'] = [room['accounts'][new_black_idx], room['accounts'][1 - new_black_idx]]
        room['current_player'] = 1

        for i in range(2):
            p = room['players'][i]
            if p:
                color = 1 if i == 0 else 2
                await _send(p, {
                    'type': 'start', 'color': color,
                    'message': f'再来一局！您执{"黑" if color == 1 else "白"}',
                    'room_id': room_id,
                    'usernames': room['usernames'],
                })
        await _broadcast_to_player(room, 0, {'type': 'turn', 'color': 1})
        await _start_timer(room_id)
        for s in room.get('spectators', set()):
            await _send(s, {'type': 'chat', 'username': '系统', 'message': '再来一局！新对局开始'})
        # Persist new game (use accounts for DB consistency)
        _submit_db(save_active_game, room_id,
                         room.get('accounts', room['usernames'])[0],
                         room.get('accounts', room['usernames'])[1],
                         board_to_list(room['board']), 1, [])
    else:
        await _send(ws, {'type': 'rematch_waiting', 'message': '等待对方确认...'})
        if other_ws:
            await _send(other_ws, {'type': 'rematch_request', 'from': info.get('display_name', info['username'])})


async def _periodic_cleanup(app):
    """Periodic cleanup of stale state (runs every 60s)."""
    while True:
        await asyncio.sleep(60)
        try:
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
                waiting_queue.pop(ws, None)

            # Clean WS rate-limit entries for disconnected clients
            stale_ws = [ws_id for ws_id in list(_ws_ratelimit.keys())
                        if not any(id(w) == ws_id for w in clients)]
            for ws_id in stale_ws:
                del _ws_ratelimit[ws_id]

            # Clean stale grace periods (safety net)
            stale_grace = []
            for key, g in list(_disconnect_grace.items()):
                if g['ws'] not in clients and not any(
                    info.get('session_id') == key[1] for info in clients.values()
                ):
                    stale_grace.append(key)
            for key in stale_grace:
                g = _disconnect_grace.pop(key, None)
                if g:
                    g['task'].cancel()
        except Exception as e:
            logger.error(f"Periodic cleanup error: {e}", exc_info=True)


async def _on_disconnect(ws):
    if ws in pending_auth:
        pending_auth.pop(ws, None)
        return

    waiting_queue.pop(ws, None)
    _ws_ratelimit.pop(id(ws), None)

    if ws not in clients:
        return

    info = clients[ws]
    username = info['username']
    session_id = info.get('session_id', '')
    room_id = info.get('room_id')

    # Start grace period — don't leave room yet, wait for potential reconnect.
    # Keep ws in clients so _handle_leave_room can look up room info on expiry.
    async def _graceful_disconnect():
        try:
            await asyncio.sleep(_GRACE_PERIOD)
        except asyncio.CancelledError:
            return
        key = (username, session_id)
        grace = _disconnect_grace.pop(key, None)
        if grace is None:
            return
        try:
            await _handle_leave_room(ws)
        except Exception:
            logger.error(f"Grace leave failed for {username}", exc_info=True)
        finally:
            clients.pop(ws, None)

    key = (username, session_id)
    # Cancel any existing grace task for this session
    old = _disconnect_grace.pop(key, None)
    if old:
        old['task'].cancel()
    _disconnect_grace[key] = {
        'task': asyncio.create_task(_graceful_disconnect()),
        'ws': ws,
        'room_id': room_id,
    }


# ===== Middleware =====

@web.middleware
async def rate_limit_middleware(request, handler):
    # Prefer X-Real-IP / X-Forwarded-For when behind a reverse proxy
    ip = (request.headers.get('X-Real-IP') or
          request.headers.get('X-Forwarded-For', '').split(',')[0].strip() or
          request.remote)
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
    max_retries = 5
    for attempt in range(1, max_retries + 1):
        try:
            init_db()
            init_active_games_table()
            print("数据库初始化成功")
            break
        except Exception as e:
            if attempt == max_retries:
                print(f"数据库初始化失败（已重试{max_retries}次）: {e}")
                return
            delay = 2 ** (attempt - 1)
            print(f"数据库连接失败: {e}，{delay}秒后重试({attempt}/{max_retries})...")
            time.sleep(delay)

    # Recover active games from previous run (server restart / crash)
    try:
        orphaned = load_active_games()
        if orphaned:
            logger.warning(f"发现 {len(orphaned)} 个未完成的对局，正在清理...")
            for g in orphaned:
                _submit_db(save_game, g['room_id'],
                                 g['black_username'], g['white_username'],
                                 None, '服务器重启',
                                 [(i, m[0], m[1], m[2]) for i, m in enumerate(g['moves'], 1)])
                _submit_db(delete_active_game, g['room_id'])
            logger.info(f"已清理 {len(orphaned)} 个残留对局")
    except Exception as e:
        logger.error(f"清理残留对局失败: {e}")

    print("游戏引擎已就绪")

    app = web.Application(middlewares=[rate_limit_middleware, cors_middleware], client_max_size=1024*1024)
    app.router.add_post('/register', handle_register)
    app.router.add_post('/login', handle_login)
    app.router.add_get('/health', handle_health)
    app.router.add_get('/api/rooms', handle_list_rooms)
    app.router.add_get('/api/games', handle_games)
    app.router.add_get('/api/games/{id}', handle_game_detail)
    app.router.add_get('/api/profile', handle_profile)
    app.router.add_post('/api/profile/update', handle_update_profile)
    app.router.add_get('/ws', handle_ws)

    # Periodic cleanup task (fire-and-forget, don't await the infinite loop)
    async def _start_cleanup(app):
        global _cleanup_task
        _cleanup_task = asyncio.create_task(_periodic_cleanup(app))

    app.on_startup.append(_start_cleanup)

    async def _on_shutdown(app):
        """Cancel all pending timer tasks on shutdown."""
        global _cleanup_task
        if _cleanup_task:
            _cleanup_task.cancel()
        for task in _timer_tasks.values():
            task.cancel()
        _timer_tasks.clear()
        for task in _rematch_tasks.values():
            task.cancel()
        _rematch_tasks.clear()
        for g in _disconnect_grace.values():
            g['task'].cancel()
        _disconnect_grace.clear()

        # Save in-progress games before clearing memory
        for room_id, room in list(rooms.items()):
            if room['state'] in ('playing', 'waiting') and room.get('moves'):
                accounts = room.get('accounts', room.get('usernames', []))
                moves_snap = list(room['moves'])
                _submit_db(save_game, room_id,
                           accounts[0] if len(accounts) > 0 else None,
                           accounts[1] if len(accounts) > 1 else None,
                           None, '服务器关闭',
                           [(i, m[0], m[1], m[2]) for i, m in enumerate(moves_snap, 1)])
                _submit_db(delete_active_game, room_id)

        _executor.shutdown(wait=True)
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
