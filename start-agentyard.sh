#!/bin/bash
# Agentyard Start Script
# Bu script Agentyard uygulamasını başlatır.

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

echo "Agentyard başlatılıyor: $APP_DIR"

# Electron sandbox sorununa karşı --no-sandbox dene
if npm run build 2>&1; then
    npx electron . --no-sandbox
else
    echo "Build hatası oluştu." >&2
    exit 1
fi
