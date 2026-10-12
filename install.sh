#!/bin/sh
# kinoko's installer for Linux and macOS: the binary for this system, from GitHub Releases, checked
# against the release's SHA256SUMS, into ~/.local/bin; put on your PATH when it is not.
#
#   curl -fsSL https://raw.githubusercontent.com/LaraGuardiola/kinoko/main/install.sh | sh
#
# KINOKO_VERSION=v0.2.0      a given release (default: the latest)
# KINOKO_INSTALL_DIR=...     where the binary goes (default: ~/.local/bin)
# KINOKO_NO_MODIFY_PATH=1    never touch your shell's startup file
# On Windows: install.ps1.

set -eu

REPO="LaraGuardiola/kinoko"
VERSION="${KINOKO_VERSION:-latest}"
DIR="${KINOKO_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  echo "kinoko: $1" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "$(uname -s) is not supported here (on Windows: install.ps1, see the README)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no kinoko for $(uname -m) yet" ;;
esac
asset="kinoko-$os-$arch"

# Where the files are: a release on GitHub, or KINOKO_DOWNLOAD_URL (a mirror, a test).
if [ -n "${KINOKO_DOWNLOAD_URL:-}" ]; then
  base="$KINOKO_DOWNLOAD_URL"
elif [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$1" -O "$2"
  else
    fail "needs curl or wget"
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $asset ($VERSION)..."
fetch "$base/$asset" "$tmp/kinoko" || fail "could not download $base/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download the release's checksums"

want="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d ' ' -f 1)"
if command -v sha256sum >/dev/null 2>&1; then
  got="$(sha256sum "$tmp/kinoko" | cut -d ' ' -f 1)"
else
  got="$(shasum -a 256 "$tmp/kinoko" | cut -d ' ' -f 1)"
fi
[ -n "$want" ] && [ "$want" = "$got" ] || fail "the download does not match its checksum: not installed"

mkdir -p "$DIR"
chmod 755 "$tmp/kinoko"
mv -f "$tmp/kinoko" "$DIR/kinoko"
echo "Installed $("$DIR/kinoko" --version) to $DIR/kinoko"

case ":$PATH:" in
  *":$DIR:"*)
    echo "Run: kinoko"
    exit 0
    ;;
esac

# Not on the PATH yet: added in the shell's startup file (once), unless asked not to.
case "$(basename "${SHELL:-sh}")" in
  zsh) rc="$HOME/.zshrc" line="export PATH=\"$DIR:\$PATH\"" ;;
  bash) rc="$HOME/.bashrc" line="export PATH=\"$DIR:\$PATH\"" ;;
  fish) rc="$HOME/.config/fish/config.fish" line="fish_add_path \"$DIR\"" ;;
  *) rc="$HOME/.profile" line="export PATH=\"$DIR:\$PATH\"" ;;
esac
if [ "${KINOKO_NO_MODIFY_PATH:-}" = 1 ]; then
  echo "$DIR is not on your PATH. Add it with: $line"
  exit 0
fi
mkdir -p "$(dirname "$rc")"
if ! grep -qsF "$line" "$rc"; then
  printf '\n# kinoko\n%s\n' "$line" >>"$rc"
fi
echo "Added $DIR to your PATH in $rc. Open a new terminal (or: $line), then run: kinoko"
