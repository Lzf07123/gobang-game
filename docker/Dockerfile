FROM python:latest

WORKDIR /app
RUN git clone https://github.com/Lzf07123/Gobang-Game.git && \
    cd Gobang-Game && \
    pip install -r python_server/requirements.txt &&\
    cd c_core/ && \
    make && \
    cp libgobang.so ../python_server/

EXPOSE 8080
EXPOSE 3000

ENTRYPOINT ["python", "/app/Gobang-Game/python_server/server.py"]
