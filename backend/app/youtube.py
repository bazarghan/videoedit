"""Import a single public YouTube video through yt-dlp.

The importer is deliberately restricted to YouTube hosts: yt-dlp is a
general-purpose downloader, and the rest of the app only allows validated
public HTTP(S) URLs. Playlists, channels, live streams and DRM/first-party
extractors stay out of reach.
"""

import asyncio
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

from . import media
from . import store as s
from .network import validate_url

YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
}
VIDEO_PATHS = ("/shorts/", "/embed/", "/live/", "/v/", "/clip/")
MAX_TITLE_LENGTH = 120


def is_youtube_url(url):
    try:
        host = urlsplit(url if "://" in url else "https://" + url).hostname or ""
    except ValueError:
        return False
    return host.lower().rstrip(".") in YOUTUBE_HOSTS


def validate_youtube_url(url):
    value = url.strip()
    if "://" not in value:
        value = "https://" + value
    validate_url(value)
    parts = urlsplit(value)
    host = (parts.hostname or "").lower().rstrip(".")
    if host not in YOUTUBE_HOSTS:
        raise ValueError("Enter a YouTube link from youtube.com or youtu.be.")
    path = parts.path.rstrip("/")
    lowered = path.lower()
    if host == "youtu.be":
        if len(path.strip("/")) < 6:
            raise ValueError("Enter a complete YouTube video link.")
    elif lowered == "/watch":
        if not parse_qs(parts.query).get("v", [""])[0].strip():
            raise ValueError("Enter a complete YouTube video link.")
    elif lowered.startswith(VIDEO_PATHS):
        if len(path.split("/", 2)[-1]) < 3:
            raise ValueError("Enter a complete YouTube video link.")
    else:
        raise ValueError(
            "Enter a single YouTube video link, not a channel, playlist or search page."
        )
    return value


def _friendly_error(message):
    text = message.lower()
    if "private" in text or "members-only" in text or "join this channel" in text:
        return "This YouTube video is private or members-only. Choose a public video."
    if (
        "sign in" in text
        or "sign-in" in text
        or "age-restricted" in text
        or "age restricted" in text
        or "confirm your age" in text
        or "not a bot" in text
        or "confirm you're not a bot" in text
    ):
        return (
            "YouTube requires a signed-in session for this video. Choose a public "
            "video that does not need age or bot verification."
        )
    if "live" in text or "premiere" in text or "does not pass filter" in text:
        return "Live and upcoming YouTube streams cannot be imported."
    if "not available in your country" in text or "geo" in text:
        return "This YouTube video is blocked in the server's country."
    if "larger than max-filesize" in text or "storage" in text:
        return "This YouTube download exceeds the available storage."
    if "format" in text and "not available" in text:
        return "YouTube did not provide a downloadable video format for this link."
    if any(word in text for word in ("unavailable", "removed", "copyright", "deleted")):
        return "This YouTube video is unavailable. Check that it is public and still exists."
    return "YouTube could not provide this video. Check that it is public and try again."


def _clean_title(value):
    value = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value or ""))
    value = re.sub(r"\s+", " ", value).strip()
    return value[:MAX_TITLE_LENGTH]


def _proxy_url(config):
    if not config or not config.get("host"):
        return None
    credentials = ""
    if config.get("username"):
        credentials = quote(config["username"], safe="") + ":"
        credentials += quote(config.get("password") or "", safe="") + "@"
    return f"socks5://{credentials}{config['host']}:{config['port']}"


