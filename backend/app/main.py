import asyncio
import hashlib
import json
import mimetypes
import os
import secrets
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pwdlib import PasswordHash

from . import media
from . import store as s
from .models import (
    Cue,
    DownloadProxyConfig,
    Edit,
    ImportURL,
    Login,
    Rename,
    SendClip,
    StorageConfig,
    TelegramCode,
    TelegramConfig,
)
from .network import validate_url
from .telegram import error_message, telegram
from .workers import ACTIVE_JOBS, worker

password_hash = PasswordHash.recommended()
secure_cookie = os.getenv("COOKIE_SECURE", "true").lower() == "true"
admin_user = os.getenv("ADMIN_USERNAME", "admin")
attempts = {}


@asynccontextmanager
async def lifespan(app):
    if not s.setting("admin_hash"):
        password = os.getenv("ADMIN_PASSWORD", "")
        if len(password) < 12:
            raise RuntimeError(
                "Set ADMIN_PASSWORD to a unique password of at least 12 characters before first startup."
            )
        s.set_setting("admin_hash", password_hash.hash(password))
    s.execute(
        "UPDATE jobs SET status='interrupted',finished=?,error='Interrupted by a restart. Review and retry; a Telegram send may have already completed.' WHERE status='running'",
        (time.time(),),
    )
    s.execute("DELETE FROM sessions WHERE expires<?", (time.time(),))
    tasks = [
        asyncio.create_task(worker(("download", "ingest"))),
        asyncio.create_task(worker(("proxy", "render"))),
        asyncio.create_task(worker(("telegram",))),
    ]
    yield
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await telegram.disconnect(logout=False)


app = FastAPI(
    title="VideoEdit",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.exception_handler(RequestValidationError)
async def invalid_input(request, exc):
    # Validation responses must not echo signed URLs or proxy passwords.
    return JSONResponse({"detail": "Check your entries and try again."}, 422)


@app.middleware("http")
async def guard(request, call_next):
    path = request.url.path
    if path.startswith("/api/") and path not in ("/api/login", "/api/health"):
        token = request.cookies.get("videoedit_session", "")
        row = (
            s.one(
                "SELECT expires FROM sessions WHERE token=?",
                (hashlib.sha256(token.encode()).hexdigest(),),
            )
            if token
            else None
        )
        if not row or row["expires"] < time.time():
            return JSONResponse({"detail": "Please sign in to continue."}, 401)
    upload_route = request.method == "POST" and (
        path == "/api/import/upload"
        or "/assets/" in path
        or path.endswith("/subtitles")
    )
    if upload_route:
        try:
            length = int(request.headers.get("content-length", "0"))
        except ValueError:
            return JSONResponse({"detail": "The upload size is invalid."}, 400)
        if length <= 0:
            return JSONResponse(
                {
                    "detail": "Upload a file with a known size (Content-Length is required)."
                },
                411,
            )
        kind_limit = (
            25 * 1024**2
            if path.endswith("/watermark")
            else 1024**3
            if "/assets/" in path
            else 10 * 1024**2
            if path.endswith("/subtitles")
            else int(s.setting("storage_limit_gb", 20)) * 1024**3
        )
        if length > kind_limit + 1024**2:
            return JSONResponse(
                {"detail": "This upload exceeds the allowed file size."}, 413
            )
        available = min(
            int(s.setting("storage_limit_gb", 20)) * 1024**3 - s.used_bytes(),
            shutil.disk_usage(s.DATA).free - 1024**3,
        )
        # Multipart parsing spools to the data volume before the managed copy is complete.
        if length * 2 > available:
            return JSONResponse(
                {
                    "detail": "Not enough storage for this upload and its temporary copy. Free space and try again."
                },
                413,
            )
    if request.method not in ("GET", "HEAD", "OPTIONS") and path.startswith("/api/"):
        origin = request.headers.get("origin")
        allowed = os.getenv("PUBLIC_URL", "").rstrip("/")
        if origin and origin.rstrip("/") not in (
            str(request.base_url).rstrip("/"),
            allowed,
        ):
            return JSONResponse(
                {"detail": "This request came from an unrecognized website."}, 403
            )
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    )
    if path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(ValueError)
async def value_error(request, exc):
    return JSONResponse({"detail": str(exc)}, 400)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.post("/api/login")
