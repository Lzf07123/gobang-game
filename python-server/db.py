import os
import mysql.connector

_REQUIRED_ENV = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']
_pool = None


def check_env():
    missing = [k for k in _REQUIRED_ENV if not os.getenv(k)]
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")


def _get_conn():
    global _pool
    if _pool is None:
        _pool = mysql.connector.pooling.MySQLConnectionPool(
            pool_name="gobang",
            pool_size=int(os.getenv('DB_POOL_SIZE', '10')),
            host=os.getenv('DB_HOST'),
            port=int(os.getenv('DB_PORT', '3306')),
            user=os.getenv('DB_USER'),
            password=os.getenv('DB_PASSWORD'),
            database=os.getenv('DB_NAME'),
        )
    return _pool.get_connection()


def init_db():
    check_env()
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            account VARCHAR(50) UNIQUE DEFAULT NULL,
            display_name VARCHAR(50) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # Migration: add columns if they don't exist (for existing databases)
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN account VARCHAR(50) UNIQUE DEFAULT NULL")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN display_name VARCHAR(50) DEFAULT NULL")
    except Exception:
        pass
    # Migrate existing rows: copy username to account and display_name if null
    try:
        cursor.execute("UPDATE users SET account = username WHERE account IS NULL")
        cursor.execute("UPDATE users SET display_name = username WHERE display_name IS NULL")
        cursor.execute("ALTER TABLE users MODIFY account VARCHAR(50) NOT NULL")
        cursor.execute("ALTER TABLE users MODIFY display_name VARCHAR(50) NOT NULL")
    except Exception:
        pass
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS games (
            id INT AUTO_INCREMENT PRIMARY KEY,
            room_id VARCHAR(4) NOT NULL,
            black_username VARCHAR(50),
            white_username VARCHAR(50),
            winner VARCHAR(50),
            reason VARCHAR(100),
            total_moves INT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS game_moves (
            id INT AUTO_INCREMENT PRIMARY KEY,
            game_id INT NOT NULL,
            move_number INT NOT NULL,
            x INT NOT NULL,
            y INT NOT NULL,
            color INT NOT NULL,
            FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS user_sessions (
            username VARCHAR(50) PRIMARY KEY,
            session_id VARCHAR(64) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    cursor.close()
    conn.close()


def set_user_session(username, session_id):
    """Record or update the active session for a user."""
    conn = _get_conn()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "INSERT INTO user_sessions (username, session_id) "
            "VALUES (%s, %s) ON DUPLICATE KEY UPDATE session_id = %s, created_at = CURRENT_TIMESTAMP",
            (username, session_id, session_id)
        )
        conn.commit()
    finally:
        cursor.close()
        conn.close()


def clear_user_session(username):
    """Remove the active session record for a user."""
    conn = _get_conn()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM user_sessions WHERE username = %s", (username,))
        conn.commit()
    finally:
        cursor.close()
        conn.close()


def get_user_session(username):
    """Return the current session_id for a user, or None if not set."""
    conn = _get_conn()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT session_id FROM user_sessions WHERE username = %s", (username,))
        row = cursor.fetchone()
        return row['session_id'] if row else None
    finally:
        cursor.close()
        conn.close()


def update_display_name(account, new_name):
    """Update display_name for a user. Returns True on success, False if name taken."""
    conn = _get_conn()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id FROM users WHERE display_name = %s AND account != %s",
                       (new_name, account))
        if cursor.fetchone():
            return False
        cursor.execute("UPDATE users SET display_name = %s WHERE account = %s",
                       (new_name, account))
        conn.commit()
        return True
    finally:
        cursor.close()
        conn.close()


def save_game(room_id, black_username, white_username, winner, reason, moves):
    """Save completed game and all its moves to database."""
    conn = _get_conn()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            "INSERT INTO games (room_id, black_username, white_username, winner, reason, total_moves) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            (room_id, black_username, white_username, winner, reason, len(moves))
        )
        game_id = cursor.lastrowid
        for move in moves:
            cursor.execute(
                "INSERT INTO game_moves (game_id, move_number, x, y, color) VALUES (%s, %s, %s, %s, %s)",
                (game_id, move[0], move[1], move[2], move[3])
            )
        conn.commit()
    finally:
        cursor.close()
        conn.close()


