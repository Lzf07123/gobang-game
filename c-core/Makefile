all: libgobang.so

libgobang.so: gobang.c gobang.h
	gcc -shared -fPIC -o libgobang.so gobang.c

clean:
	rm -f libgobang.so

run: all
	cp libgobang.so ../python_server/