async def login(body: Login, request: Request):
    host = request.client.host
    now = time.time()
    tries = [x for x in attempts.get(host, []) if now - x < 900]
    if len(tries) >= 10:
        raise HTTPException(429, "Too many login attempts. Try again in 15 minutes.")
    attempts[host] = tries + [now]
    valid = await asyncio.to_thread(
        password_hash.verify, body.password, s.setting("admin_hash")
    )
    if body.username != admin_user or not valid:
        raise HTTPException(401, "The username or password is incorrect.")
    attempts.pop(host, None)
    token = secrets.token_urlsafe(48)
    s.execute(
        "INSERT INTO sessions VALUES (?,?)",
        (hashlib.sha256(token.encode()).hexdigest(), now + 7 * 86400),
    )
    response = JSONResponse({"username": admin_user})
    response.set_cookie(
        "videoedit_session",
        token,
        max_age=7 * 86400,
        httponly=True,
        secure=secure_cookie,
        samesite="strict",
        path="/",
    )
    return response


@app.get("/api/me")
async def me():
    return {"username": admin_user}


@app.post("/api/logout")
async def logout(request: Request):
    s.execute(
        "DELETE FROM sessions WHERE token=?",
        (
            hashlib.sha256(
                request.cookies.get("videoedit_session", "").encode()
            ).hexdigest(),
        ),
    )
    response = JSONResponse({"ok": True})
    response.delete_cookie("videoedit_session")
    return response


def project(ident):
    row = s.one("SELECT * FROM projects WHERE id=?", (ident,))
    if not row:
        raise HTTPException(404, "Project not found.")
    return row


def public_project(row):
    return {k: row[k] for k in ("id", "name", "status", "created")} | {
        "metadata": json.loads(row["metadata"]),
        "edit": json.loads(row["edit"]),
        "has_source": bool(row["source"]),
        "has_preview": bool(row["preview"]),
        "has_thumbnail": bool(row["thumbnail"]),
    }


def new_project(name, status="queued"):
    ident = s.uid()
    s.execute(
        "INSERT INTO projects(id,name,status,created) VALUES (?,?,?,?)",
        (ident, name, status, time.time()),
    )
    return ident


@app.get("/api/projects")
async def projects():
    return [
        public_project(row)
        for row in s.rows("SELECT * FROM projects ORDER BY created DESC")
    ]


@app.get("/api/projects/{ident}")
async def get_project(ident: str):
    row = public_project(project(ident))
    row["subtitles"] = [
        {k: v for k, v in st.items() if k not in ("cues", "ass_path")}
        for st in s.rows("SELECT * FROM subtitles WHERE project_id=?", (ident,))
    ]
    row["assets"] = [
        {k: v for k, v in a.items() if k != "path"}
        for a in s.rows("SELECT * FROM assets WHERE project_id=?", (ident,))
    ]
    return row


@app.post("/api/import/url")
async def import_url(body: ImportURL):
    validate_url(body.url)
    payload = {"url": body.url}
    if body.use_proxy:
        config = s.setting("download_proxy", {})
        if not config.get("host"):
            raise ValueError(
                "Save a SOCKS5 proxy before enabling it for this download."
            )
        payload["proxy"] = config
    s.space_for()
    ident = new_project(body.name)
    job_id = s.job("download", ident, payload)
    return {"project_id": ident, "job_id": job_id}


def signature(path, kind):
    with path.open("rb") as f:
        header = f.read(32)
    video = header[:4] == b"\x1aE\xdf\xa3" or header[4:8] in (
        b"ftyp",
        b"moov",
        b"mdat",
        b"wide",
        b"free",
    )
    image = header.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff"))
    audio = (
        video
        or header.startswith((b"ID3", b"fLaC", b"OggS", b"RIFF"))
        or (len(header) > 1 and header[0] == 255 and header[1] & 0xE0 == 0xE0)
    )
    if not {"video": video, "watermark": image, "music": audio}[kind]:
        raise ValueError(
            "Unsupported file. Use MP4/MKV/WebM video, PNG/JPEG images, or MP3/M4A/WAV/FLAC/OGG audio."
        )


async def save_upload(file, path, limit):
    size = 0
    try:
        s.space_for()
        with path.open("wb") as f:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise ValueError("This upload exceeds the allowed file size.")
                s.space_for(len(chunk))
                f.write(chunk)
        if not size:
            raise ValueError("Choose a non-empty file.")
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()


