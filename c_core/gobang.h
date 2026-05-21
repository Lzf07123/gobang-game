#ifndef GOBANG_H
#define GOBANG_H

#define BOARD_SIZE 15
#define EMPTY 0
#define BLACK 1
#define WHITE 2

void board_init(void);
int place_piece(int x, int y, int color);
int check_winner(void);
void reset_game(void);
void set_current_player(int color);
int get_current_player(void);

#endif
