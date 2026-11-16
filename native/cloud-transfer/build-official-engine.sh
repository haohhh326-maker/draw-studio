#!/usr/bin/env bash
set -euo pipefail

# Build the unmodified FileZilla Client engine and unmodified SSH dependencies.
# The original bridge's build and runtime prefix remain untouched.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "$script_dir/../.." && pwd)"
build_root="$project_root/.cache/native-filezilla-official"
vendor="$script_dir/vendor"
prefix="$build_root/prefix"
jobs="${NATIVE_BUILD_JOBS:-4}"
if [[ ! "$jobs" =~ ^[1-9][0-9]?$ ]] || (( jobs > 32 )); then
  echo "NATIVE_BUILD_JOBS must be between 1 and 32." >&2
  exit 1
fi

for tool in g++ gcc make ninja pkg-config python3 msgfmt; do
  command -v "$tool" >/dev/null || { echo "Missing build tool: $tool" >&2; exit 1; }
done
pkg-config --exists 'gnutls >= 3.7.0' 'gmp >= 6.2' libargon2 || {
  echo "Missing development libraries: GnuTLS >= 3.7, GMP >= 6.2, libargon2." >&2
  exit 1
}
for source in nettle-3.10.2 libfilezilla-0.57.0 fzssh-1.4.0-upstream filezilla-3.71.0 boost-regex-1.86.0; do
  test -d "$vendor/$source" || { echo "Missing preserved upstream source: $source" >&2; exit 1; }
done

mkdir -p "$build_root" "$prefix/include"
# FileZilla's unmodified configure requires standalone Boost.Regex >= 1.76
# with libstdc++; keep this header-only dependency private to this prefix.
cp -a "$vendor/boost-regex-1.86.0/include/." "$prefix/include/"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LD_LIBRARY_PATH="$prefix/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export CPPFLAGS="-I$prefix/include${CPPFLAGS:+ $CPPFLAGS}"
export LDFLAGS="-L$prefix/lib -Wl,-rpath,$prefix/lib${LDFLAGS:+ $LDFLAGS}"

# Reuse only the already verified build-tool installation, never the old libraries.
if [[ -d "$project_root/.cache/native-cloud-transfer/python/mesonbuild" ]]; then
  export PYTHONPATH="$project_root/.cache/native-cloud-transfer/python${PYTHONPATH:+:$PYTHONPATH}"
fi
python3 -m mesonbuild.mesonmain --version >/dev/null || {
  echo "Missing Meson >= 1.3. Install it locally or provide the verified cached wheel." >&2
  exit 1
}

mkdir -p "$build_root/nettle"
(
  cd "$build_root/nettle"
  if [[ ! -f Makefile ]]; then
    "$vendor/nettle-3.10.2/configure" --prefix="$prefix" --libdir="$prefix/lib" --disable-static --enable-shared --disable-documentation
  fi
  make -s -j "$jobs"
  make -s install
)

mkdir -p "$build_root/libfilezilla"
(
  cd "$build_root/libfilezilla"
  if [[ ! -f Makefile ]]; then
    "$vendor/libfilezilla-0.57.0/configure" --prefix="$prefix" --libdir="$prefix/lib" --disable-static --enable-shared --disable-nls
  fi
  make -s -j "$jobs"
  make -s install
)

meson=(python3 -m mesonbuild.mesonmain)
if [[ ! -f "$build_root/fzssh/build.ninja" ]]; then
  "${meson[@]}" setup "$build_root/fzssh" "$vendor/fzssh-1.4.0-upstream" --prefix="$prefix" --libdir=lib --buildtype=release
fi
"${meson[@]}" compile -C "$build_root/fzssh" -j "$jobs"
"${meson[@]}" test -C "$build_root/fzssh" --print-errorlogs
"${meson[@]}" install -C "$build_root/fzssh"

mkdir -p "$build_root/filezilla"
(
  cd "$build_root/filezilla"
  if [[ ! -f Makefile ]]; then
    "$vendor/filezilla-3.71.0/configure" --prefix="$prefix" --libdir="$prefix/lib" --disable-gui --disable-ftp --enable-sftp --disable-storj --disable-locales --disable-precomp --disable-autoupdatecheck --disable-manualupdatecheck --without-dbus --with-pugixml=builtin
  fi
  make -s -j "$jobs"
  make -s install
)

printf 'Official FileZilla Client engine: %s\n' "$prefix/lib/libfzclient-private-3.71.0.so"
printf 'Generated FileZilla headers: %s\n' "$build_root/filezilla/config"
printf 'Source FileZilla headers: %s\n' "$vendor/filezilla-3.71.0/src/include"
pkg-config --modversion libfilezilla libfzssh-client nettle hogweed
