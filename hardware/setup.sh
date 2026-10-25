#!/bin/bash
# Run once on the Pi:  bash setup.sh
set -e
cd "$(dirname "$0")"

sudo apt update
sudo apt install -y python3-gpiozero python3-lgpio python3-requests \
  espeak-ng mpg123 bluez pipewire pipewire-pulse pipewire-alsa wireplumber libspa-0.2-bluetooth

# Let sound + the brick keep running after you log out of SSH
sudo loginctl enable-linger "$USER"
systemctl --user enable --now pipewire pipewire-pulse wireplumber

[ -f .env ] || cp .env.example .env

mkdir -p ~/.config/systemd/user
sed "s#__DIR__#$PWD#" buzzkill.service > ~/.config/systemd/user/buzzkill.service
cp buzzkill-speaker.service ~/.config/systemd/user/
systemctl --user daemon-reload
echo "Done. Next: pair the speaker and fill in .env (see README), then:"
echo "  systemctl --user enable --now buzzkill-speaker buzzkill"
