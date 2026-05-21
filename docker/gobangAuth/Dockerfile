FROM bffwjdfjzq3wikw5yl.xuanyuan.run/library/debian:13.5

WORKDIR /app
RUN apt-get update && \
    apt-get install -y git && \
    apt-get install -y python-is-python3 && \
    git clone https://github.com/Lzf07123/Gobang-Game.git && \
    cd Gobang-Game && \
    pip install -r python_server/requirements.txt &&\
    cd c_core/ && \
    make && \
    cp libgobang.so ../python_server/

EXPOSE 8080
EXPOSE 3000

ENTRYPOINT ["bash", "/app/Gobang-Game/docker/run.sh"]
