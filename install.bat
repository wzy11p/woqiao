@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

set "ROOT_DIR=%~dp0"
set "BACKEND_DIR=%ROOT_DIR%backend"
set "FRONTEND_DIR=%ROOT_DIR%frontend"

echo [install] WoQiao one-click install

where python >nul 2>nul
if errorlevel 1 (
  echo [install] Python 3.11+ is required. Please install Python first.
  exit /b 1
)

python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"
if errorlevel 1 (
  echo [install] Python 3.11+ is required. Please upgrade Python first.
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [install] Node.js 20.9+ is required. Please install Node.js first.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [install] npm is required. Please install npm first.
  exit /b 1
)

node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major < 20 || (major === 20 && minor < 9) ? 1 : 0)"
if errorlevel 1 (
  echo [install] Node.js 20.9+ is required. Please upgrade Node.js first.
  exit /b 1
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [install] System ffmpeg was not found. The motion workspace uses bundled imageio-ffmpeg; other workflows may require system ffmpeg.
)

cd /d "%BACKEND_DIR%"
if not exist "config.yaml" if exist "config.yaml.example" (
  copy "config.yaml.example" "config.yaml" >nul
  echo [install] Created backend config.yaml from config.yaml.example. Fill in API keys before generating videos.
)

where uv >nul 2>nul
if errorlevel 1 (
  echo [install] uv was not found. Installing uv with python -m pip...
  python -m pip install --user uv
)

where uv >nul 2>nul
if errorlevel 1 (
  echo [install] uv is still not on PATH. Falling back to venv + pip.
  python -m venv venv
  if errorlevel 1 exit /b 1
  call venv\Scripts\activate.bat
  if errorlevel 1 exit /b 1
  python -m pip install --upgrade pip
  if errorlevel 1 exit /b 1
  python -m pip install -r requirements.txt
  if errorlevel 1 exit /b 1
) else (
  uv sync
  if errorlevel 1 exit /b 1
)

cd /d "%FRONTEND_DIR%"
if exist "package-lock.json" (
  call npm ci
  if errorlevel 1 exit /b 1
) else (
  call npm install
  if errorlevel 1 exit /b 1
)

if "%XYQ_SKIP_FRONTEND_BUILD%"=="1" (
  echo [install] Skipping frontend build because XYQ_SKIP_FRONTEND_BUILD=1.
) else (
  call npm run build
  if errorlevel 1 exit /b 1
)

echo.
echo [install] WoQiao installation complete.
echo.
echo Next steps:
echo   1. Edit backend API keys:
echo      %BACKEND_DIR%\config.yaml
echo.
echo   2. Start backend:
echo      cd /d "%BACKEND_DIR%"
echo      uv run python api_server.py
echo      or: venv\Scripts\activate.bat ^&^& python api_server.py
echo.
echo   3. Start frontend in a new terminal:
echo      cd /d "%FRONTEND_DIR%"
echo      npm start -- --hostname 127.0.0.1
echo.
echo URLs:
echo   Backend:  http://localhost:8000/api/health
echo   Frontend: http://localhost:3000

endlocal
