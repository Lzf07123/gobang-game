#include "gobang.h"

static int board[BOARD_SIZE][BOARD_SIZE];
static int current_player = BLACK;

void board_init(void) {
    for (int i = 0; i < BOARD_SIZE; i++)
        for (int j = 0; j < BOARD_SIZE; j++)
            board[i][j] = EMPTY;
    current_player = BLACK;
}

int place_piece(int x, int y, int color) {
    if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) return 0;
    if (board[y][x] != EMPTY) return 0;
    if (color != current_player) return 0;
    board[y][x] = color;
    current_player = (current_player == BLACK) ? WHITE : BLACK;
    return 1;
}

int check_winner(void) {
    int dirs[4][2] = {{1,0}, {0,1}, {1,1}, {1,-1}};
    for (int y = 0; y < BOARD_SIZE; y++) {
        for (int x = 0; x < BOARD_SIZE; x++) {
            int c = board[y][x];
            if (c == EMPTY) continue;
            for (int d = 0; d < 4; d++) {
                int dx = dirs[d][0], dy = dirs[d][1];
                int cnt = 1;
                for (int s = 1; s < 5; s++) {
                    int nx = x + dx * s, ny = y + dy * s;
                    if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
                    if (board[ny][nx] != c) break;
                    cnt++;
                }
                if (cnt >= 5) return c;
            }
        }
    }
    return 0;
}

void reset_game(void) { board_init(); }

void set_current_player(int color) { current_player = color; }

int get_current_player(void) { return current_player; }
