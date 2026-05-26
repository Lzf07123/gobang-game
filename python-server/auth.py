import os
import secrets
import bcrypt
import jwt
import time
import mysql.connector
from db import execute_query

_JWT_SECRET = os.getenv('JWT_SECRET', '')
if not _JWT_SECRET or _JWT_SECRET == 'your_jwt_secret_key_change_me':
    _JWT_SECRET = secrets.token_hex(32)
    print("⚠ JWT_SECRET 未设置或使用默认值，已自动生成临时密钥（重启后失效）")
    print("   请将以下密钥写入 python_server/.env 中的 JWT_SECRET= 使其持久化：")
    print(f"   JWT_SECRET={_JWT_SECRET}")
_JWT_EXPIRY = 7200  # 2 hours


def _hash_password(password):
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def _check_password(password, hashed):
    return bcrypt.checkpw(password.encode(), hashed.encode())


def _make_token(username):
    payload = {'username': username, 'exp': int(time.time()) + _JWT_EXPIRY}
    return jwt.encode(payload, _JWT_SECRET, algorithm='HS256')


def verify_token(token):
    try:
        payload = jwt.decode(token, _JWT_SECRET, algorithms=['HS256'])
        return payload['username']
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def register(username, password):
    if len(username) < 2 or len(username) > 50:
        return False, "用户名长度需在2-50之间"
    if len(password) < 4:
        return False, "密码长度至少4位"

    existing = execute_query(
        "SELECT id FROM users WHERE username = %s", (username,)
    )
    if existing:
        return False, "用户名已存在"

    pw_hash = _hash_password(password)
    try:
        execute_query(
            "INSERT INTO users (username, password_hash) VALUES (%s, %s)",
            (username, pw_hash), fetch=False
        )
    except mysql.connector.IntegrityError:
        return False, "用户名已存在"
    return True, None


def login(username, password):
    rows = execute_query(
        "SELECT password_hash FROM users WHERE username = %s", (username,)
    )
    if not rows:
        return False, "用户名或密码错误"

    if not _check_password(password, rows[0]['password_hash']):
        return False, "用户名或密码错误"

    token = _make_token(username)
    return True, token
