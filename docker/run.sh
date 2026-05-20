#!/bin/bash

python /app/Gobang-Game/python_server/server.py

cd /app/Gobang-Game/public && python -m http.server 3000