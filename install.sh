#!/bin/sh
# Courier command-line tool — installer for Linux and macOS.
#
#   curl -fsSL https://github.com/ah-yu/courier.dev/raw/main/install.sh | sh
#
# What it does: picks the build for this machine, downloads the release, checks it against the
# release manifest, and puts `courier-cli` in ~/.local/bin. Running it again is safe: it replaces
# the binary and touches nothing else.
#
# Environment:
#   COURIER_CLI_RELEASE_URL  another download base (a mirror, or one fixed release)
#   COURIER_CLI_BIN_DIR      install somewhere other than ~/.local/bin
set -eu

BASE=${COURIER_CLI_RELEASE_URL:-https://github.com/ah-yu/courier.dev/releases/latest/download}
BIN_DIR=${COURIER_CLI_BIN_DIR:-$HOME/.local/bin}

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t courier-cli)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

os=$(uname -s 2>/dev/null || echo unknown)
arch=$(uname -m 2>/dev/null || echo unknown)

case "$os:$arch" in
  Linux:x86_64) asset=courier-cli-linux-x64; platform=linux-x64 ;;
  Darwin:arm64) asset=courier-cli-darwin-arm64; platform=darwin-arm64 ;;
  Darwin:x86_64) die "this Mac is Intel; only Apple Silicon builds are published" ;;
  Linux:*) die "Linux on $arch is not supported (x64 only)" ;;
  *) die "$os on $arch is not supported by this installer" ;;
esac

mkdir -p "$BIN_DIR" || die "cannot create $BIN_DIR"

say "Downloading courier-cli for $platform..."
if command -v curl >/dev/null 2>&1; then
  # Progress is useful on a terminal and noise in a log, so only show it when someone is watching.
  curl_args="-fL --retry 3"
  [ -t 2 ] || curl_args="$curl_args -sS"
  # shellcheck disable=SC2086
  curl $curl_args -o "$tmp/$asset" "$BASE/$asset" || die "download failed"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$tmp/$asset" "$BASE/$asset" || die "download failed"
else
  die "curl or wget is required"
fi

# Check the download against the release manifest when one is published. The manifest is a single
# JSON object; flattening it is enough to read this platform's checksum without a JSON tool.
if curl -fsSL -o "$tmp/manifest.json" "$BASE/courier-cli-manifest.json" 2>/dev/null; then
  expected=$(tr -d ' \n\r\t' <"$tmp/manifest.json" |
    sed -n "s/.*\"$platform\":{[^}]*\"sha256\":\"\([0-9a-f]\{64\}\)\".*/\1/p")
  if [ -n "$expected" ] && command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
    [ "$actual" = "$expected" ] || die "the download does not match the release checksum"
  elif [ -n "$expected" ] && command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)
    [ "$actual" = "$expected" ] || die "the download does not match the release checksum"
  fi
fi

chmod +x "$tmp/$asset"
mv -f "$tmp/$asset" "$BIN_DIR/courier-cli"

say "Installed $BIN_DIR/courier-cli"
"$BIN_DIR/courier-cli" version || warn "the installed file did not run"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say ""
    say "$BIN_DIR is not in your PATH yet. Add it, then open a new terminal:"
    say "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile"
    ;;
esac
