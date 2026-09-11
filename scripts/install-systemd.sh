#!/usr/bin/env bash
set -euo pipefail
if [ "${EUID}" -ne 0 ]; then echo "Run this script with sudo."; exit 1; fi
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="${SUDO_USER:-$(whoami)}"
NODE="$(command -v node)"
NPM="$(command -v npm)"
cat >/etc/systemd/system/mx-preflight.service <<SERVICE
[Unit]
Description=MX Preflight dnsx Web UI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=${NPM} start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable --now mx-preflight
systemctl status mx-preflight --no-pager
