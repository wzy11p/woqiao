#!/usr/bin/env bash
# One-click installer for WoQiao.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

info() {
  printf "\033[1;34m[install]\033[0m %s\n" "$1"
}

warn() {
  printf "\033[1;33m[install]\033[0m %s\n" "$1"
}

fail() {
  printf "\033[1;31m[install]\033[0m %s\n" "$1" >&2
  exit 1
}

check_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$2"
}

check_python() {
  check_command python3 "Python 3.11+ is required. Please install Python first."
  python3 - <<'PY'
import sys
if sys.version_info < (3, 11):
    raise SystemExit("Python 3.11+ is required.")
print(f"Python {sys.version.split()[0]}")
PY
}

check_ffmpeg() {
  if ! command -v ffmpeg >/dev/null 2>&1; then
    warn "System ffmpeg was not found. The motion workspace uses bundled imageio-ffmpeg; other workflows may require system ffmpeg."
    return 0
  fi
}

ensure_uv() {
  if command -v uv >/dev/null 2>&1; then
    return 0
  fi

  warn "uv was not found. Installing uv with python3 -m pip..."
  python3 -m pip install --user uv

  if ! command -v uv >/dev/null 2>&1; then
    warn "uv is still not on PATH. Falling back to venv + pip for backend dependencies."
    return 1
  fi
}

install_backend() {
  info "Installing backend dependencies..."
  cd "$BACKEND_DIR"

  if [ ! -f "config.yaml" ] && [ -f "config.yaml.example" ]; then
    cp config.yaml.example config.yaml
    warn "Created backend config.yaml from config.yaml.example. Fill in API keys before generating videos."
  fi

  if ensure_uv; then
    uv sync
  else
    python3 -m venv venv
    # shellcheck disable=SC1091
    source venv/bin/activate
    python -m pip install --upgrade pip
    python -m pip install -r requirements.txt
  fi
}

install_frontend() {
  info "Installing frontend dependencies..."
  cd "$FRONTEND_DIR"

  check_command node "Node.js 20.9+ is required. Please install Node.js first."
  check_command npm "npm is required. Please install npm first."
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 20 || (major === 20 && minor < 9)) { console.error("Node.js 20.9+ is required."); process.exit(1); }'

  if [ -f "package-lock.json" ]; then
    npm ci
  else
    npm install
  fi

  if [ "${XYQ_SKIP_FRONTEND_BUILD:-0}" = "1" ]; then
    warn "Skipping frontend build because XYQ_SKIP_FRONTEND_BUILD=1."
  else
    npm run build
  fi
}

main() {
  info "WoQiao one-click install"
  check_python
  check_ffmpeg
  install_backend
  install_frontend

  cat <<EOF

WoQiao installation complete.

Next steps:
  1. Edit backend API keys:
     $BACKEND_DIR/config.yaml

  2. Start backend:
     cd "$BACKEND_DIR"
     uv run python api_server.py
     # or, if uv was unavailable:
     source venv/bin/activate && python api_server.py

  3. Start frontend in a new terminal:
     cd "$FRONTEND_DIR"
     npm start -- --hostname 127.0.0.1

URLs:
  Backend:  http://localhost:8000/api/health
  Frontend: http://localhost:3000
EOF
}

main "$@"
