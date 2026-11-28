#!/usr/bin/env bash
# Verify the complete file before letting the installer see it.
fetch() (
	local url=$1 expected=$2 output=$3 partial actual attempt status http_status
	local max_time=${4:-300} speed_limit=${5:-0} speed_time=${6:-0} max_attempts=${7:-4} checksum_status=${8:-1}
	local curl_args

	if [[ ! "$max_time" =~ ^[1-9][0-9]*$ || ! "$speed_limit" =~ ^[0-9]+$ || ! "$speed_time" =~ ^[0-9]+$ || ! "$max_attempts" =~ ^[1-9][0-9]*$ || ! "$checksum_status" =~ ^[1-9][0-9]*$ ]]; then
		printf 'invalid deploy tool download limits\n' >&2
		return 64
	fi

	partial=$(mktemp "${output}.part.XXXXXX") || return 1
	trap 'rm -f "$partial"' EXIT

	curl_args=(
		--fail --location --proto '=https' --tlsv1.2 --silent --show-error
		--connect-timeout 10 --max-time "$max_time" --continue-at -
		--header 'Accept: application/octet-stream' --output "$partial"
		--write-out '%{http_code}' "$url"
	)
	if (( speed_limit > 0 )); then
		curl_args+=(--speed-limit "$speed_limit" --speed-time "$speed_time")
	fi

	for ((attempt = 1; attempt <= max_attempts; attempt++)); do
		if http_status=$(curl "${curl_args[@]}"); then
			actual=$(sha256sum "$partial" | awk '{print $1}')
			if [[ "$actual" != "$expected" ]]; then
				printf 'checksum mismatch for %s: expected %s, got %s\n' "$url" "$expected" "$actual" >&2
				return "$checksum_status"
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
		if (( attempt < max_attempts )); then sleep "$((1 << (attempt - 1)))"; fi
	done
	printf 'deploy tool download failed after %s attempts: %s\n' "$max_attempts" "$url" >&2
	return "$status"
)
