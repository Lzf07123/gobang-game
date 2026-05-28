import ctypes
import os
import asyncio

BOARD_SIZE = 15
EMPTY = 0
BLACK = 1
WHITE = 2

_board_t = (ctypes.c_int * BOARD_SIZE) * BOARD_SIZE
_win_t = ctypes.c_int * 5


def make_board():
    """Create a zero-initialised ctypes 2D board array (maps directly to C int[15][15])."""
    return _board_t()


def board_to_list(board):
    """Convert a ctypes board to a Python list-of-lists for JSON serialization."""
    return [[board[y][x] for x in range(BOARD_SIZE)] for y in range(BOARD_SIZE)]


class GameEngine:
    """Singleton wrapping the C shared library.

    The C library operates on caller-supplied board pointers, so every room's
    ctypes board can be passed directly — no more per-call copy overhead.
    """

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            instance = super().__new__(cls)
            try:
                instance._init()
            except Exception:
                cls._instance = None
                raise
            cls._instance = instance
        return cls._instance

    def _init(self):
        lib_path = os.path.join(os.path.dirname(__file__), 'libgobang.so')
        if not os.path.exists(lib_path):
            raise RuntimeError(
                f"C library not found at {lib_path}. "
                "Run 'make' in c-core/ first."
            )
        self.lib = ctypes.CDLL(lib_path)

        # board.h
        self.lib.board_init.argtypes = []
        self.lib.board_init.restype = None
        self.lib.place_piece.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
        self.lib.place_piece.restype = ctypes.c_int
        self.lib.reset_game.argtypes = []
        self.lib.reset_game.restype = None
        self.lib.get_current_player.restype = ctypes.c_int
        self.lib.get_cell.argtypes = [ctypes.c_int, ctypes.c_int]
        self.lib.get_cell.restype = ctypes.c_int
        self.lib.set_board_state.argtypes = [_board_t]
        self.lib.set_board_state.restype = None

        # rules.h
        self.lib.check_winner.argtypes = [ctypes.c_int, ctypes.c_int]
        self.lib.check_winner.restype = ctypes.c_int
        self.lib.get_win_line.argtypes = [ctypes.c_int, ctypes.c_int, _win_t, _win_t]
        self.lib.get_win_line.restype = ctypes.c_int

        # rules.h — direct-board variants (no static sync needed)
        self.lib.check_winner_on.argtypes = [_board_t, ctypes.c_int, ctypes.c_int]
        self.lib.check_winner_on.restype = ctypes.c_int
        self.lib.get_win_line_on.argtypes = [_board_t, ctypes.c_int, ctypes.c_int, _win_t, _win_t]
        self.lib.get_win_line_on.restype = ctypes.c_int

        # rules.h — forbidden-move detection (operates on static board; call
        # set_board_state first to sync the room's board before checking)
        self.lib.check_forbidden.argtypes = [ctypes.c_int, ctypes.c_int]
        self.lib.check_forbidden.restype = ctypes.c_int
        self.lib.is_over_line.argtypes = [ctypes.c_int, ctypes.c_int]
        self.lib.is_over_line.restype = ctypes.c_int
        self.lib.is_double_three.argtypes = [ctypes.c_int, ctypes.c_int]
        self.lib.is_double_three.restype = ctypes.c_int
        self.lib.is_double_four.argtypes = [ctypes.c_int, ctypes.c_int]
        self.lib.is_double_four.restype = ctypes.c_int

        self.lib.board_init()

        self._lock = asyncio.Lock()

    def _sync_board(self, board):
        """Copy a per-room board to the static C board for functions that need it."""
        self.lib.set_board_state(board)

    async def check_forbidden(self, board, x, y):
        """Check forbidden move for black at (x,y) on a per-room board.

        Protected by an asyncio lock to prevent concurrent _sync_board calls
        from overwriting the C library's global static board mid-check.
        """
        async with self._lock:
            self._sync_board(board)
            return self.lib.check_forbidden(x, y)

    def check_winner_on(self, board, x, y):
        """Check win at (x,y) on a caller-owned ctypes board. Returns color or 0."""
        return self.lib.check_winner_on(board, x, y)

    def get_win_line_on(self, board, x, y):
        """Extract the 5 winning coordinates from a caller-owned ctypes board."""
        xs = _win_t()
        ys = _win_t()
        if self.lib.get_win_line_on(board, x, y, xs, ys):
            return [(xs[i], ys[i]) for i in range(5)]
        return None


_engine = None


def get_engine():
    global _engine
    if _engine is None:
        _engine = GameEngine()
    return _engine


def check_winner_on_board(board, x, y):
    """Check win at (x,y) on a ctypes board. Returns (color, win_line).

    color: 0 = no winner, 1 = black, 2 = white
    win_line: list of 5 (x,y) tuples, or None
    """
    engine = get_engine()
    color = engine.check_winner_on(board, x, y)
    if color:
        return color, engine.get_win_line_on(board, x, y)
    return 0, None


async def check_forbidden_on_board(board, x, y):
    """Check forbidden move for black at (x,y). Returns FORBID_* constant."""
    engine = get_engine()
    return await engine.check_forbidden(board, x, y)
