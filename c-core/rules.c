#include "rules.h"
#include "board.h"

const int dirs[4][2] = {{1,0}, {0,1}, {1,1}, {1,-1}};

/* Deprecated: operates on the static board. Use check_winner_on() with an
   explicit board parameter for multi-room support. */
int check_winner(int last_x, int last_y) {
    int c = get_cell(last_x, last_y);
    if (c == EMPTY) return 0;
    for (int d = 0; d < 4; d++) {
        int dx = dirs[d][0], dy = dirs[d][1];
        int cnt = 1;
        for (int s = 1; s < 5; s++) {
            int nx = last_x + dx * s, ny = last_y + dy * s;
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (get_cell(nx, ny) != c) break;
            cnt++;
        }
        for (int s = 1; s < 5; s++) {
            int nx = last_x - dx * s, ny = last_y - dy * s;
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (get_cell(nx, ny) != c) break;
            cnt++;
        }
        if (cnt >= 5) return c;
    }
    return 0;
}

int get_win_line(int last_x, int last_y, int out_xs[5], int out_ys[5]) {
    int c = get_cell(last_x, last_y);
    if (c == EMPTY) return 0;
    for (int d = 0; d < 4; d++) {
        int dx = dirs[d][0], dy = dirs[d][1];
        int start = 0;
        while (start > -5) {
            int nx = last_x + dx * (start - 1), ny = last_y + dy * (start - 1);
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (get_cell(nx, ny) != c) break;
            start--;
        }
        int cnt = 0, pos = start;
        while (pos < start + 10) {
            int nx = last_x + dx * pos, ny = last_y + dy * pos;
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (get_cell(nx, ny) != c) break;
            cnt++;
            pos++;
        }
        if (cnt >= 5) {
            int idx = 0;
            for (int i = start; i < start + cnt && idx < 5; i++, idx++) {
                out_xs[idx] = last_x + dx * i;
                out_ys[idx] = last_y + dy * i;
            }
            return 1;
        }
    }
    return 0;
}

int check_winner_on(const int board[BOARD_SIZE][BOARD_SIZE], int last_x, int last_y) {
    if (last_x < 0 || last_x >= BOARD_SIZE || last_y < 0 || last_y >= BOARD_SIZE) return 0;
    int c = board[last_y][last_x];
    if (c == EMPTY) return 0;
    for (int d = 0; d < 4; d++) {
        int dx = dirs[d][0], dy = dirs[d][1];
        int cnt = 1;
        for (int s = 1; s < 5; s++) {
            int nx = last_x + dx * s, ny = last_y + dy * s;
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (board[ny][nx] != c) break;
            cnt++;
        }
        for (int s = 1; s < 5; s++) {
            int nx = last_x - dx * s, ny = last_y - dy * s;
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (board[ny][nx] != c) break;
            cnt++;
        }
        if (cnt >= 5) return c;
    }
    return 0;
}

int get_win_line_on(const int board[BOARD_SIZE][BOARD_SIZE], int last_x, int last_y,
                    int out_xs[5], int out_ys[5]) {
    if (last_x < 0 || last_x >= BOARD_SIZE || last_y < 0 || last_y >= BOARD_SIZE) return 0;
    int c = board[last_y][last_x];
    if (c == EMPTY) return 0;
    for (int d = 0; d < 4; d++) {
        int dx = dirs[d][0], dy = dirs[d][1];
        int start = 0;
        while (start > -5) {
            int nx = last_x + dx * (start - 1), ny = last_y + dy * (start - 1);
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (board[ny][nx] != c) break;
            start--;
        }
        int cnt = 0, pos = start;
        while (pos < start + 10) {
            int nx = last_x + dx * pos, ny = last_y + dy * pos;
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (board[ny][nx] != c) break;
            cnt++;
            pos++;
        }
        if (cnt >= 5) {
            int idx = 0;
            for (int i = start; i < start + cnt && idx < 5; i++, idx++) {
                out_xs[idx] = last_x + dx * i;
                out_ys[idx] = last_y + dy * i;
            }
            return 1;
        }
    }
    return 0;
}

