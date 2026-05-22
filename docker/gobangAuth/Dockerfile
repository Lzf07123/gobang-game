FROM bffwjdfjzq3wikw5yl.xuanyuan.run/library/gcc:12.5.0-bookworm AS builder

WORKDIR /app
COPY ./c_core/ ./c_core/
RUN cd c_core/ && \
    make

FROM bffwjdfjzq3wikw5yl.xuanyuan.run/library/python:3.13.13 AS runner

WORKDIR /app
COPY ./python_server/ ./python_server/
COPY --from=builder /app/c_core/libgobang.so ./python_server/
RUN pip install -r python_server/requirements.txt

EXPOSE 8080

ENTRYPOINT [ "bash", "-c", "sleep 5 && python python_server/server.py" ]
