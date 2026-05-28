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
        for (int s = 1; s < BOARD_SIZE; s++) {
            int nx = last_x + dx * s, ny = last_y + dy * s;
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (get_cell(nx, ny) != c) break;
            cnt++;
        }
        for (int s = 1; s < BOARD_SIZE; s++) {
            int nx = last_x - dx * s, ny = last_y - dy * s;
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (get_cell(nx, ny) != c) break;
            cnt++;
        }
        if (cnt >= 5 && (c == WHITE || cnt == 5)) return c;
    }
    return 0;
}

int get_win_line(int last_x, int last_y, int out_xs[5], int out_ys[5]) {
    for (int i = 0; i < 5; i++) { out_xs[i] = -1; out_ys[i] = -1; }
    int c = get_cell(last_x, last_y);
    if (c == EMPTY) return 0;
    for (int d = 0; d < 4; d++) {
        int dx = dirs[d][0], dy = dirs[d][1];
        int start = 0;
        while (start > -BOARD_SIZE) {
            int nx = last_x + dx * (start - 1), ny = last_y + dy * (start - 1);
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (get_cell(nx, ny) != c) break;
            start--;
        }
        int cnt = 0, pos = start;
        while (pos < start + BOARD_SIZE) {
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
        for (int s = 1; s < BOARD_SIZE; s++) {
            int nx = last_x + dx * s, ny = last_y + dy * s;
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (board[ny][nx] != c) break;
            cnt++;
        }
        for (int s = 1; s < BOARD_SIZE; s++) {
            int nx = last_x - dx * s, ny = last_y - dy * s;
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (board[ny][nx] != c) break;
            cnt++;
        }
        if (cnt >= 5 && (c == WHITE || cnt == 5)) return c;
    }
    return 0;
}

int get_win_line_on(const int board[BOARD_SIZE][BOARD_SIZE], int last_x, int last_y,
                    int out_xs[5], int out_ys[5]) {
    for (int i = 0; i < 5; i++) { out_xs[i] = -1; out_ys[i] = -1; }
    if (last_x < 0 || last_x >= BOARD_SIZE || last_y < 0 || last_y >= BOARD_SIZE) return 0;
    int c = board[last_y][last_x];
    if (c == EMPTY) return 0;
    for (int d = 0; d < 4; d++) {
        int dx = dirs[d][0], dy = dirs[d][1];
        int start = 0;
        while (start > -BOARD_SIZE) {
            int nx = last_x + dx * (start - 1), ny = last_y + dy * (start - 1);
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (board[ny][nx] != c) break;
            start--;
        }
        int cnt = 0, pos = start;
        while (pos < start + BOARD_SIZE) {
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
    for (int s = 1; s < BOARD_SIZE; s++) {
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

/* Count how many "fours" would be formed by placing BLACK at (x,y).
   A "four" is exactly 4 consecutive stones with at least one end open
   (making it a threat to win on the next move).  After hypothetically
   placing BLACK at (x,y), scan in each direction to find the total
   contiguous BLACK segment — this uniformly handles both contiguous
   fours and gap-bridged patterns like X_XXX, XX_XX, XXX_X. */
static int count_open_fours_at(int x, int y) {
    int count = 0;
    for (int d = 0; d < 4; d++) {
        int dx = dirs[d][0], dy = dirs[d][1];

        int left = 0;
        for (int s = 1; s < BOARD_SIZE; s++) {
            int nx = x - dx * s, ny = y - dy * s;
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (get_cell(nx, ny) != BLACK) break;
            left++;
        }
        int lx = x - dx * (left + 1), ly = y - dy * (left + 1);
        int left_end = (lx < 0 || lx >= BOARD_SIZE || ly < 0 || ly >= BOARD_SIZE) ? -1 : get_cell(lx, ly);

        int right = 0;
        for (int s = 1; s < BOARD_SIZE; s++) {
            int nx = x + dx * s, ny = y + dy * s;
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (get_cell(nx, ny) != BLACK) break;
            right++;
        }
        int rx = x + dx * (right + 1), ry = y + dy * (right + 1);
        int right_end = (rx < 0 || rx >= BOARD_SIZE || ry < 0 || ry >= BOARD_SIZE) ? -1 : get_cell(rx, ry);

        int total = 1 + left + right;
        if (total == 4 && (left_end == EMPTY || right_end == EMPTY))
            count++;
    }
    return count;
}

int is_double_four(int x, int y) {
    if (get_cell(x, y) != EMPTY) return 0;
    return count_open_fours_at(x, y) >= 2;
}

/* Black's forbidden moves: double-three, double-four, over-line.
   A move that creates an immediate 5-in-a-row win is never forbidden.
   Returns FORBID_* constant. */
int check_forbidden(int x, int y) {
    if (get_cell(x, y) != EMPTY) return FORBID_NONE;

    /* If placing at (x,y) creates exactly 5 in a row, it wins. */
    for (int d = 0; d < 4; d++) {
        int dx = dirs[d][0], dy = dirs[d][1];
        int left = 0, right = 0;
        for (int s = 1; s < BOARD_SIZE; s++) {
            int nx = x - dx * s, ny = y - dy * s;
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (get_cell(nx, ny) != BLACK) break;
            left++;
        }
        for (int s = 1; s < BOARD_SIZE; s++) {
            int nx = x + dx * s, ny = y + dy * s;
            if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
            if (get_cell(nx, ny) != BLACK) break;
            right++;
        }
        if (1 + left + right == 5) return FORBID_NONE;
    }

    if (is_over_line(x, y)) return FORBID_OVERLINE;
    if (is_double_four(x, y)) return FORBID_DOUBLE_FOUR;
    if (is_double_three(x, y)) return FORBID_DOUBLE_THREE;
    return FORBID_NONE;
}
