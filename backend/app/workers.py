import asyncio
import time
from urllib.parse import urljoin

import aiohttp
from yarl import URL

from . import media
from . import store as s
from .network import connector, validate_url
from .telegram import error_message, telegram


async def download(project_id, payload, ident):
    path = s.DATA / "sources" / (project_id + ".media")
    temp = path.with_suffix(".part")
    url = validate_url(payload["url"])
    timeout = aiohttp.ClientTimeout(total=None, connect=30, sock_read=60)
    try:
        async with aiohttp.ClientSession(
            connector=connector(payload.get("proxy")), timeout=timeout, trust_env=False
        ) as session:
            for _ in range(6):
                validate_url(url)
                async with session.get(
                    URL(url, encoded=True),
                    allow_redirects=False,
                    headers={
                        "User-Agent": "VideoEdit/1.0",
                        "Accept-Encoding": "identity",
                    },
                ) as response:
                    if response.status in (301, 302, 303, 307, 308):
                        location = response.headers.get("Location")
                        if not location:
                            raise ValueError("The source returned an invalid redirect.")
                        url = urljoin(url, location)
                        continue
                    if response.status >= 400:
                        if response.status in (401, 403):
                            raise ValueError(
                                "The link has expired or requires authorization. Obtain a fresh direct video URL."
                            )
                        raise ValueError(
                            f"The source returned HTTP {response.status}. Check the link and retry."
                        )
                    if response.status != 200:
                        raise ValueError(
                            "The source did not return a complete video file."
                        )
                    total = response.content_length or 0
                    s.space_for(total)
                    size = 0
                    started = time.monotonic()
                    last = 0
                    with temp.open("wb") as f:
                        async for chunk in response.content.iter_chunked(256 * 1024):
                            if media.cancelled(ident):
                                raise media.Cancelled()
                            size += len(chunk)
                            f.write(chunk)
                            now = time.monotonic()
                            if now - last > 0.5:
                                s.space_for()
                                s.update_job(
                                    ident,
                                    bytes=size,
                                    speed=size / max(0.1, now - started),
                                    progress=min(99, 100 * size / total)
                                    if total
                                    else 0,
                                )
                                last = now
                    if total and size != total:
                        raise ValueError(
                            "The download was interrupted. Obtain a fresh link and retry."
                        )
                    if size == 0:
                        raise ValueError("The source returned an empty file.")
                    temp.replace(path)
                    await media.ingest(project_id, path, ident)
                    return
            raise ValueError("The link redirected too many times.")
    except BaseException:
        temp.unlink(missing_ok=True)
        project = s.one("SELECT source FROM projects WHERE id=?", (project_id,))
        if not project or not project["source"]:
            path.unlink(missing_ok=True)
        raise


ACTIVE_JOBS = set()


async def dispatch(job, payload):
    ident = job["id"]
    project = s.one("SELECT * FROM projects WHERE id=?", (job["project_id"],))
    if job["kind"] == "telegram":
        await telegram.send(payload, ident)
    elif not project:
        raise ValueError("The project no longer exists.")
    elif job["kind"] == "download":
        await download(project["id"], payload, ident)
    elif job["kind"] == "ingest":
        await media.ingest(project["id"], payload["path"], ident)
    elif job["kind"] == "proxy":
        await media.proxy(project, payload, ident)
    else:
        await media.render(project, payload, ident)


async def worker(kinds):
    placeholders = ",".join("?" for _ in kinds)
    while True:
        job = s.one(
            f"SELECT * FROM jobs WHERE status='queued' AND kind IN ({placeholders}) ORDER BY created LIMIT 1",
            kinds,
        )
        if not job:
            await asyncio.sleep(0.5)
            continue
        ident = job["id"]
        ACTIVE_JOBS.add(ident)
        s.update_job(
            ident, status="running", started=time.time(), error=None, progress=0
        )
        operation = None
        try:
            operation = asyncio.create_task(dispatch(job, s.decrypt(job["payload"])))
            while not operation.done():
                await asyncio.wait({operation}, timeout=0.2)
                if media.cancelled(ident):
                    operation.cancel()
                    await asyncio.gather(operation, return_exceptions=True)
                    raise media.Cancelled()
            await operation
            if not media.cancelled(ident):
                s.update_job(
                    ident, status="completed", progress=100, finished=time.time()
                )
        except media.Cancelled:
            s.update_job(
                ident,
                status="cancelled",
                finished=time.time(),
                error="Cancelled by you.",
            )
            if job["kind"] in ("download", "ingest", "proxy"):
                s.execute(
                    "UPDATE projects SET status=? WHERE id=?",
                    ("cancelled", job["project_id"]),
                )
        except asyncio.CancelledError:
            s.update_job(
                ident,
                status="interrupted",
                finished=time.time(),
                error="Interrupted by a restart. Review and retry; Telegram sends may already have completed.",
            )
            raise
        except Exception as exc:
            if job["kind"] == "telegram":
                message = error_message(exc)
            elif isinstance(exc, ValueError):
                message = str(exc)
            elif isinstance(exc, (aiohttp.ClientError, asyncio.TimeoutError)):
                message = "The source connection failed or timed out. Check the link and retry."
            else:
                message = "The job failed unexpectedly. Retry after checking available storage and the source file."
            s.update_job(
                ident, status="failed", error=message[:2000], finished=time.time()
            )
            if job["kind"] in ("download", "ingest", "proxy"):
                s.execute(
                    "UPDATE projects SET status=? WHERE id=?",
                    ("failed", job["project_id"]),
                )
        finally:
            if operation and not operation.done():
                operation.cancel()
                await asyncio.gather(operation, return_exceptions=True)
            ACTIVE_JOBS.discard(ident)
