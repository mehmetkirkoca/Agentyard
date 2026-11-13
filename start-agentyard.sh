#!/bin/bash
# Agentyard Start Script
# Bu script Agentyard uygulamasını başlatır.

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

echo "Agentyard başlatılıyor: $APP_DIR"

CHROME_SANDBOX="node_modules/electron/dist/chrome-sandbox"

sandbox_ready() {
    [ "$(stat -c '%U:%a' "$CHROME_SANDBOX" 2>/dev/null)" = "root:4755" ]
}

# npm ci ve Electron güncellemeleri chrome-sandbox izinlerini sıfırlar; Electron o zaman açılmaz.
offer_sandbox_fix() {
    [ -f "$CHROME_SANDBOX" ] && [ -t 0 ] || return 1
    echo "chrome-sandbox izinleri bozuk; düzeltmek için sudo gerekiyor:"
    echo "  sudo chown root:root $CHROME_SANDBOX"
    echo "  sudo chmod 4755 $CHROME_SANDBOX"
    read -r -p "Şimdi düzeltilsin mi? [e/H] " answer
    case "$answer" in
        e|E|y|Y) sudo chown root:root "$CHROME_SANDBOX" && sudo chmod 4755 "$CHROME_SANDBOX" ;;
        *) return 1 ;;
    esac
}

ELECTRON_ARGS=()
if [ "$(uname)" = "Linux" ]; then
    ELECTRON_ARGS+=(--ozone-platform=x11)
    if ! sandbox_ready; then
        offer_sandbox_fix
        if ! sandbox_ready; then
            echo "UYARI: Chromium sandbox kapalı (--no-sandbox). chrome-sandbox izinlerini düzeltmek için README'ye bakın." >&2
            ELECTRON_ARGS+=(--no-sandbox)
        fi
    fi
fi

unset npm_config_prefix NPM_CONFIG_PREFIX
if [ -d "$HOME/.nvm/versions/node" ]; then
    LATEST_NVM_NODE="$(ls -d "$HOME/.nvm/versions/node"/v* 2>/dev/null | sort -V | tail -n 1)"
    [ -n "$LATEST_NVM_NODE" ] && export PATH="$LATEST_NVM_NODE/bin:$PATH"
fi

if npm run build 2>&1; then
    unset npm_config_prefix NPM_CONFIG_PREFIX
    ./node_modules/.bin/electron . "${ELECTRON_ARGS[@]}"
else
    echo "Build hatası oluştu." >&2
    exit 1
fi