def get_user_games(username):
    """Get list of games for a user."""
    conn = _get_conn()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            "SELECT id, room_id, black_username, white_username, winner, reason, total_moves, created_at "
            "FROM games WHERE black_username = %s OR white_username = %s "
            "ORDER BY created_at DESC LIMIT 50",
            (username, username)
        )
        return cursor.fetchall()
    finally:
        cursor.close()
        conn.close()


def get_game_moves(game_id):
    """Get all moves for a specific game."""
    conn = _get_conn()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            "SELECT move_number, x, y, color FROM game_moves WHERE game_id = %s ORDER BY move_number",
            (game_id,)
        )
        return cursor.fetchall()
    finally:
        cursor.close()
        conn.close()


def get_user_stats(username):
    """Get game statistics for a user."""
    conn = _get_conn()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            "SELECT COUNT(*) as total FROM games WHERE black_username = %s OR white_username = %s",
            (username, username)
        )
        total = cursor.fetchone()['total']
        cursor.execute(
            "SELECT COUNT(*) as wins FROM games WHERE winner = %s",
            (username,)
        )
        wins = cursor.fetchone()['wins']
        return {'total': total, 'wins': wins}
    finally:
        cursor.close()
        conn.close()


def init_active_games_table():
    """Create active_games table for crash recovery."""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS active_games (
            room_id VARCHAR(4) PRIMARY KEY,
            black_username VARCHAR(50),
            white_username VARCHAR(50),
            board_json LONGTEXT,
            current_player INT DEFAULT 1,
            moves_json LONGTEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    cursor.close()
    conn.close()


def save_active_game(room_id, black_user, white_user, board, current_player, moves):
    """Persist an in-progress game for crash recovery."""
    import json
    conn = _get_conn()
    cursor = conn.cursor()
    try:
        board_json = json.dumps(board)
        moves_json = json.dumps(moves)
        cursor.execute(
            "INSERT INTO active_games (room_id, black_username, white_username, "
            "board_json, current_player, moves_json) "
            "VALUES (%s, %s, %s, %s, %s, %s) "
            "ON DUPLICATE KEY UPDATE board_json=%s, current_player=%s, moves_json=%s",
            (room_id, black_user, white_user, board_json, current_player, moves_json,
             board_json, current_player, moves_json)
        )
        conn.commit()
    finally:
        cursor.close()
        conn.close()


def update_active_game(room_id, board, current_player, moves):
    """Update board state after each move."""
    import json
    conn = _get_conn()
    cursor = conn.cursor()
    try:
        board_json = json.dumps(board)
        moves_json = json.dumps(moves)
        cursor.execute(
            "UPDATE active_games SET board_json=%s, current_player=%s, "
            "moves_json=%s WHERE room_id=%s",
            (board_json, current_player, moves_json, room_id)
        )
        conn.commit()
    finally:
        cursor.close()
        conn.close()


def delete_active_game(room_id):
    """Remove active game record when game ends."""
    conn = _get_conn()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM active_games WHERE room_id = %s", (room_id,))
        conn.commit()
    finally:
        cursor.close()
        conn.close()


def load_active_games():
    """Load all active games after server restart."""
    import json
    conn = _get_conn()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT * FROM active_games")
        rows = cursor.fetchall()
        result = []
        for row in rows:
            result.append({
                'room_id': row['room_id'],
                'black_username': row['black_username'],
                'white_username': row['white_username'],
                'board': json.loads(row['board_json']),
                'current_player': row['current_player'],
                'moves': json.loads(row['moves_json']),
            })
        return result
    finally:
        cursor.close()
        conn.close()


def execute_query(sql, params=None, fetch=True):
    """Run a DB query in a thread-safe way (call from executor)."""
    conn = _get_conn()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(sql, params)
        if sql.strip().upper().startswith('SELECT'):
            return cursor.fetchall()
        conn.commit()
        return None
    finally:
        cursor.close()
        conn.close()
