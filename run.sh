#!/usr/bin/env bash
# Start the annotator server (standard-library Python 3.8+ only).
#   ./run.sh [PORT] [more server.py options]       PORT default 8017
# Public at https://aspis.cs.sfu.ca/3darch-annotator/ through the lab's reverse proxy (-> localhost:PORT).
# Access key: put one line (8+ characters of A-Z a-z 0-9 _ -) in ~/.annotator_key, or set ANNOTATOR_KEY.
cd "$(dirname "$0")"
PORT="${1:-8017}"; shift || true
if [ -z "${ANNOTATOR_KEY:-}" ] && [ -r "$HOME/.annotator_key" ]; then ANNOTATOR_KEY="$(tr -d '[:space:]' < "$HOME/.annotator_key")"; fi
export ANNOTATOR_KEY="${ANNOTATOR_KEY:-}"
exec python3 server.py --port "$PORT" --base /3darch-annotator "$@"
