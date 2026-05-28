FROM bffwjdfjzq3wikw5yl.xuanyuan.run/library/gcc:12.5.0-bookworm AS builder

WORKDIR /app
COPY ./c-core/ ./c-core/
RUN cd c-core/ && \
    make clean && \
    make all

FROM bffwjdfjzq3wikw5yl.xuanyuan.run/library/python:3.13.13 AS runner

WORKDIR /app
COPY ./python-server/ ./python-server/
COPY --from=builder /app/c-core/libgobang.so ./python-server/
RUN pip install -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple -r python-server/requirements.txt

ENV PYTHONUNBUFFERED=1

EXPOSE 8080

ENTRYPOINT [ "python", "python-server/server.py" ]
