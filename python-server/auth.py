import os
import re
import sys
import secrets
import bcrypt
import jwt
import time
import mysql.connector
from db import execute_query, set_user_session

_ACCOUNT_RE = re.compile(r'^[a-zA-Z0-9]{2,20}$')
_DISPLAY_NAME_RE = re.compile(r'^[\w一-鿿]{2,20}$')


def _load_jwt_secret():
    """Load JWT_SECRET from environment or .env file.

    Tries os.environ first, then reads .env directly as a fallback.
    load_dotenv(override=False) skips keys already in os.environ — even
    when the value is empty (Docker sets empty env vars).  Direct file
    read bypasses that trap.
    """
    secret = os.getenv('JWT_SECRET', '').strip()
    if secret and secret != 'your_jwt_secret_key_change_me':
        return secret

    # Fallback: read .env directly so an empty env var (e.g. from Docker)
    # doesn't hide a valid value in the file.
    env_path = os.path.join(os.path.dirname(__file__), '.env')
    try:
        with open(env_path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if line.startswith('JWT_SECRET=') or line.startswith('JWT_SECRET '):
                    _, _, val = line.partition('=')
                    # Strip value, remove trailing inline comment
                    val = val.strip()
                    if '#' in val:
                        val = val.split('#')[0].strip()
                    if val and val != 'your_jwt_secret_key_change_me':
                        return val
    except FileNotFoundError:
        pass

    # Neither source provided a valid secret — refuse to start
    secret = secrets.token_hex(32)
    print("=" * 60)
    print("错误: JWT_SECRET 未设置或使用默认值！")
    print("请将以下密钥写入 python-server/.env 中的 JWT_SECRET= 后重启：")
    print(f"JWT_SECRET={secret}")
    print("=" * 60)
    sys.exit(1)


_JWT_SECRET = _load_jwt_secret()
_JWT_EXPIRY = 604800  # 7 days


def _hash_password(password):
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def _check_password(password, hashed):
    return bcrypt.checkpw(password.encode(), hashed.encode())


def _make_token(username, session_id):
    payload = {
        'username': username,
        'session_id': session_id,
        'exp': int(time.time()) + _JWT_EXPIRY,
    }
    return jwt.encode(payload, _JWT_SECRET, algorithm='HS256')


def verify_token(token):
    try:
        payload = jwt.decode(token, _JWT_SECRET, algorithms=['HS256'])
        return payload['username'], payload.get('session_id', '')
    except jwt.ExpiredSignatureError:
        return None, None
    except jwt.InvalidTokenError:
        return None, None


def register(account, display_name, password):
    if not isinstance(account, str) or not isinstance(display_name, str) or not isinstance(password, str):
        return False, "参数格式无效"
    if not account or not _ACCOUNT_RE.match(account):
        return False, "账号仅支持字母和数字，2-20个字符"
    if not display_name or not _DISPLAY_NAME_RE.match(display_name):
        return False, "用户名仅支持中英文、数字、下划线，2-20个字符"
    if len(password) < 6:
        return False, "密码长度至少6位"
    if len(password) > 128:
        return False, "密码长度不能超过128位"

    existing = execute_query(
        "SELECT id FROM users WHERE account = %s", (account,)
    )
    if existing:
        return False, "账号已存在"

    pw_hash = _hash_password(password)
    try:
        execute_query(
            "INSERT INTO users (username, account, display_name, password_hash) VALUES (%s, %s, %s, %s)",
            (account, account, display_name, pw_hash), fetch=False
        )
    except mysql.connector.IntegrityError:
        return False, "账号已存在"
    return True, None


def login(account, password):
    if not isinstance(account, str) or not isinstance(password, str):
        return False, "参数格式无效"
    rows = execute_query(
        "SELECT username, display_name, password_hash FROM users WHERE account = %s", (account,)
    )
    if not rows:
        return False, "账号或密码错误"

    row = rows[0]
    if not _check_password(password, row['password_hash']):
        return False, "账号或密码错误"

    session_id = secrets.token_hex(16)
    set_user_session(row['username'], session_id)

    token = _make_token(row['username'], session_id)
    return True, (token, row['display_name'] or row['username'])
