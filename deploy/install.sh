#!/usr/bin/env bash
# JPlay installer for Raspberry Pi OS Lite (Bookworm or newer).
#
#   sudo git clone https://github.com/jpvaneerde/player-jplay /opt/player-jplay
#   sudo bash /opt/player-jplay/deploy/install.sh
#
# Options (environment variables):
#   SKIP_SPOTIFY=1     don't install librespot
#   SKIP_BLUETOOTH=1   don't install or configure Bluetooth audio
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$REPO/.venv"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi
if [[ "$REPO" != "/opt/player-jplay" ]]; then
  echo "Note: the service file expects the code in /opt/player-jplay (found $REPO)."
  echo "      Edit /etc/systemd/system/jplay.service if you keep it elsewhere."
fi

say "Installing system packages"
apt-get update
apt-get install -y --no-install-recommends \
  python3 python3-venv python3-pip mpv cd-paranoia eject alsa-utils curl ca-certificates

if [[ -z "${SKIP_BLUETOOTH:-}" ]]; then
  apt-get install -y --no-install-recommends bluez bluez-tools bluez-alsa-utils
fi

if [[ -z "${SKIP_SPOTIFY:-}" ]] && ! command -v librespot >/dev/null; then
  say "Installing librespot (from the Raspotify package)"
  curl -sL https://dtcooper.github.io/raspotify/install.sh | sh
fi
# JPlay starts librespot itself; the stand-alone Raspotify service must not grab the DAC.
if systemctl list-unit-files raspotify.service >/dev/null 2>&1; then
  systemctl disable --now raspotify.service 2>/dev/null || true
fi

say "Creating the jplay user"
if ! id jplay >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/jplay --shell /usr/sbin/nologin jplay
fi
for g in audio cdrom bluetooth; do
  getent group "$g" >/dev/null && usermod -aG "$g" jplay
done

say "Setting up the Python environment in $VENV"
python3 -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip wheel >/dev/null
# Editable install: 'git pull' + 'systemctl restart jplay' is all an update needs.
"$VENV/bin/pip" install -e "$REPO[bluetooth]"

say "Configuration"
install -d -m 755 /etc/jplay
if [[ ! -f /etc/jplay/config.toml ]]; then
  install -m 640 -g jplay "$REPO/config.example.toml" /etc/jplay/config.toml
  echo "Created /etc/jplay/config.toml - add your Plex URL and token there."
else
  echo "Keeping the existing /etc/jplay/config.toml"
fi

if [[ -z "${SKIP_BLUETOOTH:-}" ]]; then
  say "Bluetooth audio receiver"
  # BlueALSA: act as a speaker (A2DP sink) only.
  install -d /etc/systemd/system/bluealsa.service.d
  cat > /etc/systemd/system/bluealsa.service.d/jplay.conf <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/bluealsa -S -p a2dp-sink
EOF
  # JPlay runs bluealsa-aplay itself, only while Bluetooth is the active source.
  systemctl disable --now bluealsa-aplay.service 2>/dev/null || true
  install -m 644 "$REPO/deploy/bt-agent.service" /etc/systemd/system/bt-agent.service
  # Show up as a loudspeaker in phones' Bluetooth lists.
  if grep -q '^#\?Class' /etc/bluetooth/main.conf; then
    sed -i 's/^#\?Class *=.*/Class = 0x200414/' /etc/bluetooth/main.conf
  else
    sed -i '/^\[General\]/a Class = 0x200414' /etc/bluetooth/main.conf
  fi
  systemctl daemon-reload
  systemctl enable --now bluetooth.service bluealsa.service bt-agent.service
  systemctl restart bluetooth.service bluealsa.service
fi

say "Starting JPlay"
install -m 644 "$REPO/deploy/jplay.service" /etc/systemd/system/jplay.service
sed -i "s#/opt/player-jplay#$REPO#g" /etc/systemd/system/jplay.service
systemctl daemon-reload
systemctl enable jplay.service
systemctl restart jplay.service

say "Updates"
# The separate updater: checks GitHub a few times a day; the web page (Output) shows the version and updates.
bash "$REPO/deploy/install-updater.sh"

say "Done"
echo "Open http://$(hostname).local:8080 on your phone."
if ! grep -qiE 'hifiberry|USB-Audio' /proc/asound/cards 2>/dev/null; then
  cat <<'EOF'

No DAC board or USB DAC found. A USB DAC just needs to be plugged in and switched on.
For a HiFiBerry DAC2 HD, add these lines to /boot/firmware/config.txt and reboot:
    dtoverlay=hifiberry-dacplushd
    dtparam=audio=off
EOF
fi
