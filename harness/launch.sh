#!/usr/bin/env bash
# Launch Obsidian 1.14.4 on a virtual display with a fresh vault containing the
# plugin build in $1 (a dir holding main.js, manifest.json, styles.css).
# Usage: launch.sh <plugin-build-dir> <label>
set -euo pipefail
S=/tmp/claude-0/-home-claude/bd680580-8d94-5d28-afee-f09303200664/scratchpad
BUILD="$1"; LABEL="$2"
APP="$S/obsidian-app/squashfs-root"
RUN="$S/run-$LABEL"
VAULT="$RUN/vault"
CFG="$RUN/config"

pkill -f "squashfs-root/obsidian" || true
pkill -f "Xvfb :99" || true
sleep 1
rm -rf "$RUN"
mkdir -p "$VAULT/.obsidian/plugins/terminal" "$CFG/obsidian"
cp "$BUILD"/{main.js,manifest.json,styles.css} "$VAULT/.obsidian/plugins/terminal/"
echo '["terminal"]' > "$VAULT/.obsidian/community-plugins.json"
echo '{}' > "$VAULT/.obsidian/app.json"
echo '{"theme":"obsidian"}' > "$VAULT/.obsidian/appearance.json"
printf '# Caret test vault\n' > "$VAULT/Welcome.md"
cat > "$CFG/obsidian/obsidian.json" <<EOF
{"vaults":{"c4re7test0000001":{"path":"$VAULT","ts":$(date +%s)000,"open":true}},"updateDisabled":true}
EOF

Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
sleep 1
export DISPLAY=:99 XDG_CONFIG_HOME="$CFG" LANG=en_US.UTF-8
nohup "$APP/obsidian" --no-sandbox --disable-gpu --remote-debugging-port=9222 \
  --user-data-dir="$CFG/obsidian" >"$RUN/obsidian.log" 2>&1 &
for _ in $(seq 1 60); do
  curl -s http://127.0.0.1:9222/json/version >/dev/null && break
  sleep 1
done
curl -s http://127.0.0.1:9222/json/list | head -c 600; echo
