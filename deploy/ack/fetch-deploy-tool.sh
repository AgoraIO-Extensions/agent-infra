#!/usr/bin/env bash
# Verify the complete file before letting the installer see it.
fetch() (
	local url=$1 expected=$2 output=$3 partial actual attempt status http_status
	partial=$(mktemp "${output}.part.XXXXXX") || return 1
	trap 'rm -f "$partial"' EXIT

	for attempt in 1 2 3 4; do
		if http_status=$(curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error \
			--connect-timeout 10 --max-time 300 --continue-at - --header 'Accept: application/octet-stream' \
			--output "$partial" --write-out '%{http_code}' "$url"); then
			actual=$(sha256sum "$partial" | awk '{print $1}')
			if [[ "$actual" != "$expected" ]]; then
				printf 'checksum mismatch for %s: expected %s, got %s\n' "$url" "$expected" "$actual" >&2
				return 1
			fi
			mv -f "$partial" "$output"
			return
		else
			status=$?
		fi
		# A server that declines a Range request can still serve the whole file.
		if [[ "$status" == 33 || "$status" == 36 || "$http_status" == 416 ]]; then
			: > "$partial"
		fi
		if (( attempt < 4 )); then sleep "$((1 << (attempt - 1)))"; fi
	done
	printf 'deploy tool download failed after four attempts: %s\n' "$url" >&2
	return "$status"
)
