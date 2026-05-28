#include "evaluate.h"
#include "board.h"
#include "rules.h"

/* Scan consecutive stones from (x,y) in direction (dx,dy) up to 5 steps. */
static int scan_dir(int x, int y, int dx, int dy, int color) {
    int cnt = 0;
    for (int s = 1; s <= 5; s++) {
        int nx = x + dx * s, ny = y + dy * s;
        if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
        if (get_cell(nx, ny) != color) break;
        cnt++;
    }
    return cnt;
}

/* Evaluate the strength of placing `color` at (x,y).
   Returns a heuristic score (higher = better). */
/* Deprecated: operates on the static board via get_cell(). These functions are
   only valid when the static board is synced (e.g., for AI evaluation via the
   Python wrapper calling set_board_state() first). */
int evaluate_position(int x, int y, int color) {
    if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) return -1;
    if (get_cell(x, y) != EMPTY) return -1;

    int opp = (color == BLACK) ? WHITE : BLACK;
    int score = 0;

    for (int d = 0; d < 4; d++) {
        int dx = dirs[d][0], dy = dirs[d][1];
        int pos_cnt = scan_dir(x, y, dx, dy, color);
        int neg_cnt = scan_dir(x, y, -dx, -dy, color);
        int total = 1 + pos_cnt + neg_cnt;

        int pos_open = (get_cell(x + dx * (pos_cnt + 1), y + dy * (pos_cnt + 1)) == EMPTY) ? 1 : 0;
        int neg_open = (get_cell(x - dx * (neg_cnt + 1), y - dy * (neg_cnt + 1)) == EMPTY) ? 1 : 0;
        int open_ends = pos_open + neg_open;

        /* Score based on consecutive count and open ends */
        if (total >= 5) score += 100000;
        else if (total == 4 && open_ends == 2) score += 10000;
        else if (total == 4 && open_ends == 1) score += 1000;
        else if (total == 3 && open_ends == 2) score += 1000;
        else if (total == 3 && open_ends == 1) score += 100;
        else if (total == 2 && open_ends == 2) score += 100;
        else if (total == 2 && open_ends == 1) score += 10;
        else if (total == 1 && open_ends == 2) score += 10;
    }

    /* Bonus for center proximity */
    int cx = 7, cy = 7;
    int dist = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    score += (50 - dist) > 0 ? (50 - dist) : 0;

    /* Defensive: also check what opponent would gain here */
    for (int d = 0; d < 4; d++) {
        int dx = dirs[d][0], dy = dirs[d][1];
        int opp_pos = scan_dir(x, y, dx, dy, opp);
        int opp_neg = scan_dir(x, y, -dx, -dy, opp);
        int opp_total = 1 + opp_pos + opp_neg;
        if (opp_total >= 4) score += 5000;
        else if (opp_total == 3) score += 500;
        else if (opp_total == 2) score += 50;
    }

    return score;
}

/* Count open-threes for `color` across the entire board. */
int count_open_threes(int color) {
    int count = 0;
    for (int y = 0; y < BOARD_SIZE; y++) {
        for (int x = 0; x < BOARD_SIZE; x++) {
            if (get_cell(x, y) != color) continue;
            for (int d = 0; d < 4; d++) {
                int dx = dirs[d][0], dy = dirs[d][1];
                /* Only count at the start of a line (no same-color predecessor) */
                int prev = get_cell(x - dx, y - dy);
                if (prev == color) continue;
                int line_len = 1 + scan_dir(x, y, dx, dy, color);
                if (line_len == 3) {
                    int end1 = get_cell(x - dx, y - dy);
                    int end2 = get_cell(x + dx * 3, y + dy * 3);
                    if (end1 == EMPTY && end2 == EMPTY) count++;
                }
            }
        }
    }
    return count;
}

/* Count open-fours for `color` across the entire board. */
int count_open_fours(int color) {
    int count = 0;
    for (int y = 0; y < BOARD_SIZE; y++) {
        for (int x = 0; x < BOARD_SIZE; x++) {
            if (get_cell(x, y) != color) continue;
            for (int d = 0; d < 4; d++) {
                int dx = dirs[d][0], dy = dirs[d][1];
                int prev = get_cell(x - dx, y - dy);
                if (prev == color) continue;
                int line_len = 1 + scan_dir(x, y, dx, dy, color);
                if (line_len == 4) {
                    int end1 = get_cell(x - dx, y - dy);
                    int end2 = get_cell(x + dx * 4, y + dy * 4);
                    if (end1 == EMPTY || end2 == EMPTY) count++;
                }
            }
        }
    }
    return count;
}
