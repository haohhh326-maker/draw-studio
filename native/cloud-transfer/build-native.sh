#!/usr/bin/env bash
set -euo pipefail

# Build preserved, unmodified upstream sources first, then the canvas IPC adapter.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "$script_dir/../.." && pwd)"
"$script_dir/build-official-engine.sh"
build_root="$project_root/.cache/native-filezilla-official"
prefix="$build_root/prefix"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LD_LIBRARY_PATH="$prefix/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
cmake -S "$script_dir" -B "$build_root/bridge" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH="$prefix" -DFILEZILLA_BUILD_ROOT="$build_root" \
  -DCMAKE_BUILD_RPATH="$prefix/lib"
cmake --build "$build_root/bridge" -j "${NATIVE_BUILD_JOBS:-4}"
"$build_root/bridge/cloud-transfer-bridge" --version
