#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
BUILD="$ROOT/.build"
mkdir -p "$BUILD/downloads" "$BUILD/src" "$BUILD/bin" "$BUILD/lib" "$BUILD/modules" "$ROOT/dist"

fetch() {
  name=$1 url=$2 digest=$3
  file="$BUILD/downloads/$name"
  if [ ! -f "$file" ]; then
    curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 "$url" -o "$file.tmp"
    mv "$file.tmp" "$file"
  fi
  printf '%s  %s\n' "$digest" "$file" | shasum -a 256 -c -
}
unpack() {
  name=$1 archive=$2
  if [ ! -f "$BUILD/src/$name/.unpacked" ]; then
    mkdir -p "$BUILD/src/$name"
    tar -xzf "$BUILD/downloads/$archive" --strip-components=1 -C "$BUILD/src/$name"
    touch "$BUILD/src/$name/.unpacked"
  fi
}
fetch lua.tar.gz https://www.lua.org/ftp/lua-5.4.8.tar.gz 4f18ddae154e793e46eeab727c59ef1c0c0c2b744e7b94219710d76f530629ae
fetch system.tar.gz https://codeload.github.com/lunarmodules/luasystem/tar.gz/edeec63394684c9281d0a28a8f50c70f39a78e62 1689056786266ead115094c5182423d44933bbc2cf59f87b2f392c064bd1957a
fetch utf8.tar.gz https://codeload.github.com/starwing/luautf8/tar.gz/0.3.0 90dfd94fa051978167b36edeb744b0751bedfc53f73d2609fd11124c31a9a1c3
fetch posix.tar.gz https://codeload.github.com/luaposix/luaposix/tar.gz/e6b94b37c19c4bd19a7dc475a4f4cb56f61f5da9 7af5edde30c790490e71bb7e84c0055f138c53321928fd65ceab4743502d21f3
fetch luastatic.tar.gz https://codeload.github.com/ers35/luastatic/tar.gz/c3e1b2ef8f998230fb4c47935e4bdcb1610abab5 ee38d5ccc24bc914fd8536315b47f5f112add63c448244485b47ef4c71088d74
fetch lunajson.tar.gz https://codeload.github.com/grafi-tt/lunajson/tar.gz/250afac121df831f449d6370ddf406673f6f9c2b 4b5e780558fbd843941323aa9fa293fdff1ba73d43124e98aa243ec2e6da19da
for name in lua system utf8 posix luastatic lunajson; do unpack "$name" "$name.tar.gz"; done
case "$(uname -s):$(uname -m)" in
  Linux:x86_64) platform=linux; shared='-shared'; extra='-ldl -lm -lrt';;
  Darwin:arm64) platform=macosx; shared='-bundle -undefined dynamic_lookup'; extra='-lm';;
  *) echo 'Supported build hosts: macOS arm64 and Linux x64' >&2; exit 1;;
esac
CC=${CC:-cc}
export CC
if [ "$platform" = macosx ]; then
  make -C "$BUILD/src/lua/src" all MYCFLAGS='-fPIC' SYSCFLAGS='-DLUA_USE_MACOSX' CC="$CC"
else
  make -C "$BUILD/src/lua" "$platform" MYCFLAGS='-fPIC' CC="$CC"
fi
cp "$BUILD/src/lua/src/lua" "$BUILD/src/lua/src/luac" "$BUILD/bin/"
LUA="$BUILD/src/lua/src"
CFLAGS="-O2 -fPIC -I$LUA"
mkdir -p "$BUILD/obj" "$BUILD/lib/posix/sys" "$BUILD/lib/system" "$BUILD/modules/system"
# LuaSystem and POSIX modules are built both as shared objects for source-mode
# tests and as static objects for the self-contained executable.
objects=
for source in core compat time environment random term bitflags wcwidth; do
  obj="$BUILD/obj/system-$source.o"
  "$CC" $CFLAGS -c "$BUILD/src/system/src/$source.c" -o "$obj"
  objects="$objects $obj"
done
"$CC" $shared $objects $extra -o "$BUILD/lib/system/core.so"
ar rcs "$BUILD/lib/system.a" $objects
objects=
for module in unistd fcntl sys/stat sys/wait signal poll dirent stdlib errno sys/utsname; do
  obj="$BUILD/obj/posix-$(echo "$module" | tr / -).o"
  "$CC" $CFLAGS -I"$BUILD/src/posix/ext/include" -D_POSIX_C_SOURCE=200809L -D_XOPEN_SOURCE=700 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE '-DPACKAGE="luaposix"' '-DVERSION="36.3"' -c "$BUILD/src/posix/ext/posix/$module.c" -o "$obj"
  "$CC" $shared "$obj" $extra -o "$BUILD/lib/posix/$module.so"
  objects="$objects $obj"
done
rm -f "$BUILD/lib/posix.a"
ar rcs "$BUILD/lib/posix.a" $objects
"$CC" $CFLAGS -Dluaopen_utf8=luaopen_luautf8 -c "$BUILD/src/utf8/lutf8lib.c" -o "$BUILD/obj/utf8.o"
"$CC" $shared "$BUILD/obj/utf8.o" $extra -o "$BUILD/lib/luautf8.so"
ar rcs "$BUILD/lib/luautf8.a" "$BUILD/obj/utf8.o"
rm -rf "$BUILD/modules/lunajson"
mkdir -p "$BUILD/modules/lunajson"
cp "$BUILD/src/lunajson/src/lunajson/sax.lua" "$BUILD/src/lunajson/src/lunajson/encoder.lua" "$BUILD/modules/lunajson/"
printf '%s\n' 'return require("luautf8")' > "$BUILD/modules/lua-utf8.lua"
cp "$BUILD/src/system/system/init.lua" "$BUILD/modules/system/init.lua"
"$BUILD/bin/lua" - "$ROOT/lua/rex-worktrees.lua" "$BUILD/modules/assets.lua" <<'LUA'
local input = assert(io.open(arg[1], 'rb'))
local source = assert(input:read('*a'))
input:close()
local output = assert(io.open(arg[2], 'wb'))
assert(output:write('return { plugin = ', string.format('%q', source), ' }\n'))
assert(output:close())
LUA
# Stage names relative to the luastatic working directory: they become require names.
STAGE="$BUILD/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "$ROOT"/src/*.lua "$STAGE/"
mkdir -p "$STAGE/system" "$STAGE/lunajson"
cp "$BUILD/modules/system/init.lua" "$STAGE/system/init.lua"
cp "$BUILD/modules/lunajson/"*.lua "$STAGE/lunajson/"
cp "$BUILD/modules/assets.lua" "$BUILD/modules/lua-utf8.lua" "$STAGE/"
printf '%s\n' 'REX_WORKTREES_COMPILED = true' 'require("main")' > "$STAGE/entry.lua"
cd "$STAGE"
# All module paths are relative, so luastatic registers clean module names.
set -- entry.lua
for file in $(find . -name '*.lua' ! -name entry.lua | LC_ALL=C sort); do set -- "$@" "$file"; done
"$BUILD/bin/lua" "$BUILD/src/luastatic/luastatic.lua" "$@" "$BUILD/lib/system.a" "$BUILD/lib/posix.a" "$BUILD/lib/luautf8.a" "$LUA/liblua.a" "-I$LUA" $extra
cp entry "$ROOT/dist/rex-worktrees"
