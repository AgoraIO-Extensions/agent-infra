#!/bin/sh
set -eu

proxy_token=${PLATFORM_PROXY_TOKEN:-}
proxy_scheme=${PLATFORM_PROXY_SCHEME:-https}
proxy_required=${PLATFORM_PROXY_TOKEN_REQUIRED:-false}
case "$proxy_required" in true) [ -n "$proxy_token" ] || { echo "PLATFORM_PROXY_TOKEN is required" >&2; exit 1; } ;; esac
case "$proxy_token" in *[!A-Za-z0-9_-]*) echo "invalid proxy token format" >&2; exit 1 ;; esac
case "$proxy_scheme" in http|https) ;; *) echo "invalid proxy scheme" >&2; exit 1 ;; esac
# URL.pathname from the deployment's registered callback, never a request value.
callback_path=${PLATFORM_CONNECTION_CALLBACK_PATH:-/api/connection-installations/callback}
export PLATFORM_CONNECTION_CALLBACK_PATH="$callback_path"
callback_location=$(awk 'BEGIN {
    path = ENVIRON["PLATFORM_CONNECTION_CALLBACK_PATH"];
    if (substr(path, 1, 1) != "/" || path ~ /[?#[:space:][:cntrl:]]/) exit 1;
    hex = "0123456789abcdef";
    for (i = 1; i <= length(path); i++) {
        c = substr(path, i, 1);
        if (c == "%") {
            a = index(hex, tolower(substr(path, i + 1, 1))) - 1;
            b = index(hex, tolower(substr(path, i + 2, 1))) - 1;
            if (i + 2 > length(path) || a < 0 || b < 0) exit 1;
            value = a * 16 + b;
            if (value < 32 || value == 127) exit 1;
            c = sprintf("%c", value); i += 2;
        }
        if (c == "\\" || c == "\"") printf "\\";
        printf "%s", c;
    }
}') || { echo "invalid PLATFORM_CONNECTION_CALLBACK_PATH" >&2; exit 1; }
# Escape only the sed replacement; Nginx gets one quoted, literal location.
callback_location=$(printf '%s' "$callback_location" | sed 's/[\\&|]/\\&/g')
login_mode=${PLATFORM_WEB_LOGIN_MODE:-build}
case "$login_mode" in build|oidc) ;; *) echo "invalid PLATFORM_WEB_LOGIN_MODE" >&2; exit 1 ;; esac
mkdir -p /tmp/nginx-conf
sed -e "s/__PLATFORM_WEB_LOGIN_MODE__/$login_mode/g" -e "s/__PLATFORM_PROXY_TOKEN__/$proxy_token/g" -e "s/__PLATFORM_PROXY_SCHEME__/$proxy_scheme/g" -e "s|__PLATFORM_CONNECTION_CALLBACK_PATH__|$callback_location|g" /etc/nginx/conf.d/default.conf.template > /tmp/nginx-conf/default.conf
exec "$@"
