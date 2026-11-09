#!/usr/bin/env bash
# Copy the annotator, with its scene data, to a self-contained folder (default: the lab's shared project folder).
#   annotator/deploy.sh [DEST]          DEST default /project/3dlg-hcvc/3darch/annotator
# Code is replaced; scene data (data/) is added and updated but never removed, so scenes dropped straight into
# DEST/data/ stay. Saves and logs go to DEST/../outputs/annotator/ and are never touched.
# Plain `rsync -a` fails on /project (changing files to the user's own group hits a quota error and leaves them
# mode 600), so files get the destination's group (setgid folder) and group-writable modes instead.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-/project/3dlg-hcvc/3darch/annotator}"
RS=(rsync -rltp --chmod=D2775,F664)

mkdir -p "$DEST/data/annotations" "$DEST/data/scans"
chmod 2775 "$DEST" "$DEST/data" "$DEST/data/annotations" "$DEST/data/scans"
"${RS[@]}" --delete --exclude .git/ --exclude .gitignore --exclude data/ --exclude __pycache__/ --exclude '*.pyc' "$SRC/" "$DEST/"
"${RS[@]}" --update "$SRC/data/" "$DEST/data/"          # --update: a newer file already there (edited there) wins
chmod 775 "$DEST/run.sh" "$DEST/deploy.sh" "$DEST/tools/make_scan.py"
mkdir -p "$DEST/../outputs/annotator" && chmod 2775 "$DEST/../outputs" "$DEST/../outputs/annotator"
echo "copied to $DEST ($(du -sh "$DEST" | cut -f1)); restart the server to load new code: $DEST/run.sh"