@app.post("/api/import/upload")
async def import_upload(file: UploadFile = File(...)):
    ident = s.uid()
    path = s.DATA / "sources" / (ident + ".media")
    try:
        await save_upload(file, path, int(s.setting("storage_limit_gb", 20)) * 1024**3)
        signature(path, "video")
        name = Path(file.filename or "Uploaded video").stem[:120]
        s.execute(
            "INSERT INTO projects(id,name,source,status,created) VALUES (?,?,?,?,?)",
            (ident, name, str(path), "queued", time.time()),
        )
        job_id = s.job("ingest", ident, {"path": str(path)})
        return {"project_id": ident, "job_id": job_id}
    except BaseException:
        path.unlink(missing_ok=True)
        raise


@app.patch("/api/projects/{ident}")
async def rename_project(ident: str, body: Rename):
    project(ident)
    s.execute("UPDATE projects SET name=? WHERE id=?", (body.name, ident))
    return {"ok": True}


@app.put("/api/projects/{ident}/edit")
async def save_edit(ident: str, body: Edit):
    row = project(ident)
    validate_edit(row, body)
    s.execute("UPDATE projects SET edit=? WHERE id=?", (body.model_dump_json(), ident))
    return {"ok": True}


def validate_edit(row, body):
    duration = json.loads(row["metadata"]).get("duration", 0)
    if not row["source"]:
        raise ValueError(
            "The original source was removed. Import the video again to render."
        )
    if body.end <= body.start or body.end > duration + 0.05:
        raise ValueError("Set the end after the start, within the source duration.")
    if body.watermark.end is not None and body.watermark.end <= body.watermark.start:
        raise ValueError(
            "The watermark end must follow its start (relative to the clip)."
        )


@app.post("/api/projects/{ident}/render")
async def render_project(ident: str, body: Edit, preview: bool = False):
    row = project(ident)
    validate_edit(row, body)
    s.space_for()
    s.execute("UPDATE projects SET edit=? WHERE id=?", (body.model_dump_json(), ident))
    return {
        "job_id": s.job(
            "render",
            ident,
            {
                "edit": body.model_dump(),
                "preview": preview,
                "subtitle_snapshot": s.one(
                    "SELECT * FROM subtitles WHERE id=? AND project_id=?",
                    (body.subtitles.track_id, ident),
                ),
            },
        )
    }


@app.post("/api/projects/{ident}/preview")
async def create_proxy(ident: str, audio_track: int = 0):
    row = project(ident)
    if not row["source"]:
        raise ValueError("The source is no longer available.")
    if audio_track < 0 or audio_track >= max(
        1, len(json.loads(row["metadata"]).get("audio", []))
    ):
        raise ValueError("Choose a valid audio track.")
    active = s.one(
        "SELECT id FROM jobs WHERE project_id=? AND kind='proxy' AND status IN ('queued','running')",
        (ident,),
    )
    return {
        "job_id": active["id"]
        if active
        else s.job("proxy", ident, {"audio_track": audio_track})
    }


@app.get("/api/projects/{ident}/subtitles/{track_id}")
async def get_subtitles(ident: str, track_id: str):
    row = s.one(
        "SELECT * FROM subtitles WHERE id=? AND project_id=?", (track_id, ident)
    )
    if not row:
        raise HTTPException(404, "Subtitle track not found.")
    return {
        "cues": json.loads(row["cues"]),
        "editable": bool(row["editable"]),
        "preserve_ass": bool(row["ass_path"]),
    }


@app.put("/api/projects/{ident}/subtitles/{track_id}")
async def edit_subtitles(ident: str, track_id: str, body: list[Cue]):
    row = s.one(
        "SELECT * FROM subtitles WHERE id=? AND project_id=?", (track_id, ident)
    )
    if not row or not row["editable"]:
        raise ValueError("Choose an editable text subtitle track.")
    if len(body) > 30000 or any(c.end <= c.start for c in body):
        raise ValueError("Each cue must end after its start (maximum 30,000 cues).")
    s.execute(
        "UPDATE subtitles SET cues=? WHERE id=?",
        (json.dumps([c.model_dump() for c in body]), track_id),
    )
    return {"ok": True}


@app.post("/api/projects/{ident}/subtitles")
async def upload_subtitles(ident: str, file: UploadFile = File(...)):
    project(ident)
    extension = Path(file.filename or "").suffix.lower()
    if extension not in (".srt", ".ass", ".ssa", ".vtt"):
        raise ValueError("Choose an SRT, ASS, SSA or VTT file.")
    path = s.DATA / "work" / (s.uid() + extension)
    try:
        await save_upload(file, path, 10 * 1024**2)
        track_id = await media.add_subtitle(
            ident,
            path,
            Path(file.filename).name,
            codec=extension[1:] if extension in (".ass", ".ssa") else "subrip",
        )
        return {"track_id": track_id}
    finally:
        path.unlink(missing_ok=True)


