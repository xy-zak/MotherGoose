#!/usr/bin/env sh
# Cross-compiles MotherGoose for Windows, macOS and Linux into dist/.
# Usage: scripts/build.sh [version]
set -eu
cd "$(dirname "$0")/.."
VERSION="${1:-$(date +%Y.%m.%d)}"
mkdir -p dist
for target in windows/amd64 windows/arm64 darwin/arm64 darwin/amd64 linux/amd64 linux/arm64; do
  os="${target%/*}"; arch="${target#*/}"
  out="dist/mothergoose-$os-$arch"
  [ "$os" = windows ] && out="$out.exe"
  echo "building $out"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$out" ./cmd/mothergoose
done
echo "done: $(ls dist | wc -l) binaries in dist/"
