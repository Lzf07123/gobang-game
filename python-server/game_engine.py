import ctypes
import os

BOARD_SIZE = 15
EMPTY = 0
BLACK = 1
WHITE = 2


def check_winner_on_board(board):
    """Python implementation of win detection for any board state.
    Supports multiple concurrent games unlike the singleton C engine."""
    dirs = [(1, 0), (0, 1), (1, 1), (1, -1)]
    for y in range(BOARD_SIZE):
        for x in range(BOARD_SIZE):
            c = board[y][x]
            if c == EMPTY:
                continue
            for dx, dy in dirs:
                cnt = 1
                for s in range(1, 5):
                    nx, ny = x + dx * s, y + dy * s
                    if nx < 0 or nx >= BOARD_SIZE or ny < 0 or ny >= BOARD_SIZE:
                        break
                    if board[ny][nx] != c:
                        break
                    cnt += 1
                if cnt >= 5:
                    return c
    return 0


def make_board():
    """Create a fresh empty board."""
    return [[EMPTY] * BOARD_SIZE for _ in range(BOARD_SIZE)]


class GameEngine:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._init()
        return cls._instance

    def _init(self):
        lib_path = os.path.join(os.path.dirname(__file__), 'libgobang.so')
        if not os.path.exists(lib_path):
            raise RuntimeError(
                f"C library not found at {lib_path}. "
                "Run 'make' in c_core/ first."
            )
        self.lib = ctypes.CDLL(lib_path)
        self.lib.place_piece.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
        self.lib.place_piece.restype = ctypes.c_int
        self.lib.check_winner.restype = ctypes.c_int
        self.lib.get_current_player.restype = ctypes.c_int
        self.lib.board_init()

    def place(self, x, y, color):
        return self.lib.place_piece(x, y, color)

    def check_winner(self):
        return self.lib.check_winner()

    def reset(self):
        self.lib.reset_game()

    def get_current_player(self):
        return self.lib.get_current_player()
