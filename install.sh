#!/usr/bin/env sh
set -e

REPO="DarkPhoenix2704/girlfriend"
INSTALL_DIR="${GIRLFRIEND_INSTALL_DIR:-/usr/local/bin}"
GPG_KEY_URL="https://github.com/DarkPhoenix2704.gpg"

# ── Detect OS / arch ──────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)
    case "$ARCH" in
      x86_64) ARTIFACT="girlfriend-linux-x64" ;;
      *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
    esac
    ;;
  Darwin)
    case "$ARCH" in
      arm64)  ARTIFACT="girlfriend-darwin-arm64" ;;
      *) echo "Unsupported architecture: $ARCH (only Apple Silicon supported on macOS)" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

# ── Resolve latest tag ────────────────────────────────────────────────────────
VERSION="${GIRLFRIEND_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
fi

BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"

# ── Download ──────────────────────────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading girlfriend ${VERSION} (${ARTIFACT})..."
curl -fsSL "${BASE_URL}/${ARTIFACT}"      -o "${TMP}/girlfriend"
curl -fsSL "${BASE_URL}/${ARTIFACT}.asc"  -o "${TMP}/girlfriend.asc"
curl -fsSL "${BASE_URL}/SHA256SUMS"       -o "${TMP}/SHA256SUMS"
curl -fsSL "${BASE_URL}/SHA256SUMS.asc"   -o "${TMP}/SHA256SUMS.asc"

# ── Verify GPG signatures ─────────────────────────────────────────────────────
if command -v gpg >/dev/null 2>&1; then
  echo "Verifying GPG signatures..."
  # Import the publisher's public key from GitHub
  curl -fsSL "$GPG_KEY_URL" | gpg --import --quiet 2>/dev/null || true
  gpg --verify "${TMP}/SHA256SUMS.asc" "${TMP}/SHA256SUMS"
  gpg --verify "${TMP}/girlfriend.asc" "${TMP}/girlfriend"
  echo "Signatures verified."
else
  echo "Warning: gpg not found, skipping signature verification." >&2
fi

# ── Verify checksum ───────────────────────────────────────────────────────────
echo "Verifying checksum..."
EXPECTED="$(grep "${ARTIFACT}" "${TMP}/SHA256SUMS" | awk '{print $1}')"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "${TMP}/girlfriend" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "${TMP}/girlfriend" | awk '{print $1}')"
else
  echo "Warning: no sha256 tool found, skipping checksum." >&2
  ACTUAL="$EXPECTED"
fi

if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "Checksum mismatch! Expected: $EXPECTED  Got: $ACTUAL" >&2
  exit 1
fi
echo "Checksum OK."

# ── Install ───────────────────────────────────────────────────────────────────
chmod +x "${TMP}/girlfriend"

if [ -w "$INSTALL_DIR" ]; then
  mv "${TMP}/girlfriend" "${INSTALL_DIR}/girlfriend"
else
  echo "Installing to ${INSTALL_DIR} (sudo required)..."
  sudo mv "${TMP}/girlfriend" "${INSTALL_DIR}/girlfriend"
fi

echo ""
echo "girlfriend ${VERSION} installed to ${INSTALL_DIR}/girlfriend"
echo "Run: girlfriend"
