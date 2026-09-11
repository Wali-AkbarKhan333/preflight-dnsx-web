#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$PROJECT_ROOT/tools"
VERSION="${DNSX_VERSION:-1.3.1}"

echo "== MX Preflight Linux setup =="
command -v node >/dev/null 2>&1 || { echo "Node.js 22.5+ is required."; exit 1; }
NODE_VERSION="$(node -p "process.versions.node")"
MAJOR="$(printf '%s' "$NODE_VERSION" | cut -d. -f1)"
MINOR="$(printf '%s' "$NODE_VERSION" | cut -d. -f2)"
if [ "$MAJOR" -lt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -lt 5 ]; }; then
  echo "Node.js 22.5+ is required. Current: $(node -v)"
  exit 1
fi
command -v curl >/dev/null 2>&1 || { echo "curl is required."; exit 1; }
command -v unzip >/dev/null 2>&1 || { echo "unzip is required."; exit 1; }
mkdir -p "$TOOLS"

if [ ! -x "$TOOLS/dnsx" ]; then
  case "$(uname -m)" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "Unsupported architecture: $(uname -m)"; exit 1 ;;
  esac
  URL="https://github.com/projectdiscovery/dnsx/releases/download/v${VERSION}/dnsx_${VERSION}_linux_${ARCH}.zip"
  echo "Downloading dnsx v${VERSION} (${ARCH})..."
  curl -fL "$URL" -o "$TOOLS/dnsx.zip"
  unzip -o "$TOOLS/dnsx.zip" -d "$TOOLS"
  rm -f "$TOOLS/dnsx.zip"
  chmod +x "$TOOLS/dnsx"
fi

"$TOOLS/dnsx" -version
cd "$PROJECT_ROOT"
[ -f .env ] || cp .env.example .env
echo "Setup complete. Run: ./scripts/run-linux.sh"
