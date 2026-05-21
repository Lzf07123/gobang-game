import json
import os
import asyncio
from concurrent.futures import ThreadPoolExecutor

from aiohttp import web
from dotenv import load_dotenv

from db import init_db, execute_query, check_env
from auth import register, login, verify_token
from game_engine import GameEngine

load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

_executor = ThreadPoolExecutor(max_workers=2)

# In-memory game state
clients = {}    # ws -> {'username': str, 'room_id': str|None}
rooms = {}      # room_id -> {'players': [ws, ws], 'usernames': [str, str]}
waiting_queue = []  # list of ws
_room_counter = 0


async def _run_db(fn, *args):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, fn, *args)


# ---------- HTTP handlers ----------

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


# ---------- WebSocket handler ----------

async def handle_ws(request):
    token = request.query.get('token', '')
    username = verify_token(token)
    if not username:
        return web.json_response({'success': False, 'error': 'token无效或已过期'}, status=401)

    ws = web.WebSocketResponse()
    await ws.prepare(request)
    clients[ws] = {'username': username, 'room_id': None}

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
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        await _send(ws, {'type': 'error', 'error': '无效的消息格式'})
        return

    msg_type = data.get('type', '')

    if msg_type == 'match':
        await _handle_match(ws)
    elif msg_type == 'move':
        x, y = data.get('x'), data.get('y')
        if x is None or y is None:
            await _send(ws, {'type': 'error', 'error': '缺少坐标'})
            return
        await _handle_move(ws, int(x), int(y))
    else:
        await _send(ws, {'type': 'error', 'error': f'未知消息类型: {msg_type}'})


async def _handle_match(ws):
    info = clients.get(ws)
    if not info:
        return

    # If already in a room, ignore
    if info['room_id']:
        return

    global waiting_queue
    if waiting_queue:
        opponent = waiting_queue.pop(0)
        # Don't match with self
        if opponent == ws:
            waiting_queue.append(ws)
            await _send(ws, {'type': 'waiting', 'message': '等待对手...'})
            return

        o_info = clients.get(opponent)
        if not o_info:
            waiting_queue.insert(0, ws)
            await _handle_match(ws)
            return

        global _room_counter
        _room_counter += 1
        room_id = str(_room_counter)
        rooms[room_id] = {
            'players': [opponent, ws],
            'usernames': [o_info['username'], info['username']],
        }
        info['room_id'] = room_id
        o_info['room_id'] = room_id

        engine = GameEngine()
        engine.reset()

        await _send(opponent, {
            'type': 'start', 'color': 1,
            'message': '您执黑（先手），等待对手准备...'
        })
        await _send(ws, {
            'type': 'start', 'color': 2,
            'message': '您执白（后手），黑棋先走'
        })
        await _send(opponent, {'type': 'turn', 'color': 1})
    else:
        waiting_queue.append(ws)
        await _send(ws, {'type': 'waiting', 'message': '等待对手...'})


async def _handle_move(ws, x, y):
    info = clients.get(ws)
    if not info or not info['room_id']:
        await _send(ws, {'type': 'error', 'error': '您不在对局中'})
        return

    room = rooms.get(info['room_id'])
    if not room:
        await _send(ws, {'type': 'error', 'error': '房间不存在'})
        return

    # Determine which player this is (0 = black, 1 = white)
    player_idx = 0 if room['players'][0] == ws else 1
    color = 1 if player_idx == 0 else 2  # 1=black, 2=white

    engine = GameEngine()
    if engine.get_current_player() != color:
        await _send(ws, {'type': 'error', 'error': '还没轮到您'})
        return

    ok = engine.place(x, y, color)
    if not ok:
        await _send(ws, {'type': 'error', 'error': '无效落子'})
        return

    # Broadcast move to both players
    for player_ws in room['players']:
        await _send(player_ws, {'type': 'move', 'x': x, 'y': y, 'color': color})

    # Check winner
    winner = engine.check_winner()
    if winner:
        label = '黑方' if winner == 1 else '白方'
        for player_ws in room['players']:
            await _send(player_ws, {'type': 'game_over', 'winner': label})
        _cleanup_room(info['room_id'])
    else:
        # Notify next turn
        next_color = engine.get_current_player()
        for player_ws in room['players']:
            await _send(player_ws, {'type': 'turn', 'color': next_color})


async def _on_disconnect(ws):
    if ws in waiting_queue:
        waiting_queue.remove(ws)

    info = clients.pop(ws, None)
    if info and info['room_id']:
        room = rooms.get(info['room_id'])
        if room:
            for player_ws in room['players']:
                if player_ws != ws:
                    try:
                        await _send(player_ws, {
                            'type': 'game_over',
                            'winner': '对方掉线，您获胜'
                        })
                    except Exception:
                        pass
        _cleanup_room(info['room_id'])


def _cleanup_room(room_id):
    room = rooms.pop(room_id, None)
    if room:
        for player_ws in room['players']:
            info = clients.get(player_ws)
            if info and info['room_id'] == room_id:
                info['room_id'] = None
        # Reset engine for next game
        GameEngine().reset()


async def _send(ws, data):
    try:
        await ws.send_json(data)
    except ConnectionResetError:
        pass


# ---------- Middleware ----------

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


# ---------- Main ----------

def main():
    port = int(os.getenv('PORT', '8080'))

    print("检查数据库连接...")
    try:
        init_db()
        print("数据库初始化成功")
    except Exception as e:
        print(f"数据库初始化失败: {e}")
        return

    print("加载C游戏引擎...")
    try:
        engine = GameEngine()
        engine.reset()
        print("游戏引擎加载成功")
    except Exception as e:
        print(f"游戏引擎加载失败: {e}")
        return

    app = web.Application(middlewares=[cors_middleware])
    app.router.add_post('/register', handle_register)
    app.router.add_post('/login', handle_login)
    app.router.add_get('/ws', handle_ws)

    print(f"服务器启动，监听端口 {port}")
    web.run_app(app, host='0.0.0.0', port=port)


if __name__ == '__main__':
    main()
