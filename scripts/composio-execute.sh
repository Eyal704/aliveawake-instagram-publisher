#!/usr/bin/env bash
# Workflow-safe replacement for: "$COMPOSIO" execute TOOL ...
# It prints the normal full JSON response whether Composio returned it inline
# or offloaded a large response to outputFilePath.
set -euo pipefail

composio_binary=${COMPOSIO:-${HOME}/.composio/composio}
raw=$("$composio_binary" execute "$@")

if ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$raw"; then
  echo "Composio returned invalid JSON for ${1:-unknown tool}." >&2
  exit 1
fi

if [ "$(jq -r '.storedInFile // false' <<<"$raw")" = "true" ] || [ -n "$(jq -r '.outputFilePath // empty' <<<"$raw")" ]; then
  output_file=$(jq -r '.outputFilePath // empty' <<<"$raw")
  if [ -z "$output_file" ] || [ ! -r "$output_file" ]; then
    echo "Composio offloaded ${1:-unknown tool} output, but outputFilePath is missing or unreadable: $output_file" >&2
    exit 1
  fi
  raw=$(<"$output_file")
fi

if ! jq -e 'type == "object" and (.successful != false) and (.error == null) and has("data")' >/dev/null 2>&1 <<<"$raw"; then
  echo "Composio ${1:-unknown tool} response is failed or has no data key after output resolution." >&2
  jq '{successful, error, hasData: has("data")}' <<<"$raw" >&2 || true
  exit 1
fi

printf '%s\n' "$raw"
