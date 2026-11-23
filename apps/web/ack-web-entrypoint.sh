#!/bin/sh
set -eu

proxy_token=${PLATFORM_PROXY_TOKEN:-}
proxy_scheme=${PLATFORM_PROXY_SCHEME:-https}
proxy_required=${PLATFORM_PROXY_TOKEN_REQUIRED:-false}
case "$proxy_required" in true) [ -n "$proxy_token" ] || { echo "PLATFORM_PROXY_TOKEN is required" >&2; exit 1; } ;; esac
case "$proxy_token" in *[!A-Za-z0-9_-]*) echo "invalid proxy token format" >&2; exit 1 ;; esac
case "$proxy_scheme" in http|https) ;; *) echo "invalid proxy scheme" >&2; exit 1 ;; esac
login_mode=${PLATFORM_WEB_LOGIN_MODE:-build}
case "$login_mode" in build|oidc) ;; *) echo "invalid PLATFORM_WEB_LOGIN_MODE" >&2; exit 1 ;; esac
mkdir -p /tmp/nginx-conf
sed -e "s/__PLATFORM_WEB_LOGIN_MODE__/$login_mode/g" -e "s/__PLATFORM_PROXY_TOKEN__/$proxy_token/g" -e "s/__PLATFORM_PROXY_SCHEME__/$proxy_scheme/g" /etc/nginx/conf.d/default.conf.template > /tmp/nginx-conf/default.conf
exec "$@"
