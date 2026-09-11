#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
[ -x tools/dnsx ] || ./scripts/setup-linux.sh
[ -f .env ] || cp .env.example .env
exec npm start
