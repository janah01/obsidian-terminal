#!/usr/bin/env bash
# Fresh vault + Obsidian, record the screen while the sweep runs.
# Usage: record.sh <plugin-build-dir> <run-label> <hud-label> <out-dir>
set -euo pipefail
S=/tmp/claude-0/-home-claude/bd680580-8d94-5d28-afee-f09303200664/scratchpad
BUILD="$1"; RUN="$2"; HUD="$3"; OUT="$4"
mkdir -p "$OUT"
bash "$S/harness/launch.sh" "$BUILD" "$RUN" >/dev/null
sleep 6
DISPLAY=:99 ffmpeg -v error -f x11grab -framerate 15 -video_size 1280x800 -i :99 \
  -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -movflags +faststart \
  -y "$OUT/sweep.mp4" &
FF=$!
cd "$S/harness"
node sweep.mjs "$HUD" "$OUT" 2>&1 | tee "$OUT/sweep.log" | grep -E "^(PASS|FAIL|T7|SUMMARY)" | cut -c1-140 || true
sleep 1
kill -INT "$FF"; wait "$FF" || true
ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/sweep.mp4"
