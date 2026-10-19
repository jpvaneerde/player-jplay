"""Audio CD: read the disc into RAM with cd-paranoia, then play from memory.

* The drive is polled with Linux CD-ROM ioctls (no udev dependency).
* Tracks are read in play order into a tmpfs (/dev/shm). Playback starts as soon as the
  first needed track is in, the rest follow in the background; then the drive spins down.
* Disc metadata comes from MusicBrainz (by disc ID) and is cached on disk.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import logging
import os
import re
import shutil
from pathlib import Path
from typing import Any

from ..core.models import Capabilities, PlayState
from .base import SourceError
from .engine_source import EngineSource

log = logging.getLogger(__name__)

# linux/cdrom.h
CDROM_DRIVE_STATUS = 0x5326
CDROM_DISC_STATUS = 0x5327
CDSL_CURRENT = 0x7FFFFFFF
CDS_DISC_OK = 4
CDS_AUDIO = 100
CDS_MIXED = 105

USER_AGENT = "JPlay/0.1 ( https://github.com/jpvaneerde/player-jplay )"

_TOC_LINE = re.compile(
    r"^\s*(\d+)\.\s+(\d+)\s+\[[^\]]*\]\s+(\d+)\s+\[[^\]]*\]\s+(\w+)\s+(\w+)\s+(\d+)", re.M
)


# ---------------------------------------------------------------- pure helpers (unit tested)
def parse_paranoia_toc(text: str) -> list[dict[str, Any]]:
    """Parse `cd-paranoia -Q` output into [{number, start, length, preemphasis}] (sectors)."""
    tracks = []
    for m in _TOC_LINE.finditer(text):
        number, length, start, _copy, pre, _ch = m.groups()
        tracks.append(
            {"number": int(number), "start": int(start), "length": int(length), "preemphasis": pre == "yes"}
        )
    return tracks


def musicbrainz_disc_id(first: int, last: int, leadout: int, offsets: list[int]) -> str:
    """MusicBrainz disc ID. Offsets and lead-out are absolute sectors (LBA + 150)."""
    padded = list(offsets) + [0] * (99 - len(offsets))
    text = f"{first:02X}{last:02X}{leadout:08X}" + "".join(f"{o:08X}" for o in padded)
    digest = base64.b64encode(hashlib.sha1(text.encode("ascii")).digest()).decode("ascii")
    return digest.replace("+", ".").replace("/", "_").replace("=", "-")


def disc_id_from_toc(tracks: list[dict[str, Any]]) -> str:
    first, last = tracks[0]["number"], tracks[-1]["number"]
    leadout = tracks[-1]["start"] + tracks[-1]["length"] + 150
    return musicbrainz_disc_id(first, last, leadout, [t["start"] + 150 for t in tracks])


def parse_musicbrainz(data: dict[str, Any], disc_id: str) -> dict[str, Any] | None:
    """Pick the release/medium that contains this exact disc and return album + track names."""

    def credit(ac: list[dict[str, Any]] | None) -> str:
        return "".join(f"{c.get('name', '')}{c.get('joinphrase', '')}" for c in (ac or []))

    for release in data.get("releases", []):
        for medium in release.get("media", []):
            if not any(d.get("id") == disc_id for d in medium.get("discs", [])):
                continue
            album_artist = credit(release.get("artist-credit"))
            tracks = {}
            for t in medium.get("tracks", []):
                try:
                    pos = int(t.get("position") or t.get("number"))
                except (TypeError, ValueError):
                    continue
                tracks[pos] = {
                    "title": t.get("title") or (t.get("recording") or {}).get("title", ""),
                    "artist": credit(t.get("artist-credit")) or album_artist,
                }
            has_front = (release.get("cover-art-archive") or {}).get("front")
            return {
                "album": release.get("title", ""),
                "artist": album_artist,
                "year": (release.get("date") or "")[:4],
                "release_id": release.get("id"),
                "art_url": f"https://coverartarchive.org/release/{release['id']}/front-500" if has_front else "",
                "medium": medium.get("position"),
                "media_count": len(release.get("media", [])),
                "tracks": tracks,
            }
    return None


def _drive_status(device: str) -> str:
    """'audio', 'data', 'empty' or 'error'. Linux only."""
    import fcntl

    try:
        fd = os.open(device, os.O_RDONLY | os.O_NONBLOCK)
    except OSError:
        return "error"
    try:
        if fcntl.ioctl(fd, CDROM_DRIVE_STATUS, CDSL_CURRENT) != CDS_DISC_OK:
            return "empty"
        disc = fcntl.ioctl(fd, CDROM_DISC_STATUS, 0)
        return "audio" if disc in (CDS_AUDIO, CDS_MIXED) else "data"
    except OSError:
        return "empty"
    finally:
        os.close(fd)


# ---------------------------------------------------------------- the source
class CdSource(EngineSource):
    id = "cd"
    name = "CD"

    def __init__(self, ctx):
        super().__init__(ctx)
        self.device = self.cfg.get("device", "/dev/sr0")
        self.paranoia = self.cfg.get("paranoia_binary", "cd-paranoia")
        self.cache_dir = Path(self.cfg.get("cache_dir", "/dev/shm/jplay-cd"))
        self.meta_dir = ctx.state_dir / "cd-metadata"
        self.status = "empty"  # empty | reading-toc | ready | data | error
        self.disc: dict[str, Any] | None = None
        self.ripped: set[int] = set()
        self.rip_progress: dict[str, Any] = {}
        self.base: int | None = None  # track number at mpv playlist index 0
        self.appended_upto: int | None = None  # last track number in mpv's playlist
        self.current: int | None = None
        self._poll_task: asyncio.Task[None] | None = None
        self._rip_task: asyncio.Task[None] | None = None
        self._rip_proc: asyncio.subprocess.Process | None = None
        self._rip_wakeup = asyncio.Event()
        self._track_ready: dict[int, asyncio.Event] = {}

    # ------------------------------------------------------------ startup / polling
    async def start(self) -> None:
        ok, reason = self.engine_ready()
        if not ok:
            self.set_available(False, reason)
            return
        if shutil.which(self.paranoia) is None:
            self.set_available(False, f"'{self.paranoia}' is not installed")
            return
        try:
            import fcntl  # noqa: F401
        except ImportError:
            self.set_available(False, "CD playback needs Linux")
            return
        if not Path(self.device).exists():
            # The drive may be plugged in later; keep polling.
            self.set_available(True, f"No drive at {self.device} yet")
        else:
            self.set_available(True)
        self._poll_task = asyncio.create_task(self._poll(), name="cd-poll")

    async def shutdown(self) -> None:
        if self._poll_task:
            self._poll_task.cancel()
        await self._stop_ripping()
        self._clear_cache()

    async def _poll(self) -> None:
        last = None
        while True:
            try:
                state = await asyncio.to_thread(_drive_status, self.device)
            except Exception:
                state = "error"
            if state != last:
                last = state
                await self._drive_changed(state)
            await asyncio.sleep(1.5)

    async def _drive_changed(self, state: str) -> None:
        log.info("CD drive: %s", state)
        if state == "error":
            self.set_available(True, f"No drive at {self.device}")
        else:
            self.set_available(True)
        if state == "audio":
            await self._load_disc()
        else:
            await self._disc_gone(data=state == "data")

    # ------------------------------------------------------------ disc handling
    async def _load_disc(self) -> None:
        self.status = "reading-toc"
        self.ctx.manager.notify(True)
        proc = await asyncio.create_subprocess_exec(
            self.paranoia, "-d", self.device, "-Q",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await proc.communicate()
        toc = parse_paranoia_toc(out.decode(errors="replace"))
        if not toc:
            log.warning("Could not read the CD's table of contents")
            self.status = "error"
            self.ctx.manager.notify(True)
            return
        disc_id = disc_id_from_toc(toc)
        self.disc = {
            "disc_id": disc_id,
            "album": "Audio CD",
            "artist": "",
            "year": "",
            "art_url": "",
            "tracks": [
                {
                    "number": t["number"],
                    "title": f"Track {t['number']}",
                    "artist": "",
                    "duration": round(t["length"] / 75, 1),
                    "preemphasis": t["preemphasis"],
                }
                for t in toc
            ],
        }
        self.ripped.clear()
        self._track_ready = {t["number"]: asyncio.Event() for t in toc}
        self.status = "ready"
        self._clear_cache()
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._rip_task = asyncio.create_task(self._rip_loop(), name="cd-rip")
        self.ctx.manager.notify(True)
        asyncio.create_task(self._lookup_metadata(disc_id))
        if self.cfg.get("autoplay", True):
            asyncio.create_task(self._autoplay(toc[0]["number"]))

    async def _autoplay(self, number: int) -> None:
        try:
            await self.play_track(number)
        except SourceError as exc:
            log.info("Autoplay skipped: %s", exc)

    async def _disc_gone(self, data: bool = False) -> None:
        had_disc = self.disc is not None
        if self.active and had_disc:
            await self.engine.release(self)
        await self._stop_ripping()
        self._clear_cache()
        for ev in self._track_ready.values():
            ev.set()  # release any play_track() still waiting for a read
        self.disc = None
        self.ripped.clear()
        self.rip_progress = {}
        self.base = self.appended_upto = self.current = None
        self.status = "data" if data else "empty"
        self.reset_now_playing()

    async def eject(self) -> None:
        await self._disc_gone()
        proc = await asyncio.create_subprocess_exec(
            "eject", self.device, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise SourceError(f"Eject failed: {err.decode(errors='replace').strip()}", 500)

    def _clear_cache(self) -> None:
        shutil.rmtree(self.cache_dir, ignore_errors=True)

    # ------------------------------------------------------------ metadata
    async def _lookup_metadata(self, disc_id: str) -> None:
        if not self.cfg.get("musicbrainz", True):
            return
        cache = self.meta_dir / f"{disc_id}.json"
        meta = None
        if cache.exists():
            with contextlib.suppress(Exception):
                meta = json.loads(cache.read_text("utf-8"))
        if meta is None:
            try:
                resp = await self.ctx.http.get(
                    f"https://musicbrainz.org/ws/2/discid/{disc_id}",
                    params={"inc": "recordings artist-credits", "fmt": "json", "cdstubs": "no"},
                    headers={"User-Agent": USER_AGENT},
                    timeout=20,
                )
                if resp.status_code == 404:
                    log.info("Disc %s is not in MusicBrainz", disc_id)
                    return
                resp.raise_for_status()
                meta = parse_musicbrainz(resp.json(), disc_id)
            except Exception as exc:
                log.warning("MusicBrainz lookup failed: %s", exc)
                return
            if meta is None:
                return
            self.meta_dir.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(meta, ensure_ascii=False), "utf-8")
        if not self.disc or self.disc["disc_id"] != disc_id:
            return  # disc changed meanwhile
        self.disc.update({k: meta.get(k, "") for k in ("album", "artist", "year", "art_url")})
        for t in self.disc["tracks"]:
            info = meta.get("tracks", {}).get(str(t["number"])) or meta.get("tracks", {}).get(t["number"])
            if info:
                t["title"], t["artist"] = info["title"], info["artist"]
        if self.current is not None:
            self._show(self.current)
        self.ctx.manager.notify(True)

    # ------------------------------------------------------------ reading the disc
    def _track_path(self, number: int) -> Path:
        return self.cache_dir / f"track{number:02d}.wav"

    def _next_to_rip(self) -> int | None:
        if not self.disc:
            return None
        numbers = [t["number"] for t in self.disc["tracks"]]
        start = self.base if self.base in numbers else numbers[0]
        i = numbers.index(start)
        for n in numbers[i:] + numbers[:i]:  # play order first, then wrap around
            if n not in self.ripped:
                return n
        return None

    async def _rip_loop(self) -> None:
        speed = str(self.cfg.get("read_speed", 4))
        while True:
            number = self._next_to_rip()
            if number is None:
                self.rip_progress = {"done": True}
                self.ctx.manager.notify(True)
                log.info("Whole disc is in memory")
                return
            target = self._track_path(number)
            partial = target.with_suffix(".part.wav")
            self.rip_progress = {"track": number, "done": False}
            self.ctx.manager.notify(True)
            self._rip_proc = await asyncio.create_subprocess_exec(
                self.paranoia, "-q", "-d", self.device, "-S", speed, "-w", str(number), str(partial),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
            )
            _, err = await self._rip_proc.communicate()
            code = self._rip_proc.returncode
            self._rip_proc = None
            if code != 0 or not partial.exists():
                log.error("Reading track %s failed: %s", number, err.decode(errors="replace")[-300:])
                self.ripped.add(number)  # skip it rather than loop forever
                self._track_ready[number].set()  # wake anyone waiting; they will see no file
                self.update(extra={**self.np.extra, "error": f"Track {number} could not be read"})
                continue
            partial.rename(target)
            self.ripped.add(number)
            self._track_ready[number].set()
            await self._append_ready_tracks()

    async def _stop_ripping(self) -> None:
        if self._rip_proc and self._rip_proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                self._rip_proc.kill()
        if self._rip_task:
            self._rip_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._rip_task
        self._rip_task = None
        self._rip_proc = None

    async def _reprioritise(self, number: int) -> None:
        """After a jump to an unread track: read that one next."""
        if self.rip_progress.get("track") == number and self._rip_proc is not None:
            return  # already reading it
        await self._stop_ripping()
        self._rip_task = asyncio.create_task(self._rip_loop(), name="cd-rip")

    # ------------------------------------------------------------ playback
    def _numbers(self) -> list[int]:
        return [t["number"] for t in self.disc["tracks"]] if self.disc else []

    def _track(self, number: int) -> dict[str, Any]:
        for t in self.disc["tracks"] if self.disc else []:
            if t["number"] == number:
                return t
        raise SourceError(f"No track {number} on this disc", 404)

    def _show(self, number: int, state: PlayState | None = None) -> None:
        if not self.disc:
            return
        t = self._track(number)
        self.current = number
        extra = {"disc_id": self.disc["disc_id"]}
        if t.get("preemphasis"):
            extra["preemphasis"] = True
        self.reset_now_playing(
            state=state or self.np.state,
            title=t["title"],
            artist=t["artist"] or self.disc["artist"],
            album=self.disc["album"],
            art_url=self.disc["art_url"],
            duration=t["duration"],
            position=0.0,
            track_number=number,
            track_count=len(self.disc["tracks"]),
            extra=extra,
        )

    async def play_track(self, number: int) -> None:
        if not self.disc:
            raise SourceError("No audio CD in the drive", 409)
        self._track(number)
        await self.claim()
        self.base = number
        self._show(number, PlayState.LOADING)
        if number not in self.ripped:
            await self._reprioritise(number)
            await self._track_ready[number].wait()
            if self.base != number or not self.owns_engine or not self.disc:
                return  # user moved on (or the disc came out) while we waited
        if not self._track_path(number).exists():
            self.update(state=PlayState.STOPPED)
            raise SourceError(f"Track {number} could not be read from the disc", 500)
        await self.engine.command("set_property", "pause", False)
        await self.engine.command("loadfile", str(self._track_path(number)), "replace")
        self.appended_upto = number
        await self._append_ready_tracks()

    async def _append_ready_tracks(self) -> None:
        """Keep mpv's playlist filled with the following tracks, for gapless playback."""
        if self.appended_upto is None or not self.owns_engine:
            return
        numbers = self._numbers()
        while True:
            i = numbers.index(self.appended_upto)
            if i + 1 >= len(numbers):
                return
            nxt = numbers[i + 1]
            if nxt not in self.ripped or not self._track_path(nxt).exists():
                return
            await self.engine.command("loadfile", str(self._track_path(nxt)), "append")
            self.appended_upto = nxt

    def capabilities(self) -> Capabilities:
        has = self.disc is not None
        return Capabilities(play=has, pause=has, stop=has, seek=has, next=has, previous=has)

    def details(self) -> dict[str, Any]:
        disc = None
        if self.disc:
            disc = dict(self.disc)
            disc["tracks"] = [dict(t, in_memory=t["number"] in self.ripped) for t in self.disc["tracks"]]
        return {"status": self.status, "disc": disc, "reading": self.rip_progress, "device": self.device}

    async def play(self) -> None:
        if self.owns_engine and self.np.state == PlayState.PAUSED:
            await self.resume()
        elif self.disc:
            await self.play_track(self.current or self._numbers()[0])
        else:
            raise SourceError("No audio CD in the drive", 409)

    async def next(self) -> None:
        numbers = self._numbers()
        if not numbers or self.current is None:
            raise SourceError("Nothing is playing", 409)
        i = numbers.index(self.current)
        if i + 1 >= len(numbers):
            raise SourceError("This is the last track")
        nxt = numbers[i + 1]
        if self.owns_engine and self.appended_upto is not None and nxt <= self.appended_upto:
            await self.engine.command("playlist-next", "weak")
        else:
            await self.play_track(nxt)

    async def previous(self) -> None:
        numbers = self._numbers()
        if not numbers or self.current is None:
            raise SourceError("Nothing is playing", 409)
        i = numbers.index(self.current)
        if (self.np.position or 0) > 3 or i == 0:
            await self.seek(0)
        elif self.owns_engine and self.base is not None and numbers[i - 1] >= self.base:
            await self.engine.command("playlist-prev", "weak")
        else:
            await self.play_track(numbers[i - 1])

    # ------------------------------------------------------------ mpv callbacks
    async def on_playlist_pos(self, index: int) -> None:
        if self.base is None or not self.disc:
            return
        numbers = self._numbers()
        i = numbers.index(self.base) + index
        if i < len(numbers) and numbers[i] != self.current:
            self._show(numbers[i])