@app.post("/api/projects/{ident}/assets/{kind}")
async def upload_asset(ident: str, kind: str, file: UploadFile = File(...)):
    project(ident)
    if kind not in ("watermark", "music"):
        raise HTTPException(404, "Asset type not found.")
    asset_id = s.uid()
    extension = Path(file.filename or "").suffix.lower()
    allowed = (
        {".png", ".jpg", ".jpeg"}
        if kind == "watermark"
        else {".mp3", ".m4a", ".wav", ".ogg", ".flac", ".aac", ".mp4"}
    )
    if extension not in allowed:
        raise ValueError("Choose a supported image or music file.")
    path = s.DATA / "assets" / (asset_id + extension)
    try:
        await save_upload(file, path, (25 if kind == "watermark" else 1024) * 1024**2)
        signature(path, kind)
        meta = await media.probe(path)
        if kind == "watermark" and (
            not meta["width"] or max(meta["width"], meta["height"]) > 8192
        ):
            raise ValueError("Choose an image up to 8192 pixels wide or tall.")
        if kind == "music" and not meta["audio"]:
            raise ValueError("This file has no readable audio stream.")
        s.execute(
            "INSERT INTO assets VALUES (?,?,?,?,?)",
            (asset_id, ident, kind, str(path), Path(file.filename).name[:150]),
        )
        return {"asset_id": asset_id}
    except BaseException:
        path.unlink(missing_ok=True)
        raise


@app.get("/api/jobs")
async def jobs():
    now = time.time()
    result = []
    for row in s.rows("SELECT * FROM jobs ORDER BY created DESC LIMIT 200"):
        row.pop("payload")
        elapsed = max(0, (row["finished"] or now) - (row["started"] or now))
        row["elapsed"] = elapsed
        row["eta"] = (
            elapsed * (100 - row["progress"]) / row["progress"]
            if row["status"] == "running" and row["progress"] > 1
            else None
        )
        result.append(row)
    return result


@app.post("/api/jobs/{ident}/cancel")
async def cancel_job(ident: str):
    row = s.one("SELECT * FROM jobs WHERE id=?", (ident,))
    if not row:
        raise HTTPException(404, "Job not found.")
    if row["status"] in ("queued", "running"):
        s.update_job(
            ident, status="cancelled", finished=time.time(), error="Cancelled by you."
        )
        if row["kind"] in ("download", "ingest", "proxy"):
            s.execute(
                "UPDATE projects SET status='cancelled' WHERE id=?",
                (row["project_id"],),
            )
    return {"ok": True}


@app.post("/api/jobs/{ident}/retry")
async def retry_job(ident: str):
    row = s.one("SELECT * FROM jobs WHERE id=?", (ident,))
    if ident in ACTIVE_JOBS:
        raise HTTPException(
            409, "The cancelled job is still stopping. Wait a moment before retrying."
        )
    if not row or row["status"] not in ("failed", "cancelled", "interrupted"):
        raise ValueError("Only failed, cancelled or interrupted jobs can be retried.")
    if row["kind"] in ("download", "ingest"):
        p = project(row["project_id"])
        # Remove partial subtitle extraction before retrying ingestion.
        s.execute("DELETE FROM subtitles WHERE project_id=?", (p["id"],))
        s.execute("UPDATE projects SET status='queued' WHERE id=?", (p["id"],))
    return {"job_id": s.job(row["kind"], row["project_id"], s.decrypt(row["payload"]))}


def public_clip(row):
    row.pop("path")
    row["metadata"] = json.loads(row["metadata"])
    return row


@app.get("/api/clips")
async def clips():
    return [
        public_clip(row) for row in s.rows("SELECT * FROM clips ORDER BY created DESC")
    ]


@app.get("/api/media/project/{ident}/{kind}")
async def project_media(ident: str, kind: str):
    row = project(ident)
    if kind not in ("source", "preview", "thumbnail") or not row.get(kind):
        raise HTTPException(404, "This media is not available yet.")
    path = Path(row[kind])
    if not path.exists():
        raise HTTPException(404, "This media file is no longer available.")
    return FileResponse(
        path,
        media_type="image/jpeg"
        if kind == "thumbnail"
        else "video/mp4"
        if kind == "preview"
        else "application/octet-stream",
    )


