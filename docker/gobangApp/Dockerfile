FROM bffwjdfjzq3wikw5yl.xuanyuan.run/library/python:3.13.13 AS runner

WORKDIR /app
COPY ./public/ .
COPY ./python_server/requirements.txt .
RUN pip install -r requirements.txt

ENTRYPOINT [ "python", "-m", "http.server", "3000" ]



