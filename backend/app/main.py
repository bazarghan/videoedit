import asyncio
import base64
import hashlib
import json
import mimetypes
import os
import re
import secrets
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import get_args

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pwdlib import PasswordHash

from . import caption as captions
from . import media
from . import store as s
from . import youtube
from .autosubtitle import max_duration_minutes
from .font_catalog import FONT_SLUGS, FontFamily, font_path
from .models import (
    DEFAULT_CAPTION_PROMPT,
    AIConfig,
    AutoSubtitleRequest,
    CoverFrameCandidates,
    CoverFrameSelection,
    CoverSelection,
    Cue,
    DownloadProxyConfig,
    Edit,
    ElevenLabsConfig,
    ImportURL,
    LocalImport,
    Login,
    ProjectDefaults,
    ProjectDefaultsPatch,
    Rename,
    SendClip,
    StorageConfig,
    TelegramChannel,
    TelegramConfig,
)
from .network import validate_url
from .project_defaults import (
    get_defaults,
    initial_edit,
    remove_default_asset,
    save_defaults,
)
from .telegram import CHAT_TARGET, error_message, telegram
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
    queued_covers = {
        s.decrypt(row["payload"])["clip_id"]
        for row in s.rows(
            "SELECT payload FROM jobs WHERE kind='cover' AND status IN ('running','queued')"
        )
    }
    for clip in s.rows("SELECT * FROM clips"):
        paths = media.cover_paths(clip)
        if (
            Path(clip["path"]).exists()
            and (not paths or not all(path.exists() for path in paths))
            and clip["id"] not in queued_covers
        ):
            cover = json.loads(clip["metadata"]).get("cover", {})
            s.job(
                "cover",
                clip["project_id"],
                {
                    "clip_id": clip["id"],
                    "time": cover.get("time")
                    if cover.get("mode") == "manual"
                    else None,
                },
            )
    tasks = [
        # Keep the bot online so /chatid replies work between sends.
        asyncio.create_task(telegram.start()),
        asyncio.create_task(worker(("download", "youtube", "ingest"))),
        asyncio.create_task(worker(("render", "cover"))),
        asyncio.create_task(worker(("autosubtitle",))),
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
        or path == "/api/import/local"
        or "/assets/" in path
        or path.endswith("/subtitles")
        or path.endswith("/clips")
        or path.endswith("/autosubtitle-local")
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
            else 256 * 1024**2
            if path.endswith("/autosubtitle-local")
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
    # Keep the document cross-origin isolated. The current single-threaded
    # ffmpeg core does not require it, but it lets a future threaded build use
    # SharedArrayBuffer without another deployment change.
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' blob: 'wasm-unsafe-eval'; connect-src 'self'; font-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
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
    metadata = json.loads(row["metadata"])
    # Validate so projects saved before newer subtitle fields existed still
    # receive the complete, current edit shape.
    edit = Edit.model_validate(json.loads(row["edit"])).model_dump()
    return {k: row[k] for k in ("id", "name", "status", "created")} | {
        "metadata": metadata,
        "edit": edit,
        "has_source": bool(row["source"]),
        "has_thumbnail": bool(row["thumbnail"]),
    }


def new_project(name, status="queued", source=None, ident=None):
    ident = ident or s.uid()
    edit = initial_edit(ident)
    s.execute(
        "INSERT INTO projects(id,name,status,source,edit,created) VALUES (?,?,?,?,?,?)",
        (
            ident,
            name,
            status,
            source,
            edit.model_dump_json(),
            time.time(),
        ),
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
    db_row = project(ident)
    row = public_project(db_row)
    edit = Edit.model_validate(row["edit"])
    row["rendered"] = rendered_clip(
        ident, render_fingerprint(db_row, edit, False), preview=False
    )
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
    if youtube.is_youtube_url(body.url):
        url = youtube.validate_youtube_url(body.url)
        kind = "youtube"
    else:
        url = body.url
        validate_url(url)
        kind = "download"
    name = body.name.strip()
    payload = {"url": url}
    if name and "name" in body.model_fields_set:
        payload["name"] = name
    if body.use_proxy:
        config = s.setting("download_proxy", {})
        if not config.get("host"):
            raise ValueError(
                "Save a SOCKS5 proxy before enabling it for this download."
            )
        payload["proxy"] = config
    s.space_for()
    ident = new_project(name or "Imported video")
    job_id = s.job(kind, ident, payload)
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
        new_project(name, source=str(path), ident=ident)
        job_id = s.job("ingest", ident, {"path": str(path)})
        return {"project_id": ident, "job_id": job_id}
    except BaseException:
        path.unlink(missing_ok=True)
        raise


BROWSER_UNSUPPORTED_CODECS = {"av1", "vvc", "h266"}


@app.post("/api/import/local")
async def import_local(body: LocalImport):
    """Create a project whose source stays in the browser.

    Only the metadata and a small thumbnail cross the wire here; the rendered
    MP4 is uploaded later through ``/api/projects/{ident}/clips``.
    """
    meta = body.metadata.model_dump()
    if not meta["video_codec"]:
        raise ValueError("Choose a video with a readable video stream.")
    if meta["video_codec"].lower() in BROWSER_UNSUPPORTED_CODECS:
        raise ValueError(
            f"{meta['video_codec'].upper()} cannot be decoded by the browser "
            "renderer. Upload the file through the normal import flow so the "
            "server can render it, or convert it to H.264."
        )
    meta["local"] = True
    if not meta["video_duration"]:
        meta["video_duration"] = meta["duration"]
    name = body.name.strip()[:120] or "Browser video"
    ident = s.uid()
    thumbnail = None
    try:
        if body.thumbnail:
            thumbnail = save_local_thumbnail(body.thumbnail, ident)
        new_project(name, status="ready", source=None, ident=ident)
        s.execute(
            "UPDATE projects SET metadata=?, thumbnail=? WHERE id=?",
            (json.dumps(meta), str(thumbnail) if thumbnail else None, ident),
        )
        row = s.one("SELECT edit FROM projects WHERE id=?", (ident,))
        edit = Edit.model_validate(json.loads(row["edit"])).model_dump()
        edit["end"] = meta["duration"]
        s.execute(
            "UPDATE projects SET edit=? WHERE id=?", (json.dumps(edit), ident)
        )
        return {"project_id": ident, "local": True}
    except BaseException:
        if thumbnail:
            Path(thumbnail).unlink(missing_ok=True)
        s.execute("DELETE FROM projects WHERE id=?", (ident,))
        raise


def decode_jpeg_data_url(data: str, max_bytes: int = 2 * 1024**2):
    match = re.fullmatch(
        r"data:image/jpeg;base64,([A-Za-z0-9+/=\s]+)", data.strip(), re.DOTALL
    )
    if not match:
        raise ValueError("The image must be a JPEG data URL.")
    try:
        raw = base64.b64decode(re.sub(r"\s+", "", match.group(1)), validate=True)
    except ValueError:
        raise ValueError("The image could not be decoded.") from None
    if not raw or len(raw) > max_bytes:
        raise ValueError("The image is too large.")
    return raw


def save_local_thumbnail(data: str, ident: str):
    raw = decode_jpeg_data_url(data)
    s.space_for(len(raw))
    path = s.DATA / "previews" / (ident + ".jpg")
    path.write_bytes(raw)
    return path


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
    rendered = rendered_clip(
        ident, render_fingerprint(row, body, False), preview=False
    )
    return {"ok": True, "rendered": rendered}


def validate_edit(row, body):
    duration = json.loads(row["metadata"]).get("duration", 0)
    if not row["source"] and not json.loads(row["metadata"]).get("local"):
        raise ValueError(
            "The original source was removed. Import the video again to render."
        )
    if body.end <= body.start or body.end > duration + 0.05:
        raise ValueError("Set the end after the start, within the source duration.")
    if body.watermark.end is not None and body.watermark.end <= body.watermark.start:
        raise ValueError(
            "The watermark end must follow its start (relative to the clip)."
        )


def render_fingerprint(row, body: Edit, preview: bool):
    """Identify a render from everything that changes its output."""
    tracks = []
    for track_id in (body.subtitles.track_id, body.subtitles.fa_track_id):
        tracks.append(
            s.one(
                "SELECT cues, ass_path FROM subtitles WHERE id=? AND project_id=?",
                (track_id, row["id"]),
            )
            if track_id
            else None
        )
    source_state = None
    if row["source"]:
        try:
            stat = Path(row["source"]).stat()
            source_state = [stat.st_size, stat.st_mtime_ns]
        except OSError:
            source_state = None
    material = {
        "edit": body.model_dump(mode="json"),
        "preview": preview,
        "tracks": tracks,
        "source": source_state,
        "metadata": json.loads(row["metadata"]),
    }
    return hashlib.sha256(
        json.dumps(material, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def rendered_clip(ident, fingerprint, preview):
    for clip in s.rows(
        "SELECT preview, metadata FROM clips WHERE project_id=?", (ident,)
    ):
        if bool(clip["preview"]) != preview:
            continue
        try:
            if json.loads(clip["metadata"]).get("render_signature") == fingerprint:
                return True
        except (TypeError, ValueError):
            continue
    return False


def existing_render(ident, fingerprint, preview):
    """Return 'active' or 'done' when this exact render already exists."""
    for job in s.rows(
        "SELECT payload FROM jobs WHERE project_id=? AND kind='render' "
        "AND status IN ('queued','running')",
        (ident,),
    ):
        try:
            payload = s.decrypt(job["payload"])
        except Exception:
            continue
        if payload.get("signature") == fingerprint:
            return "active"
    return "done" if rendered_clip(ident, fingerprint, preview) else None


@app.post("/api/projects/{ident}/render-plan")
async def browser_render_plan(
    ident: str, body: Edit, preview: bool = False, threads: int = 1
):
    """Describe the exact ffmpeg command for a browser-only project."""
    row = project(ident)
    if not json.loads(row["metadata"]).get("local"):
        raise HTTPException(400, "This project renders on the server.")
    validate_edit(row, body)
    fingerprint = render_fingerprint(row, body, preview)
    payload = {
        "edit": body.model_dump(),
        "preview": preview,
        "signature": fingerprint,
        "subtitle_snapshot": s.one(
            "SELECT * FROM subtitles WHERE id=? AND project_id=?",
            (body.subtitles.track_id, ident),
        )
        if body.subtitles.track_id
        else None,
        "subtitle_snapshot_fa": s.one(
            "SELECT * FROM subtitles WHERE id=? AND project_id=?",
            (body.subtitles.fa_track_id, ident),
        )
        if body.subtitles.fa_track_id
        else None,
    }
    plan = await media.browser_plan(row, payload, threads=threads)
    s.execute(
        "UPDATE projects SET edit=? WHERE id=?", (body.model_dump_json(), ident)
    )
    return plan


@app.post("/api/projects/{ident}/clips")
async def upload_browser_clip(
    ident: str,
    file: UploadFile = File(...),
    edit: str = Form(...),
    preview: bool = Form(False),
):
    """Store the MP4 rendered in the browser as a normal project clip."""
    row = project(ident)
    if not json.loads(row["metadata"]).get("local"):
        raise HTTPException(
            400, "Only browser-only projects upload rendered clips this way."
        )
    body = Edit.model_validate_json(edit)
    validate_edit(row, body)
    fingerprint = render_fingerprint(row, body, preview)
    clip_id = s.uid()
    dest = s.DATA / "renders" / (clip_id + ".mp4")
    remuxed = s.DATA / "renders" / (clip_id + "-remux.mp4")
    limit = int(s.setting("storage_limit_gb", 20)) * 1024**3
    try:
        await save_upload(file, dest, limit)
        # The wasm encoder cannot always finalise a fast-start MP4 without
        # holding a second copy in memory, so remux natively here.
        await media.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-v",
                "error",
                "-y",
                "-i",
                str(dest),
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                str(remuxed),
            ]
        )
        remuxed.replace(dest)
        info = await media.probe(dest)
        if not media.telegram_compatible(info):
            raise ValueError(
                "The browser export is not a Telegram-compatible MP4. Render it again."
            )
        expected_duration = (
            min(body.end - body.start, 6) if preview else body.end - body.start
        )
        expected_width, expected_height = media.dimensions(
            json.loads(row["metadata"]), body
        )
        if (
            abs(info["width"] - expected_width) > 2
            or abs(info["height"] - expected_height) > 2
        ):
            raise ValueError(
                "The browser export has a different frame size than the selected output."
            )
        if abs(info["duration"] - expected_duration) > 0.35:
            raise ValueError(
                "The browser export has a different duration than the selected cut."
            )
        if info.get("fps") and abs(info["fps"] - body.fps) > 0.6:
            raise ValueError(
                "The browser export has a different frame rate than the selected output."
            )
        info["telegram_compatible"] = True
        info["caption_context"] = {
            "start": body.start,
            "end": body.end,
            "track_id": body.subtitles.track_id,
            "fa_track_id": body.subtitles.fa_track_id,
        }
        info["render_signature"] = fingerprint
        cover = None
        try:
            cover = await media.install_project_cover(
                row, {"id": clip_id}, body, expected_duration
            )
        except Exception:
            cover = None
        info["cover"] = cover or await media.make_cover(
            {"id": clip_id, "path": str(dest)}, info
        )
        name = re.sub(r"[^\w\- .]", "", body.filename).strip(" .") or "clip"
        if preview:
            name += "-preview"
        s.execute(
            "INSERT INTO clips VALUES (?,?,?,?,?,?,?)",
            (
                clip_id,
                ident,
                name + ".mp4",
                str(dest),
                json.dumps(info),
                time.time(),
                int(preview),
            ),
        )
        # Do not overwrite the project edit here: the render takes a snapshot,
        # but the editor may have saved a newer edit while the browser encoded.
        return public_clip(s.one("SELECT * FROM clips WHERE id=?", (clip_id,)))
    except BaseException:
        dest.unlink(missing_ok=True)
        remuxed.unlink(missing_ok=True)
        for path in (s.DATA / "renders").glob(clip_id + "-*.jpg"):
            path.unlink(missing_ok=True)
        raise


@app.post("/api/projects/{ident}/render")
async def render_project(ident: str, body: Edit, preview: bool = False):
    row = project(ident)
    if json.loads(row["metadata"]).get("local"):
        raise HTTPException(
            400,
            "This project renders in your browser. Use the editor's render "
            "buttons; the source video was never uploaded.",
        )
    validate_edit(row, body)
    fingerprint = render_fingerprint(row, body, preview)
    previous = existing_render(ident, fingerprint, preview)
    if previous == "active":
        raise HTTPException(409, "This exact clip is already being rendered.")
    if previous == "done":
        raise HTTPException(
            409,
            "This exact clip is already rendered. Open it from Recent exports, "
            "or change the cut before rendering again.",
        )
    s.space_for()
    s.execute("UPDATE projects SET edit=? WHERE id=?", (body.model_dump_json(), ident))
    return {
        "job_id": s.job(
            "render",
            ident,
            {
                "edit": body.model_dump(),
                "preview": preview,
                "signature": fingerprint,
                "subtitle_snapshot": s.one(
                    "SELECT * FROM subtitles WHERE id=? AND project_id=?",
                    (body.subtitles.track_id, ident),
                )
                if body.subtitles.track_id
                else None,
                "subtitle_snapshot_fa": s.one(
                    "SELECT * FROM subtitles WHERE id=? AND project_id=?",
                    (body.subtitles.fa_track_id, ident),
                )
                if body.subtitles.fa_track_id
                else None,
            },
        )
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
    project_row = project(ident)
    edit = Edit.model_validate(json.loads(project_row["edit"]))
    rendered = rendered_clip(
        ident, render_fingerprint(project_row, edit, False), preview=False
    )
    return {"ok": True, "rendered": rendered}


@app.post("/api/projects/{ident}/subtitles")
async def upload_subtitles(
    ident: str,
    file: UploadFile = File(...),
    role: str = Form(default=""),
):
    project(ident)
    if role not in ("", "main", "fa"):
        raise ValueError("Choose a valid subtitle language role.")
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
            role=role,
            origin="upload",
        )
        return {"track_id": track_id}
    finally:
        path.unlink(missing_ok=True)


@app.post("/api/projects/{ident}/autosubtitle")
async def auto_subtitle(ident: str, body: AutoSubtitleRequest):
    row = project(ident)
    meta = json.loads(row["metadata"])
    if meta.get("local"):
        raise ValueError(
            "Automatic subtitles need the source audio. This project renders "
            "in your browser and the video was not uploaded."
        )
    if s.one(
        "SELECT id FROM jobs WHERE project_id=? AND kind='autosubtitle' AND status IN ('queued','running')",
        (ident,),
    ):
        raise ValueError("Automatic subtitles are already running for this project.")
    elevenlabs = s.setting("elevenlabs", {})
    if not elevenlabs.get("api_key"):
        raise ValueError("Add your ElevenLabs API token in Settings first.")
    if body.translate and not s.setting("ai", {}).get("api_key"):
        raise ValueError("Add your 9Router API token in Settings first.")
    limit = max_duration_minutes(elevenlabs)
    source_duration = float(meta.get("duration") or 0)
    selected = body.start is not None or body.end is not None
    start = float(body.start or 0)
    end = float(body.end if body.end is not None else source_duration)
    if selected:
        if end <= start:
            raise ValueError("Choose a clip range before creating subtitles.")
        if source_duration and end > source_duration + 1:
            raise ValueError("The selected clip is outside this video.")
        duration = end - start
    else:
        duration = source_duration
    if duration > limit * 60 + 0.5:
        what = "clip" if selected else "video"
        raise ValueError(
            f"This {what} is {duration / 60:.1f} minutes long. Automatic "
            f"subtitles are limited to {limit} minutes; raise the limit in "
            "Settings → Auto subtitles or select a shorter clip."
        )
    latest = s.one(
        "SELECT status FROM jobs WHERE project_id=? AND kind='autosubtitle' "
        "ORDER BY created DESC LIMIT 1",
        (ident,),
    )
    if s.one(
        "SELECT id FROM subtitles WHERE project_id=? AND origin='auto'",
        (ident,),
    ) and (not latest or latest["status"] == "completed"):
        raise ValueError(
            "Automatic subtitles already exist for this project. Edit the "
            "existing tracks or upload a replacement instead of using more tokens."
        )
    return {
        "job_id": s.job(
            "autosubtitle",
            ident,
            {
                "language": body.language,
                "translate": body.translate,
                "offset": start,
                "duration": duration,
                "slice": selected,
            },
        )
    }


@app.post("/api/projects/{ident}/autosubtitle-local")
async def auto_subtitle_local(
    ident: str,
    file: UploadFile = File(...),
    edit: str = Form(...),
    language: str = Form("en"),
    translate: bool = Form(True),
):
    """Transcribe only the selected clip's audio for a browser-only project."""
    row = project(ident)
    if not json.loads(row["metadata"]).get("local"):
        raise HTTPException(
            400, "This project is not a browser-only project."
        )
    body = Edit.model_validate_json(edit)
    validate_edit(row, body)
    if s.one(
        "SELECT id FROM jobs WHERE project_id=? AND kind='autosubtitle' AND status IN ('queued','running')",
        (ident,),
    ):
        raise ValueError("Automatic subtitles are already running for this project.")
    elevenlabs = s.setting("elevenlabs", {})
    if not elevenlabs.get("api_key"):
        raise ValueError("Add your ElevenLabs API token in Settings first.")
    if translate and not s.setting("ai", {}).get("api_key"):
        raise ValueError("Add your 9Router API token in Settings first.")
    limit = max_duration_minutes(elevenlabs)
    clip_duration = body.end - body.start
    if clip_duration > limit * 60 + 0.5:
        raise ValueError(
            f"This clip is {clip_duration / 60:.1f} minutes long. Automatic "
            f"subtitles are limited to {limit} minutes; raise the limit in "
            "Settings → Auto subtitles or select a shorter cut."
        )
    if len(language) < 2 or len(language) > 12:
        raise ValueError("Choose a valid transcription language.")
    latest = s.one(
        "SELECT status FROM jobs WHERE project_id=? AND kind='autosubtitle' "
        "ORDER BY created DESC LIMIT 1",
        (ident,),
    )
    if s.one(
        "SELECT id FROM subtitles WHERE project_id=? AND origin='auto'",
        (ident,),
    ) and (not latest or latest["status"] == "completed"):
        raise ValueError(
            "Automatic subtitles already exist for this project. Edit the "
            "existing tracks or upload a replacement instead of using more tokens."
        )
    audio = s.DATA / "work" / (s.uid() + ".mp3")
    try:
        await save_upload(file, audio, 256 * 1024**2)
        job_id = s.job(
            "autosubtitle",
            ident,
            {
                "language": language,
                "translate": translate,
                "audio_path": str(audio),
                "offset": body.start,
                "duration": clip_duration,
            },
        )
    except BaseException:
        audio.unlink(missing_ok=True)
        raise
    return {"job_id": job_id}


@app.post("/api/projects/{ident}/assets/{kind}")
async def upload_asset(ident: str, kind: str, file: UploadFile = File(...)):
    project(ident)
    return await save_asset(ident, kind, file)


async def save_asset(ident, kind, file):
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
        if row["kind"] in ("download", "youtube", "ingest"):
            s.execute(
                "UPDATE projects SET status='cancelled' WHERE id=?",
                (row["project_id"],),
            )
        if row["kind"] == "autosubtitle" and row["status"] == "queued":
            try:
                audio = s.decrypt(row["payload"]).get("audio_path")
            except Exception:
                audio = None
            if audio:
                Path(audio).unlink(missing_ok=True)
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
    payload = s.decrypt(row["payload"])
    if row["kind"] == "render" and payload.get("signature"):
        if existing_render(
            row["project_id"],
            payload["signature"],
            bool(payload.get("preview")),
        ):
            raise ValueError(
                "This exact clip is already rendered or rendering. Open the "
                "existing export instead of retrying this job."
            )
    if row["kind"] in ("download", "youtube", "ingest"):
        p = project(row["project_id"])
        # Remove partial subtitle extraction before retrying ingestion.
        s.execute("DELETE FROM subtitles WHERE project_id=?", (p["id"],))
        s.execute("UPDATE projects SET status='queued' WHERE id=?", (p["id"],))
    return {"job_id": s.job(row["kind"], row["project_id"], payload)}


def public_clip(row):
    row["preview"] = bool(row["preview"])
    paths = media.cover_paths(row)
    row["has_cover"] = bool(paths) and all(path.exists() for path in paths)
    row.pop("path")
    row["metadata"] = json.loads(row["metadata"])
    return row


@app.get("/api/clips")
async def clips():
    return [
        public_clip(row) for row in s.rows("SELECT * FROM clips ORDER BY created DESC")
    ]


@app.get("/api/media/project/{ident}/cover-frame")
async def project_cover_frame(ident: str):
    row = project(ident)
    frame = json.loads(row["metadata"]).get("cover_frame") or {}
    revision = frame.get("revision", "")
    if not re.fullmatch(r"[0-9a-f]{32}", revision):
        raise HTTPException(404, "No Telegram cover frame is selected.")
    path = s.DATA / "renders" / f"{ident}-cover-frame-{revision}.jpg"
    if not path.exists():
        raise HTTPException(404, "The selected cover frame is no longer available.")
    return FileResponse(path, media_type="image/jpeg")


@app.get("/api/media/project/{ident}/frame/{name}")
async def project_frame(ident: str, name: str):
    project(ident)
    if not re.fullmatch(r"[0-9a-f]{32}-\d{1,2}", name):
        raise HTTPException(404, "Cover frame not found.")
    path = s.DATA / "renders" / f"{ident}-frame-{name}.jpg"
    if not path.exists():
        raise HTTPException(404, "This cover frame is no longer available.")
    return FileResponse(path, media_type="image/jpeg")


@app.get("/api/media/project/{ident}/{kind}")
async def project_media(ident: str, kind: str):
    row = project(ident)
    if kind not in ("source", "thumbnail"):
        raise HTTPException(404, "This media is not available yet.")
    path = Path(row[kind]) if row[kind] else None
    media_type = (
        "image/jpeg"
        if kind == "thumbnail"
        else media.original_media_type(json.loads(row["metadata"]))
    )
    if path is None:
        raise HTTPException(404, "This media is not available yet.")
    if not path.exists():
        raise HTTPException(404, "This media file is no longer available.")
    return FileResponse(path, media_type=media_type)


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


@app.get("/api/media/clip/{ident}/cover")
async def clip_cover(ident: str):
    row = s.one("SELECT * FROM clips WHERE id=?", (ident,))
    paths = media.cover_paths(row) if row else ()
    if not paths or not paths[0].exists():
        raise HTTPException(404, "The cover is being prepared. Try again shortly.")
    return FileResponse(paths[0], media_type="image/jpeg")


@app.put("/api/clips/{ident}/cover")
async def select_cover(ident: str, body: CoverSelection):
    row = s.one("SELECT * FROM clips WHERE id=?", (ident,))
    if not row:
        raise HTTPException(404, "Clip not found.")
    if body.time is not None and body.time >= json.loads(row["metadata"])["duration"]:
        raise ValueError("Choose a cover frame inside the rendered clip.")
    require_idle(row["project_id"])
    return {
        "job_id": s.job(
            "cover", row["project_id"], {"clip_id": ident, "time": body.time}
        )
    }


def cover_frame_range(row, start=None, end=None, edit=None):
    info = json.loads(row["metadata"])
    edit = edit or Edit.model_validate(json.loads(row["edit"]))
    begin = edit.start if start is None else start
    finish = edit.end if end is None else end
    if finish <= begin or finish > float(info.get("duration") or 0) + 0.05:
        raise ValueError("Choose a cover range inside the original video.")
    return edit, begin, finish


@app.post("/api/projects/{ident}/cover-frames")
async def project_cover_frames(ident: str, body: CoverFrameCandidates):
    row = project(ident)
    if json.loads(row["metadata"]).get("local"):
        raise ValueError(
            "Cover frames are extracted from the local file in the browser."
        )
    edit, begin, finish = cover_frame_range(row, body.start, body.end, body.edit)
    for old in (s.DATA / "renders").glob(f"{ident}-frame-*.jpg"):
        old.unlink(missing_ok=True)
    token = s.uid()
    frames = []
    for index in range(body.count):
        timestamp = begin + (finish - begin) * (index + 1) / (body.count + 1)
        name = f"{token}-{index}"
        path = s.DATA / "renders" / f"{ident}-frame-{name}.jpg"
        await media.make_project_frame(
            row, edit, timestamp, path, max_edge=480, quality=5
        )
        frames.append(
            {
                "time": round(timestamp, 3),
                "url": f"/api/media/project/{ident}/frame/{name}",
            }
        )
    return {
        "frames": frames,
        "cover_frame": json.loads(row["metadata"]).get("cover_frame"),
    }


@app.put("/api/projects/{ident}/cover-frame")
async def select_project_cover_frame(ident: str, body: CoverFrameSelection):
    row = project(ident)
    edit, begin, finish = cover_frame_range(row, body.start, body.end, body.edit)
    info = json.loads(row["metadata"])
    previous = info.get("cover_frame") or {}
    if body.time is None:
        info.pop("cover_frame", None)
        s.execute(
            "UPDATE projects SET metadata=? WHERE id=?", (json.dumps(info), ident)
        )
        old = previous.get("revision", "")
        if re.fullmatch(r"[0-9a-f]{32}", old):
            (s.DATA / "renders" / f"{ident}-cover-frame-{old}.jpg").unlink(
                missing_ok=True
            )
        return {"cover_frame": None}
    if not begin <= body.time < finish:
        raise ValueError("Choose a cover frame inside the current clip.")
    revision = s.uid()
    path = s.DATA / "renders" / f"{ident}-cover-frame-{revision}.jpg"
    if json.loads(row["metadata"]).get("local"):
        if not body.image:
            raise ValueError(
                "Send the clean frame extracted by the browser as a JPEG."
            )
        raw = decode_jpeg_data_url(body.image, 3 * 1024**2)
        s.space_for(len(raw))
        path.write_bytes(raw)
    else:
        await media.make_project_frame(
            row, edit, body.time, path, max_edge=1280, quality=6
        )
    info["cover_frame"] = {
        "time": round(body.time, 3),
        "revision": revision,
    }
    s.execute("UPDATE projects SET metadata=? WHERE id=?", (json.dumps(info), ident))
    old = previous.get("revision", "")
    if re.fullmatch(r"[0-9a-f]{32}", old):
        (s.DATA / "renders" / f"{ident}-cover-frame-{old}.jpg").unlink(
            missing_ok=True
        )
    return {
        "cover_frame": info["cover_frame"],
        "url": f"/api/media/project/{ident}/cover-frame",
    }


@app.post("/api/clips/{ident}/caption")
async def caption_clip(ident: str):
    row = s.one("SELECT * FROM clips WHERE id=?", (ident,))
    if not row:
        raise HTTPException(404, "Clip not found.")
    project_row = project(row["project_id"])
    config = s.setting("ai", {})
    if not (config.get("api_key") or "").strip():
        raise ValueError("Add your 9Router API token in Settings first.")
    text = await captions.generate_caption(project_row, row, config)
    return {"caption": text}


@app.post("/api/clips/{ident}/send")
async def send_clip(ident: str, body: SendClip):
    row = s.one("SELECT * FROM clips WHERE id=?", (ident,))
    if not row:
        raise HTTPException(404, "Clip not found.")
    if s.one(
        "SELECT id FROM jobs WHERE kind='cover' AND project_id=? AND status IN ('running','queued')",
        (row["project_id"],),
    ):
        raise HTTPException(
            409, "Wait for the cover to finish before sending this clip."
        )
    await telegram.check()
    chat_id = body.chat_id.strip()
    if chat_id and not CHAT_TARGET.fullmatch(chat_id):
        raise ValueError(
            "Enter the numeric chat ID from the bot's /chatid command, or an @username."
        )
    if chat_id:
        destination = chat_id
    else:
        channels = await telegram.list_channels()
        if not channels:
            raise ValueError(
                "Add a Telegram channel in Settings, or turn off channel "
                "delivery and enter a chat ID for a test send."
            )
        destination = body.destination or channels[0]["id"]
        if not any(channel["id"] == destination for channel in channels):
            raise ValueError("Choose a configured Telegram channel.")
    return {
        "job_id": s.job(
            "telegram",
            row["project_id"],
            {
                "clip_id": ident,
                **body.model_dump(),
                "destination": destination,
                "chat_id": chat_id,
            },
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
    for path in media.cover_paths(row):
        path.unlink(missing_ok=True)
    s.execute("DELETE FROM clips WHERE id=?", (ident,))
    return {"ok": True}


@app.delete("/api/projects/{ident}")
async def delete_project(ident: str):
    row = project(ident)
    require_idle(ident)
    paths = [row[k] for k in ("source", "thumbnail") if row[k]]
    paths += [
        r["path"]
        for r in s.rows("SELECT path FROM assets WHERE project_id=?", (ident,))
    ]
    paths += [
        str(path)
        for clip in s.rows("SELECT * FROM clips WHERE project_id=?", (ident,))
        for path in (Path(clip["path"]), *media.cover_paths(clip))
    ]
    paths += [
        r["ass_path"]
        for r in s.rows("SELECT ass_path FROM subtitles WHERE project_id=?", (ident,))
        if r["ass_path"]
    ]
    paths += [
        str(path)
        for pattern in ("cover-frame-*", "frame-*")
        for path in (s.DATA / "renders").glob(f"{ident}-{pattern}.jpg")
    ]
    for path in paths:
        Path(path).unlink(missing_ok=True)
    for table in ("assets", "clips", "subtitles", "jobs"):
        s.execute(f"DELETE FROM {table} WHERE project_id=?", (ident,))
    s.execute("DELETE FROM projects WHERE id=?", (ident,))
    return {"ok": True}


def ai_settings():
    config = s.setting("ai", {})
    return {
        "base_url": config.get("base_url", "http://localhost:20128/v1"),
        "model": config.get("model", "kr/claude-sonnet-4.5"),
        "caption_prompt": config.get("caption_prompt") or DEFAULT_CAPTION_PROMPT,
        "api_key_saved": bool(config.get("api_key")),
    }


def elevenlabs_settings():
    config = s.setting("elevenlabs", {})
    return {
        "model": config.get("model", "scribe_v2"),
        "max_duration_minutes": max_duration_minutes(config),
        "api_key_saved": bool(config.get("api_key")),
    }


@app.get("/api/settings")
async def get_settings():
    config = s.setting("telegram", {})
    return {
        "telegram": {
            "api_id": config.get("api_id", ""),
            "api_hash_saved": bool(config.get("api_hash")),
            "bot_token_saved": bool(config.get("bot_token")),
            "default_channel": config.get("default_channel", ""),
            "channels": await telegram.list_channels(),
        },
        "telegram_status": await telegram.status(),
        "storage": storage_info(),
        "project_defaults": get_defaults().model_dump(),
        "ai": ai_settings(),
        "elevenlabs": elevenlabs_settings(),
    }


@app.put("/api/settings/ai")
async def save_ai_settings(body: AIConfig):
    from urllib.parse import urlparse

    base_url = body.base_url.strip().rstrip("/")
    parsed = urlparse(base_url)
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.netloc
        or parsed.username
        or parsed.password
    ):
        raise ValueError(
            "Enter the 9Router base URL, for example http://localhost:20128/v1."
        )
    existing = s.setting("ai", {})
    api_key = existing.get("api_key", "")
    if body.clear_key:
        api_key = ""
    elif body.api_key.strip():
        api_key = body.api_key.strip()
    caption_prompt = existing.get("caption_prompt") or DEFAULT_CAPTION_PROMPT
    if "caption_prompt" in body.model_fields_set:
        caption_prompt = body.caption_prompt.strip() or DEFAULT_CAPTION_PROMPT
    s.set_setting(
        "ai",
        {
            "api_key": api_key,
            "base_url": base_url,
            "model": body.model.strip() or "kr/claude-sonnet-4.5",
            "caption_prompt": caption_prompt,
        },
    )
    return ai_settings()


@app.put("/api/settings/elevenlabs")
async def save_elevenlabs_settings(body: ElevenLabsConfig):
    existing = s.setting("elevenlabs", {})
    api_key = existing.get("api_key", "")
    if body.clear_key:
        api_key = ""
    elif body.api_key.strip():
        api_key = body.api_key.strip()
    minutes = body.max_duration_minutes
    if minutes is None:
        minutes = max_duration_minutes(existing)
    s.set_setting(
        "elevenlabs",
        {
            "api_key": api_key,
            "model": body.model.strip() or "scribe_v2",
            "max_duration_minutes": minutes,
        },
    )
    return elevenlabs_settings()


@app.get("/api/settings/project-defaults")
async def get_project_defaults():
    return get_defaults()


@app.put("/api/settings/project-defaults")
async def set_project_defaults(body: ProjectDefaults):
    return save_defaults(body)


@app.patch("/api/settings/project-defaults")
async def patch_project_defaults(body: ProjectDefaultsPatch):
    with s.lock:
        defaults = get_defaults().model_dump()
        defaults.update(body.model_dump(exclude_none=True))
        return save_defaults(ProjectDefaults.model_validate(defaults))


@app.delete("/api/settings/project-defaults")
async def reset_project_defaults():
    return save_defaults(ProjectDefaults())


@app.post("/api/settings/project-defaults/watermark")
async def upload_default_watermark(
    defaults: str = Form(..., max_length=10000), file: UploadFile = File(...)
):
    body = ProjectDefaults.model_validate_json(defaults)
    result = await save_asset(None, "watermark", file)
    asset_id = result["asset_id"]
    try:
        with s.lock:
            body.watermark.kind = "image"
            body.watermark.asset_id = asset_id
            return save_defaults(body)
    finally:
        remove_default_asset(asset_id)


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
        for name in ("sources", "subtitles", "assets", "renders", "work")
    }
    usage["thumbnails"] = s.directory_bytes(s.DATA / "previews")
    return {
        "used": s.used_bytes(),
        "free": shutil.disk_usage(s.DATA).free,
        "limit_gb": s.setting("storage_limit_gb", 20),
        "categories": usage,
    }


@app.post("/api/settings/cleanup/{kind}")
async def cleanup(kind: str):
    require_idle()
    if kind not in ("thumbnails", "sources", "renders"):
        raise ValueError("Choose sources, thumbnails or renders.")
    directory = s.DATA / ("previews" if kind == "thumbnails" else kind)
    for path in directory.iterdir():
        if path.is_file():
            path.unlink()
    if kind == "sources":
        s.execute("UPDATE projects SET source=NULL,status='source removed'")
    elif kind == "thumbnails":
        s.execute("UPDATE projects SET thumbnail=NULL")
    else:
        s.execute("DELETE FROM clips")
    return storage_info()


@app.put("/api/settings/telegram")
async def save_telegram(body: TelegramConfig):
    import re

    existing = s.setting("telegram", {})
    api_hash = body.api_hash.strip() or existing.get("api_hash", "")
    bot_token = body.bot_token.strip() or existing.get("bot_token", "")
    if not re.fullmatch(r"[0-9a-fA-F]{32}", api_hash):
        raise ValueError("Enter the 32-character API hash from my.telegram.org.")
    if not re.fullmatch(r"\d{5,}:[A-Za-z0-9_-]{30,}", bot_token):
        raise ValueError(
            "Enter a bot token from @BotFather, for example 123456:ABC-DEF…."
        )
    config = {
        **existing,
        "api_id": body.api_id,
        "api_hash": api_hash,
        "bot_token": bot_token,
    }
    changed = any(
        config.get(key) != existing.get(key)
        for key in ("api_id", "api_hash", "bot_token")
    )
    if bot_token != existing.get("bot_token"):
        # Channel access hashes belong to the previous bot and are not reusable.
        config["channels"] = []
        config["default_channel"] = ""
    if changed:
        if s.one(
            "SELECT id FROM jobs WHERE kind='telegram' AND status IN ('running','queued')"
        ):
            raise HTTPException(
                409, "Wait for Telegram uploads to finish before changing the bot."
            )
        await telegram.disconnect(logout=False)
        s.set_setting("telegram_session", "")
        s.set_setting("telegram_bot_session", False)
    s.set_setting("telegram", config)
    status = await telegram.status()
    if changed and not status["connected"]:
        raise ValueError(
            status.get("error")
            or "Telegram could not connect with these bot credentials."
        )
    return {"ok": True, "status": status}


async def telegram_call(fn):
    try:
        return await fn()
    except Exception as exc:
        raise HTTPException(400, error_message(exc))


@app.get("/api/telegram/channels")
async def telegram_channels():
    return await telegram_call(telegram.list_channels)


@app.post("/api/telegram/channels")
async def telegram_add_channel(body: TelegramChannel):
    return await telegram_call(lambda: telegram.add_channel(body.channel))


@app.post("/api/telegram/channels/{ident}/verify")
async def telegram_verify_channel(ident: str):
    return await telegram_call(lambda: telegram.verify_channel(ident))


@app.delete("/api/telegram/channels/{ident}")
async def telegram_remove_channel(ident: str):
    return await telegram_call(lambda: telegram.remove_channel(ident))


@app.post("/api/telegram/disconnect")
async def telegram_disconnect():
    if s.one(
        "SELECT id FROM jobs WHERE kind='telegram' AND status IN ('queued','running')"
    ):
        raise HTTPException(
            409, "Finish or cancel Telegram uploads before disconnecting."
        )
    await telegram_call(telegram.disconnect)
    return {"connected": False, "configured": True}


@app.get("/api/fonts/file")
async def resolved_font_file(family: str, bold: bool = False):
    if family not in set(get_args(FontFamily)):
        raise HTTPException(404, "Font not found.")
    path = await font_path(family, bold)
    if not path or not Path(path).is_file():
        raise HTTPException(404, "Font not found.")
    return FileResponse(path, media_type="font/ttf")


@app.get("/api/fonts/{font}")
async def font_file(font: str):
    if font not in FONT_SLUGS:
        raise HTTPException(404, "Font not found.")
    return FileResponse(await font_path(FONT_SLUGS[font]), media_type="font/ttf")


static = Path(os.getenv("STATIC_DIR", "/app/static"))
if static.exists():
    app.mount("/assets", StaticFiles(directory=static / "assets"), name="static-assets")
    ffmpeg_static = static / "ffmpeg"
    if ffmpeg_static.exists():
        app.mount(
            "/ffmpeg",
            StaticFiles(directory=ffmpeg_static),
            name="ffmpeg-core",
        )

    @app.get("/{path:path}")
    async def frontend(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "Endpoint not found.")
        return FileResponse(static / "index.html")