@app.get("/api/media/asset/{ident}")
async def asset_media(ident: str):
    row = s.one("SELECT * FROM assets WHERE id=?", (ident,))
    if not row:
        raise HTTPException(404, "Asset not found.")
    return FileResponse(row["path"], media_type=mimetypes.guess_type(row["path"])[0])


@app.get("/api/media/clip/{ident}")
async def clip_media(ident: str, download: bool = False):
    row = s.one("SELECT * FROM clips WHERE id=?", (ident,))
    if not row:
        raise HTTPException(404, "Clip not found.")
    return FileResponse(
        row["path"], media_type="video/mp4", filename=row["name"] if download else None
    )


@app.post("/api/clips/{ident}/send")
async def send_clip(ident: str, body: SendClip):
    row = s.one("SELECT * FROM clips WHERE id=?", (ident,))
    if not row:
        raise HTTPException(404, "Clip not found.")
    status = await telegram.status()
    if not status["connected"]:
        raise ValueError("Connect your Telegram account in Settings first.")
    return {
        "job_id": s.job(
            "telegram", row["project_id"], {"clip_id": ident, **body.model_dump()}
        )
    }


def require_idle(project_id=None):
    active = s.one(
        "SELECT id FROM jobs WHERE status IN ('queued','running')"
        + (" AND project_id=?" if project_id else ""),
        (project_id,) if project_id else (),
    )
    # Cancelled processes may still be winding down; wait a few seconds before deletion.
    recent = s.one(
        "SELECT id FROM jobs WHERE status='cancelled' AND finished>?"
        + (" AND project_id=?" if project_id else ""),
        (time.time() - 5, project_id) if project_id else (time.time() - 5,),
    )
    winding_down = any(
        s.one(
            "SELECT id FROM jobs WHERE id=?"
            + (" AND project_id=?" if project_id else ""),
            (job_id, project_id) if project_id else (job_id,),
        )
        for job_id in ACTIVE_JOBS
    )
    if active or recent or winding_down:
        raise HTTPException(
            409, "Wait for active jobs to finish or cancel them before deleting files."
        )


@app.delete("/api/clips/{ident}")
async def delete_clip(ident: str):
    row = s.one("SELECT * FROM clips WHERE id=?", (ident,))
    if not row:
        raise HTTPException(404, "Clip not found.")
    require_idle(row["project_id"])
    Path(row["path"]).unlink(missing_ok=True)
    s.execute("DELETE FROM clips WHERE id=?", (ident,))
    return {"ok": True}


@app.delete("/api/projects/{ident}")
async def delete_project(ident: str):
    row = project(ident)
    require_idle(ident)
    paths = [row[k] for k in ("source", "preview", "thumbnail") if row[k]]
    paths += [
        r["path"]
        for r in s.rows("SELECT path FROM assets WHERE project_id=?", (ident,))
    ]
    paths += [
        r["path"] for r in s.rows("SELECT path FROM clips WHERE project_id=?", (ident,))
    ]
    paths += [
        r["ass_path"]
        for r in s.rows("SELECT ass_path FROM subtitles WHERE project_id=?", (ident,))
        if r["ass_path"]
    ]
    paths += [str(p) for p in (s.DATA / "previews").glob(ident + "-*")]
    for path in paths:
        Path(path).unlink(missing_ok=True)
    for table in ("assets", "clips", "subtitles", "jobs"):
        s.execute(f"DELETE FROM {table} WHERE project_id=?", (ident,))
    s.execute("DELETE FROM projects WHERE id=?", (ident,))
    return {"ok": True}


@app.get("/api/settings")
async def get_settings():
    config = s.setting("telegram", {})
    return {
        "telegram": {
            "api_id": config.get("api_id", ""),
            "api_hash_saved": bool(config.get("api_hash")),
            "phone": config.get("phone", ""),
            "destination": config.get("destination", "me"),
        },
        "telegram_status": await telegram.status(),
        "storage": storage_info(),
    }


@app.get("/api/settings/download-proxy")
async def get_download_proxy():
    config = s.setting("download_proxy", {})
    return {
        "host": config.get("host", ""),
        "port": config.get("port", 1080),
        "username": config.get("username", ""),
        "password_saved": bool(config.get("password")),
    }


