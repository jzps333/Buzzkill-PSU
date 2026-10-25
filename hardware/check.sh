#!/bin/bash
# Checks the whole brick: settings, speaker, backend, NFC, services.   Run:  bash check.sh
cd "$(dirname "$0")"
ok()  { echo "✅ $1"; }
bad() { echo "❌ $1"; echo "   → $2"; }

# ---------- settings ----------
[ -f .env ] || { bad ".env is missing" "cp .env.example .env, then fill it in"; exit 1; }
set -a; . ./.env; set +a
[[ "$SUPABASE_SERVICE_KEY" == sb_secret* ]] && ok "Secret key is in .env" \
  || bad "No secret key in .env" "paste the sb_secret key from Supabase → Project Settings → API Keys"
[ -n "$BT_SPEAKER_MAC" ] && ok "Speaker address in .env: $BT_SPEAKER_MAC" \
  || bad "BT_SPEAKER_MAC is empty in .env" "set BT_SPEAKER_MAC=18:90:67:DE:D2:E1"

# ---------- speaker ----------
if [ -n "$BT_SPEAKER_MAC" ]; then
  info=$(bluetoothctl info "$BT_SPEAKER_MAC" 2>/dev/null)
  grep -q "Paired: yes" <<<"$info" || bad "JBL isn't paired" "see '3. JBL Go 3' in README.md"
  grep -q "Connected: yes" <<<"$info" && ok "JBL is connected" \
    || bad "JBL isn't connected" "turn it on, then: bluetoothctl connect $BT_SPEAKER_MAC"
fi
if wpctl inspect @DEFAULT_AUDIO_SINK@ 2>/dev/null | grep -q bluez; then
  ok "Sound goes to the Bluetooth speaker"
else
  bad "Sound isn't going to the Bluetooth speaker" "wpctl status → find the JBL under Sinks → wpctl set-default <number>"
fi

# ---------- backend ----------
api="$SUPABASE_URL/rest/v1"
code=$(curl -s -o /tmp/buzzkill-check.json -w "%{http_code}" "$api/speakers?select=id,last_seen" \
       -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY")
case "$code" in
  200) ok "Backend (Supabase) reachable, key works" ;;
  000) bad "Can't reach Supabase" "check the Pi's internet: ping -c 2 google.com" ;;
  401|403) bad "Supabase refused the key" "the secret key in .env is wrong" ;;
  404) bad "No 'speakers' table" "run backend/speaker.sql in the Supabase SQL Editor" ;;
  *) bad "Supabase answered $code" "$(head -c 200 /tmp/buzzkill-check.json)" ;;
esac
if [ "$code" = 200 ]; then
  age=$(python3 - "${SPEAKER_ID:-brick}" <<'EOF'
import json, sys
from datetime import datetime, timezone
rows = {r["id"]: r for r in json.load(open("/tmp/buzzkill-check.json"))}
r = rows.get(sys.argv[1])
print(int((datetime.now(timezone.utc) - datetime.fromisoformat(r["last_seen"])).total_seconds()) if r else -1)
EOF
)
  if [ "$age" -ge 0 ] && [ "$age" -lt 20 ]; then
    ok "Host page sees the speaker online (checked in ${age}s ago)"
  else
    bad "Host page sees the speaker as offline" "start it: systemctl --user restart buzzkill-speaker"
  fi
fi

# ---------- LCD ----------
i2c=$(i2cdetect -y 1 2>/dev/null)
if grep -q " 3e" <<<"$i2c"; then
  ok "LCD found"
else
  bad "LCD not found" "plug it into an I2C port, then: i2cdetect -y 1 (should show 3e)"
fi

# ---------- programs ----------
for s in buzzkill-speaker buzzkill; do
  systemctl --user is-active --quiet $s && ok "$s is running" \
    || bad "$s isn't running" "systemctl --user enable --now $s   (logs: journalctl --user -u $s -n 30)"
done
loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q yes && ok "Keeps running after you log out" \
  || bad "Stops when you log out" "sudo loginctl enable-linger $USER"

echo
echo "Touch sensor: run 'python3 test_touch.py' and touch it (stop the brick first: systemctl --user stop buzzkill)."