def _js_runtime():
    if shutil.which("deno"):
        return "deno"
    node = shutil.which("node")
    if not node:
        return None
    try:
        result = subprocess.run(
            [node, "--version"], capture_output=True, text=True, timeout=5
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.match(r"v(\d+)", result.stdout.strip())
    # yt-dlp supports Node 22 and newer for YouTube's challenge scripts.
    return "node" if match and int(match.group(1)) >= 22 else None


def _download_sync(project_id, url, proxy, ident, stop):
    try:
        import yt_dlp
    except ImportError:
        raise ValueError(
            "YouTube downloads are unavailable because yt-dlp is not installed. "
            "Install the backend requirements and restart."
        ) from None

    folder = s.DATA / "sources"
    template = str(folder / (project_id + ".ytdlp")) + ".%(ext)s"
    destination = folder / (project_id + ".media")
    destination.unlink(missing_ok=True)
    for old in folder.glob(project_id + ".ytdlp.*"):
        old.unlink(missing_ok=True)

    last_space_check = 0.0
    last_progress = 0.0

    def progress(update):
        nonlocal last_space_check, last_progress
        if stop.is_set() or media.cancelled(ident):
            stop.set()
            raise media.Cancelled()
        now = time.monotonic()
        if update.get("status") == "downloading":
            done = int(update.get("downloaded_bytes") or 0)
            total = int(
                update.get("total_bytes") or update.get("total_bytes_estimate") or 0
            )
            if now - last_progress >= 0.25:
                s.update_job(
                    ident,
                    bytes=done,
                    speed=float(update.get("speed") or 0),
                    progress=min(90, 90 * done / total) if total else 0,
                )
                last_progress = now
            if now - last_space_check >= 2:
                s.space_for()
                last_space_check = now
        elif update.get("status") == "finished":
            s.update_job(ident, progress=92)

    def live_or_upcoming(info, *, incomplete=False):
        if info.get("is_live") or info.get("live_status") in (
            "is_live",
            "is_upcoming",
            "post_live",
        ):
            return "Live and upcoming YouTube streams cannot be imported."
        return None

    options = {
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "merge_output_format": "mp4",
        "outtmpl": template,
        "noplaylist": True,
        "playlist_items": "1",
        "match_filter": live_or_upcoming,
        "progress_hooks": [progress],
        "socket_timeout": 20,
        "retries": 3,
        "fragment_retries": 3,
        "concurrent_fragment_downloads": 1,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "no_color": True,
        "cachedir": False,
        "overwrites": True,
        "continuedl": False,
        "logger": _SilentLogger(),
    }
    if proxy:
        options["proxy"] = proxy

    runtime = _js_runtime()
    if runtime:
        options["js_runtimes"] = {runtime: {"path": None}}

    cookies = os.getenv("YTDLP_COOKIES_FILE", "").strip()
    if cookies:
        cookie_path = Path(cookies).expanduser()
        if not cookie_path.is_file():
            raise ValueError(
                "The YTDLP_COOKIES_FILE path does not point to a readable "
                "Netscape cookies.txt file."
            )
        options["cookiefile"] = str(cookie_path)

    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
        if info and info.get("_type") == "playlist":
            entries = [entry for entry in info.get("entries") or [] if entry]
            info = entries[0] if entries else {}
        usable = [
            path
            for path in folder.glob(project_id + ".ytdlp.*")
            if path.is_file()
            and path.suffix != ".part"
            and not re.search(r"\.f\d+\.", path.name)
        ]
        if not usable:
            raise ValueError("YouTube did not return a downloadable video file.")
        produced = max(usable, key=lambda path: path.stat().st_size)
        if not produced.stat().st_size:
            raise ValueError("YouTube returned an empty video file.")
        if stop.is_set() or media.cancelled(ident):
            raise media.Cancelled()
        produced.replace(destination)
        return (info or {}).get("title") or ""
    except media.Cancelled:
        raise
    except yt_dlp.utils.YoutubeDLError as exc:
        raise ValueError(_friendly_error(str(exc))) from None
    finally:
        for old in folder.glob(project_id + ".ytdlp.*"):
            old.unlink(missing_ok=True)


class _SilentLogger:
    def debug(self, message):
        pass

    def warning(self, message):
        pass

    def error(self, message):
        pass


async def download(project_id, payload, ident):
    url = validate_youtube_url(payload["url"])
    destination = s.DATA / "sources" / (project_id + ".media")
    stop = threading.Event()
    finished = threading.Event()

    def work():
        try:
            return _download_sync(
                project_id, url, _proxy_url(payload.get("proxy")), ident, stop
            )
        finally:
            finished.set()

    task = asyncio.create_task(asyncio.to_thread(work))

    def consume(result):
        if not result.cancelled():
            result.exception()

    task.add_done_callback(consume)
    try:
        title = await asyncio.shield(task)
    except asyncio.CancelledError:
        stop.set()
        deadline = time.monotonic() + 30
        while not finished.is_set() and time.monotonic() < deadline:
            await asyncio.sleep(0.1)
        destination.unlink(missing_ok=True)
        raise
    except BaseException:
        destination.unlink(missing_ok=True)
        raise

    # A custom project name always wins; otherwise use the video title.
    name = _clean_title(title)
    if name and not payload.get("name"):
        s.execute("UPDATE projects SET name=? WHERE id=?", (name, project_id))
    try:
        await media.ingest(project_id, destination, ident)
    except BaseException:
        project = s.one("SELECT source FROM projects WHERE id=?", (project_id,))
        if not project or not project["source"]:
            destination.unlink(missing_ok=True)
        raise
