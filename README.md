# JPlay player

A headless music player for a Raspberry Pi with a good DAC. One box, five sources, controlled from a web page on your phone and a REST API:

- **Radio**: favourites, station search through [Radio Browser](https://www.radio-browser.info), now-playing titles from the stream, automatic reconnect.
- **Plex**: browse your music library through the Plex API (recently added, albums, artists, playlists, search) and play the original files direct. FLAC stays FLAC; no transcoding. Tracks are marked as played in Plex.
- **CD**: insert a disc and it is read into RAM with cd-paranoia straight away, without interrupting what is playing. Press play and the music starts after a second or two, while the rest of the disc is still being read; once it is all in memory the drive rests. No skips, instant seeking and repeats. Album and track names come from MusicBrainz.
- **Spotify Connect**: through librespot. Pick the player in the Spotify app and it takes over.
- **Bluetooth**: phones play to it like a Bluetooth speaker (A2DP), with track info and controls.

Only one source plays at a time. A source that starts on its own (a phone streaming, Spotify selected in the app) takes over from whatever was playing. Inserting a CD doesn't: it is only read until you press play (set `cd.autoplay = true` if you want it to take over).

## How it works

```
 phone / browser / scripts / Home Assistant
            │  REST + WebSocket (/api/v1)
 ┌──────────▼───────────────────────────────────────────────┐
 │ jplay (one Python process)                               │
 │   Source manager: exactly one source owns the DAC        │
 │                                                          │
 │   Radio ─┐                                               │
 │   Plex  ─┼─► mpv (one process, JSON IPC) ─┐              │
 │   CD    ─┘   (CD tracks from RAM)         │              │
 │   Spotify ──► librespot (child process) ──┼─► ALSA hw: ──┼─► DAC
 │   Bluetooth ► bluealsa-aplay (only when active) ─┘       │
 └──────────────────────────────────────────────────────────┘
```

When you switch sources, the old one stops and releases the ALSA device first, then the new one starts. That keeps the output bit-perfect (`hw:` device, no mixing, no resampling): 16-bit/44.1 kHz from a CD reaches the DAC unchanged.

## Hardware

Built for a Raspberry Pi 4 (2 GB or more) and a USB CD drive (with its own power supply or a powered hub), playing through either:

- a **DAC board** on the Pi (HAT), such as the HiFiBerry DAC2 HD, or
- a **USB DAC**.

### Choosing the DAC

Out of the box the output is `auto`: a USB DAC while one is switched on, otherwise the DAC board. HDMI and the Pi's headphone jack are never picked automatically, so a USB DAC that is switched off doesn't send the music to the TV. You can also pick a fixed output on the web page (tap the DAC name at the top right), or set `audio.device` in the config.

- A USB DAC that is switched off disappears from the Pi. JPlay notices within a few seconds, stops what was playing and shows "DAC is off". Switch it on and press play.
- CD and Plex play bit-perfect (`hw:` device). Spotify and Bluetooth go through ALSA's `plughw:`, so a USB DAC that only accepts 24- or 32-bit still works; their audio is already lossy.
- Hardware volume: if the DAC has a volume control, pick it under Output > Volume. Otherwise the output is fixed and you use the amplifier's volume.

## Install on the Pi

On Raspberry Pi OS Lite (64-bit):

```bash
sudo apt-get install -y git
sudo git clone https://github.com/jpvaneerde/player-jplay /opt/player-jplay
sudo bash /opt/player-jplay/deploy/install.sh
```

The installer adds mpv, cd-paranoia, librespot (from the Raspotify package), BlueZ and BlueALSA, creates a `jplay` system user, sets up a virtualenv and starts the `jplay` service. Skip parts with `SKIP_SPOTIFY=1` or `SKIP_BLUETOOTH=1`.

For a DAC board such as the DAC2 HD, add this to `/boot/firmware/config.txt` and reboot (a USB DAC needs nothing):

```
dtoverlay=hifiberry-dacplushd
dtparam=audio=off
```

Then edit `/etc/jplay/config.toml` (see [config.example.toml](config.example.toml)) and add your Plex server:

```toml
[plex]
url = "http://192.168.1.10:32400"
token = "your-X-Plex-Token"
```

and restart: `sudo systemctl restart jplay`. Open `http://<pi-name>.local:8080`.

**Update** after a `git pull`: `sudo systemctl restart jplay` (re-run the installer if `pyproject.toml` changed).

**Logs**: `journalctl -u jplay -f`

## The web interface

The page has the same look as the rest of JPlay (JPlay, JPlay Records, JPlaying Now): dark, light and retro themes (the round button at the top right), emerald accent, and a spinning record when there is no cover. Now playing, transport keys and volume are at the top; below them the sources, where the green lamp shows which one is playing through the DAC. Add it to your phone's home screen to use it like an app.

## API

Everything the web page does goes through the API. Interactive docs are at `/api/docs`; the OpenAPI spec is at `/api/v1/openapi.json`.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/v1/status` | Active source, now playing, capabilities, volume, all sources |
| WS | `/api/v1/events` | Pushes the same snapshot on every change (position at most once a second) |
| POST | `/api/v1/player/{play,pause,toggle,stop,next,previous}` | Transport for the active source |
| POST | `/api/v1/player/seek` | `{"position": 83.5}` |
| GET / PUT | `/api/v1/volume` | `{"volume": 0-100}` (needs `audio.mixer_control`) |
| POST | `/api/v1/sources/{id}/activate` | Make a source active |
| GET | `/api/v1/output` | Sound cards found, which one is used, volume controls per card |
| PUT | `/api/v1/output` | `{"device": "auto"}` or `{"device": "hw:CARD=DAC,DEV=0", "mixer_control": ""}` |
| GET | `/api/v1/radio/favourites` | Favourite stations; POST adds, DELETE `/{uuid}` removes |
| GET | `/api/v1/radio/search?name=&country=&tag=` | Search Radio Browser |
| POST | `/api/v1/radio/play` | `{"uuid": "..."}` (a favourite) or `{"station": {...}}` |
| GET | `/api/v1/plex/libraries` | Music libraries |
| GET | `/api/v1/plex/sections/{key}/{artist\|album}?start=&size=&sort=` | Browse a library, paged |
| GET | `/api/v1/plex/items/{key}/children` | Albums of an artist, tracks of an album or playlist |
| GET | `/api/v1/plex/recent`, `/plex/playlists`, `/plex/search?q=` | Recently added, playlists, search |
| POST | `/api/v1/plex/play` | `{"key": "123", "index": 0, "shuffle": false}`: album, artist, playlist or track |
| GET / POST | `/api/v1/plex/queue`, `/plex/queue/{index}` | The play queue; jump to an entry |
| GET | `/api/v1/cd` | Disc, tracks, how much is in memory |
| POST | `/api/v1/cd/play`, `/cd/eject` | `{"track": 3}` |
| GET | `/api/v1/bluetooth` | Paired devices, discoverable state |
| POST | `/api/v1/bluetooth/discoverable` | `{"on": true}` lets a new phone pair for 3 minutes |
| POST / DELETE | `/api/v1/bluetooth/devices/{address}[/connect\|/disconnect]` | Manage devices |

The status `now_playing` object is the same for every source:

```json
{
  "state": "playing",
  "title": "So What", "artist": "Miles Davis", "album": "Kind of Blue",
  "art_url": "/api/v1/plex/art?path=...", "duration": 545.0, "position": 12.4,
  "track_number": 1, "queue_index": 0, "queue_length": 5,
  "extra": {"codec": "flac", "samplerate": 44100}
}
```

### Logging plays (JPlay Spins)

Set `webhook.url` and every track that plays at least `min_seconds` is POSTed as JSON, from any source, with real metadata:

```json
{"player": "JPlay", "source": "cd", "title": "So What", "artist": "Miles Davis",
 "album": "Kind of Blue", "duration": 545.0, "started_at": 1792400000.0, "played_seconds": 30}
```

### JPlaying Now

A display can read `GET /api/v1/status`, or better, keep a WebSocket open on `/api/v1/events` and redraw on each message.

## Development

Runs on any Linux PC with mpv installed; with `device = "null"` it plays silently.

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev,bluetooth]"
python -m pytest
```

A fake Plex server is included for working on the UI without a real one:

```bash
python -m tests.fake_plex --port 32400 --audio-dir /some/folder/with/wav/files
```

then a config with `[plex] url = "http://127.0.0.1:32400"`, `token = "x"` and `[audio] device = "null"`, and run `python -m jplay --config that.toml --debug`.

To try the Output page without sound cards, point `JPLAY_ASOUND_PROC` at a copy of a Pi's `/proc/asound` (`tests/test_output.py` shows the layout).

## Known limits

- **Spotify** can only be controlled from the Spotify app; librespot has no remote-control interface. JPlay shows what is playing and can end the session.
- **CD pre-emphasis**: the few early CDs mastered with pre-emphasis are flagged on the display but not yet corrected.
- **Bluetooth pairing** accepts any device while "Pair a new device" is on (3 minutes), like most speakers.
- The API has no login. Keep the player on your home network.

## Layout

```
jplay/
  app.py              FastAPI app and routes
  config.py           TOML config with defaults
  core/               manager, mpv engine, output (DAC choice), ALSA card detection,
                      models, events, state store, volume, play log
  sources/            radio, plex, cd, spotify, bluetooth
  hooks/              librespot event hook
  web/                the web interface (no build step)
deploy/               installer and systemd units
tests/                unit tests, Plex integration test, fake Plex server
```
