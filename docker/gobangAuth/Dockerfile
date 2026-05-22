FROM bffwjdfjzq3wikw5yl.xuanyuan.run/library/gcc:12.5.0-bookworm AS builder

WORKDIR /app
COPY ./c_core/ ./c_core/
RUN cd c_core/ && \
    make


FROM bffwjdfjzq3wikw5yl.xuanyuan.run/library/python:3.13.13 AS runner

WORKDIR /app
COPY ./python_server/ .
COPY --from=builder /app/c_core/libgobang.so .
RUN pip install -r python_server/requirements.txt

EXPOSE 8080

ENTRYPOINT ["python", "python_server.py"]
CMD ["--port", "8080"]
