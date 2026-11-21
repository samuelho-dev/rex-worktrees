.PHONY: build check test clean

LUA_PATH := $(CURDIR)/src/?.lua;$(CURDIR)/.build/modules/?.lua;$(CURDIR)/.build/modules/?/init.lua;;
LUA_CPATH := $(CURDIR)/.build/lib/?.so;;
export LUA_PATH LUA_CPATH

build:
	./scripts/build.sh

check: build
	find src lua test -name '*.lua' -print0 | xargs -0 -n 1 .build/bin/luac -p

test: build
	.build/bin/lua test/run.lua

clean:
	rm -rf .build dist