@app.put("/api/settings/download-proxy")
async def save_download_proxy(body: DownloadProxyConfig):
    previous = s.setting("download_proxy", {})
    config = body.model_dump(exclude={"clear_password"})
    if (
        not body.password
        and not body.clear_password
        and all(
            config[key] == previous.get(key) for key in ("host", "port", "username")
        )
    ):
        config["password"] = previous.get("password", "")
    if config["password"] and not config["username"]:
        raise ValueError("Enter a username when using a SOCKS5 password.")
    s.set_setting("download_proxy", config)
    return await get_download_proxy()


@app.delete("/api/settings/download-proxy")
async def remove_download_proxy():
    s.set_setting("download_proxy", {})
    return await get_download_proxy()


@app.put("/api/settings/storage")
async def set_storage(body: StorageConfig):
    s.set_setting("storage_limit_gb", body.limit_gb)
    return storage_info()


def storage_info():
    usage = {
        name: s.directory_bytes(s.DATA / name)
        for name in ("sources", "previews", "subtitles", "assets", "renders", "work")
    }
    return {
        "used": s.used_bytes(),
        "free": shutil.disk_usage(s.DATA).free,
        "limit_gb": s.setting("storage_limit_gb", 20),
        "categories": usage,
    }


@app.post("/api/settings/cleanup/{kind}")
async def cleanup(kind: str):
    require_idle()
    if kind not in ("previews", "sources", "renders"):
        raise ValueError("Choose sources, previews or renders.")
    for path in (s.DATA / kind).iterdir():
        if path.is_file():
            path.unlink()
    if kind == "sources":
        s.execute("UPDATE projects SET source=NULL,status='source removed'")
    elif kind == "previews":
        s.execute("UPDATE projects SET preview=NULL,thumbnail=NULL")
    else:
        s.execute("DELETE FROM clips")
    return storage_info()


@app.put("/api/settings/telegram")
async def save_telegram(body: TelegramConfig):
    existing = s.setting("telegram", {})
    config = body.model_dump()
    if not config["api_hash"]:
        config["api_hash"] = existing.get("api_hash", "")
    import re

    if not re.fullmatch(r"[0-9a-fA-F]{32}", config["api_hash"]) or not re.fullmatch(
        r"\+[0-9 ]{7,20}", config["phone"]
    ):
        raise ValueError(
            "Enter the 32-character API hash and a phone number with country code (+)."
        )
    changed = any(
        config.get(k) != existing.get(k) for k in ("api_id", "api_hash", "phone")
    )
    if changed:
        if s.one(
            "SELECT id FROM jobs WHERE kind='telegram' AND status IN ('running','queued')"
        ):
            raise HTTPException(
                409, "Wait for Telegram uploads to finish before changing the account."
            )
        await telegram.disconnect(logout=True)
    s.set_setting("telegram", config)
    return {"ok": True}


async def telegram_call(fn):
    try:
        return await fn()
    except Exception as exc:
        raise HTTPException(400, error_message(exc))


@app.post("/api/telegram/connect")
async def telegram_connect():
    return await telegram_call(telegram.connect)


@app.post("/api/telegram/verify")
async def telegram_verify(body: TelegramCode):
    return await telegram_call(lambda: telegram.verify(body.code, body.password))


@app.get("/api/telegram/destinations")
async def telegram_destinations():
    return await telegram_call(telegram.dialogs)


@app.post("/api/telegram/disconnect")
async def telegram_disconnect():
    if s.one(
        "SELECT id FROM jobs WHERE kind='telegram' AND status IN ('queued','running')"
    ):
        raise HTTPException(
            409, "Finish or cancel Telegram uploads before disconnecting."
        )
    await telegram_call(telegram.disconnect)
    return {"connected": False, "step": "connect"}


@app.get("/api/fonts/{font}")
async def font_file(font: str):
    allowed = {
        "sans": "DejaVu Sans",
        "serif": "DejaVu Serif",
        "liberation-sans": "Liberation Sans",
        "liberation-serif": "Liberation Serif",
        "arabic": "Noto Sans Arabic",
    }
    if font not in allowed:
        raise HTTPException(404, "Font not found.")
    proc = await asyncio.create_subprocess_exec(
        "fc-match", "-f", "%{file}", allowed[font], stdout=asyncio.subprocess.PIPE
    )
    path = (await proc.communicate())[0].decode()
    return FileResponse(path, media_type="font/ttf")


static = Path(os.getenv("STATIC_DIR", "/app/static"))
if static.exists():
    app.mount("/assets", StaticFiles(directory=static / "assets"), name="static-assets")

    @app.get("/{path:path}")
    async def frontend(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "Endpoint not found.")
        return FileResponse(static / "index.html")
