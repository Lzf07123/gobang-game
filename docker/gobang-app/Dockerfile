FROM python:3.13.13 AS runner

WORKDIR /app
COPY ./public/ .
COPY ./python-server/requirements.txt .
RUN pip install -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple -r requirements.txt

EXPOSE 3000

ENTRYPOINT [ "python", "-m", "http.server", "3000" ]



