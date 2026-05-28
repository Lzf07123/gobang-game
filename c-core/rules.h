#ifndef RULES_H
#define RULES_H

#include "board.h"

#define FORBID_NONE          0
#define FORBID_DOUBLE_THREE  1
#define FORBID_DOUBLE_FOUR   2
#define FORBID_OVERLINE      3

/* Shared direction vectors for line-scanning algorithms */
extern const int dirs[4][2];

int check_winner(int last_x, int last_y);
int get_win_line(int last_x, int last_y, int out_xs[5], int out_ys[5]);
int check_winner_on(const int board[BOARD_SIZE][BOARD_SIZE], int last_x, int last_y);
int get_win_line_on(const int board[BOARD_SIZE][BOARD_SIZE], int last_x, int last_y,
                    int out_xs[5], int out_ys[5]);
int check_forbidden(int x, int y);
int is_over_line(int x, int y);
int is_double_three(int x, int y);
int is_double_four(int x, int y);

#endif
