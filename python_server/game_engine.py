import ctypes
import os


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