/* Count consecutive stones of `color` in direction (dx,dy) from (x,y), excluding the cell itself. */
static int count_dir(int x, int y, int dx, int dy, int color) {
    int cnt = 0;
    for (int s = 1; s < 5; s++) {
        int nx = x + dx * s, ny = y + dy * s;
        if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
        if (get_cell(nx, ny) != color) break;
        cnt++;
    }
    return cnt;
}

/* Check if placing a stone at (x,y) for `color` forms an over-line (>5). */
int is_over_line(int x, int y) {
    int color = BLACK;
    for (int d = 0; d < 4; d++) {
        int dx = dirs[d][0], dy = dirs[d][1];
        int cnt = 1 + count_dir(x, y, dx, dy, color) + count_dir(x, y, -dx, -dy, color);
        if (cnt > 5) return 1;
    }
    return 0;
}

/* Count how many open-threes would be formed by placing BLACK at (x,y).
   An open-three is exactly 3 consecutive stones with both immediate ends empty. */
static int count_open_threes_at(int x, int y) {
    int count = 0;
    for (int d = 0; d < 4; d++) {
        int dx = dirs[d][0], dy = dirs[d][1];
        int a = count_dir(x, y, dx, dy, BLACK);
        int b = count_dir(x, y, -dx, -dy, BLACK);
        int total = 1 + a + b;
        if (total == 3) {
            int ex1 = get_cell(x + dx * (a + 1), y + dy * (a + 1));
            int ex2 = get_cell(x - dx * (b + 1), y - dy * (b + 1));
            if (ex1 == EMPTY && ex2 == EMPTY) count++;
        }
    }
    return count;
}

int is_double_three(int x, int y) {
    if (get_cell(x, y) != EMPTY) return 0;
    return count_open_threes_at(x, y) >= 2;
}

/* Count how many open-fours would be formed by placing BLACK at (x,y).
   Open-four: 4 consecutive stones with at least one end open,
   or a broken-four pattern such as X_XXX, XX_XX, XXX_X with both ends open. */
static int count_open_fours_at(int x, int y) {
    int count = 0;
    for (int d = 0; d < 4; d++) {
        int dx = dirs[d][0], dy = dirs[d][1];
        int a = count_dir(x, y, dx, dy, BLACK);
        int b = count_dir(x, y, -dx, -dy, BLACK);
        int total = 1 + a + b;
        if (total == 4) {
            int ex1 = get_cell(x + dx * (a + 1), y + dy * (a + 1));
            int ex2 = get_cell(x - dx * (b + 1), y - dy * (b + 1));
            if (ex1 == EMPTY || ex2 == EMPTY) count++;
        } else if (total == 3) {
            /* Check for broken-four: gap at position s within the line */
            for (int gap = 1; gap <= a; gap++) {
                int gx = x + dx * gap, gy = y + dy * gap;
                int past_gap = 1 + count_dir(gx, gy, dx, dy, BLACK);
                if (1 + (gap - 1) + past_gap >= 4) {
                    int ex = get_cell(x + dx * (a + 1), y + dy * (a + 1));
                    if (ex == EMPTY) { count++; break; }
                }
            }
        }
    }
    return count;
}

int is_double_four(int x, int y) {
    if (get_cell(x, y) != EMPTY) return 0;
    return count_open_fours_at(x, y) >= 2;
}

/* Black's forbidden moves: double-three, double-four, over-line.
   Returns FORBID_* constant. */
int check_forbidden(int x, int y) {
    if (get_cell(x, y) != EMPTY) return FORBID_NONE;
    if (is_over_line(x, y)) return FORBID_OVERLINE;
    if (is_double_four(x, y)) return FORBID_DOUBLE_FOUR;
    if (is_double_three(x, y)) return FORBID_DOUBLE_THREE;
    return FORBID_NONE;
}
