import asyncio
import json
import socket
import subprocess
from pathlib import Path
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from app import store as s
from app.main import app
from app.media import Cancelled
from app.network import PublicResolver
from app.telegram import Telegram
from app.workers import download
from fastapi.testclient import TestClient
from telethon import types, functions


def test_dns_rebinding_rejected(monkeypatch):
    async def scenario():
        loop = asyncio.get_running_loop()
        monkeypatch.setattr(
            loop,
            "getaddrinfo",
            AsyncMock(
                return_value=[
                    (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443)),
                    (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443)),
                ]
            ),
        )
        with pytest.raises(ValueError, match="restricted"):
            await PublicResolver().resolve("public.example", 443)

    asyncio.run(scenario())


def test_redirect_and_signed_query_preserved(monkeypatch):
    from app import workers

    expected = "https://cdn.example/video.mp4?token=a%2Fb&expires=123&signature=xyz%2B1"
    requested = []

    class Content:
        async def iter_chunked(self, size):
            yield b"fake-video-bytes"

    class Reply:
        def __init__(self, status, headers):
            self.status = status
            self.headers = headers
            self.content = Content()
            self.content_length = 16

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

    class Session:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        def get(self, url, **kwargs):
            requested.append(str(url))
            return (
                Reply(302, {"Location": expected})
                if len(requested) == 1
                else Reply(200, {})
            )

    monkeypatch.setattr(workers, "connector", lambda proxy=None: None)
    monkeypatch.setattr(workers.aiohttp, "ClientSession", Session)
    monkeypatch.setattr(workers.media, "ingest", AsyncMock())
    pid = s.uid()
    ident = s.job("download", pid, {"url": "https://example.com/start"})
    asyncio.run(download(pid, {"url": "https://example.com/start"}, ident))
    assert requested == ["https://example.com/start", expected]
    raw = s.one("SELECT payload FROM jobs WHERE id=?", (ident,))["payload"]
    assert "https://" not in raw
    s.execute("DELETE FROM jobs WHERE id=?", (ident,))


def test_restart_recovers_queue_honestly():
    running = s.job("render", "missing-project", {})
    s.update_job(running, status="running")
    queued = s.job("render", "missing-project", {})
    with TestClient(app):
        assert (
            s.one("SELECT status FROM jobs WHERE id=?", (running,))["status"]
            == "interrupted"
        )
        # It may already be failed by the worker, but it must never be labelled completed.
        assert s.one("SELECT status FROM jobs WHERE id=?", (queued,))["status"] in (
            "queued",
            "running",
            "failed",
        )
    s.execute("DELETE FROM jobs WHERE id IN (?,?)", (running, queued))


def test_telegram_bot_channel_verification_and_upload(monkeypatch, tmp_path):
    from app import telegram as module

    calls = []
    sent_media = []
    channel = types.Channel(
        id=1234567890,
        access_hash=987654321,
        title="Test channel",
        username="testchannel",
        broadcast=True,
        photo=types.ChatPhotoEmpty(),
        date=datetime.now(timezone.utc),
    )

    class Client:
        def __init__(self, *args, **kwargs):
            self.authorized = False
            self.connected = False
            self.event_handlers = []
            self.session = SimpleNamespace(save=lambda: "authorized-secret-session")

        def add_event_handler(self, callback, event):
            self.event_handlers.append((callback, event))

        def is_connected(self):
            return self.connected

        async def connect(self):
            self.connected = True

        async def disconnect(self):
            self.connected = False

        async def is_user_authorized(self):
            return self.authorized

        async def sign_in(self, **kwargs):
            assert kwargs == {"bot_token": "123456:bot-token-that-is-long-enough-123"}
            self.authorized = True
            calls.append("bot-sign-in")

        async def get_me(self):
            return SimpleNamespace(
                first_name="Test", last_name="Bot", username="test_bot", premium=False
            )

        async def get_entity(self, value):
            if isinstance(value, types.InputPeerChannel):
                assert value.channel_id == channel.id
                assert value.access_hash == channel.access_hash
                return channel
            if value == 555:
                return SimpleNamespace(id=555, first_name="Test", last_name="User")
            assert value == "@testchannel"
            return channel

        async def get_permissions(self, entity, user):
            assert entity is channel and user == "me"
            return SimpleNamespace(is_admin=True, post_messages=True)

        async def get_input_entity(self, dest):
            return dest

        async def upload_file(self, path, **kwargs):
            assert Path(path).exists()
            if kwargs.get("progress_callback"):
                await kwargs["progress_callback"](
                    Path(path).stat().st_size, Path(path).stat().st_size
                )
            calls.append(("upload", Path(path).suffix))
            return types.InputFile(
                id=123,
                parts=1,
                name=kwargs.get("file_name", Path(path).name),
                md5_checksum="",
            )

        async def __call__(self, request):
            assert isinstance(request, functions.messages.UploadMediaRequest)
            assert isinstance(request.media, types.InputMediaUploadedPhoto)
            calls.append(("register-cover", request.peer))
            return types.MessageMediaPhoto(
                photo=types.Photo(
                    id=7,
                    access_hash=8,
                    file_reference=b"photo-ref",
                    date=datetime.now(timezone.utc),
                    sizes=[],
                    dc_id=2,
                )
            )

        async def send_file(self, entity, path, **kwargs):
            sent_media.append((path, kwargs))
            calls.append(("send", entity, kwargs["force_document"], kwargs["caption"]))
            await kwargs["progress_callback"](5, 10)
            await kwargs["progress_callback"](10, 10)

        async def log_out(self):
            self.authorized = False
            calls.append("logout")

    monkeypatch.setattr(module, "TelegramClient", Client)
    s.set_setting(
        "telegram",
        {
            "api_id": 123,
            "api_hash": "a" * 32,
            "bot_token": "123456:bot-token-that-is-long-enough-123",
            "channels": [],
            "default_channel": "",
        },
    )
    tg = Telegram()
    clip_id = s.uid()
    path = tmp_path / "clip.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=320x180:r=30:d=1",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(path),
        ],
        check=True,
    )
    s.execute(
        "INSERT INTO clips VALUES (?,?,?,?,?,?,?)",
        (
            clip_id,
            "test-project",
            "test.mp4",
            str(path),
            json.dumps({"duration": 1, "width": 10, "height": 10}),
            0,
            0,
        ),
    )

    async def scenario():
        status = await tg.status()
        assert status["connected"] and status["username"] == "test_bot"
        assert calls == ["bot-sign-in"]
        assert len(tg.client.event_handlers) == 1
        added = await tg.add_channel("@testchannel")
        assert added["id"] == str(channel.id) and not added["error"]
        assert (await tg.verify_channel(added["id"]))["name"] == "Test channel"
        assert [c["id"] for c in await tg.list_channels()] == [str(channel.id)]
        payload = {
            "clip_id": clip_id,
            "destination": added["id"],
            "caption": "<b>Formatted</b> caption",
            "as_file": False,
        }
        ident = s.job("telegram", "test-project", payload)
        await tg.send(payload, ident)
        document, options = sent_media[-1]
        assert isinstance(document, types.InputMediaUploadedDocument)
        assert document.video_cover.id == 7 and document.thumb.name.endswith(".jpg")
        assert document.mime_type == "video/mp4" and document.nosound_video
        assert (
            document.video_timestamp is None
        )  # Selecting a cover keeps playback at the beginning.
        video = next(
            attr
            for attr in document.attributes
            if isinstance(attr, types.DocumentAttributeVideo)
        )
        assert (
            video.supports_streaming and video.nosound and video.video_codec == "h264"
        )
        assert video.w == 320 and video.h == 180 and video.duration == 1
        assert options["parse_mode"] == "html"
        assert (
            s.one("SELECT progress FROM jobs WHERE id=?", (ident,))["progress"] == 100
        )
        await tg.send({**payload, "as_file": True}, ident)
        document, options = sent_media[-1]
        assert document == str(path) and options["force_document"]
        assert (
            options["thumb"].endswith(".jpg")
            and Path(options["thumb"]).stat().st_size < 20 * 1024
        )
        # A manual chat ID is a test delivery and ignores configured channels.
        await tg.send(
            {**payload, "destination": "", "chat_id": "555", "as_file": True},
            ident,
        )
        target = calls[-1][1]
        assert target.id == 555 and calls[-1][2] is True
        s.update_job(ident, status="cancelled")
        with pytest.raises(Cancelled):
            await tg.send(payload, ident)
        await tg.disconnect()
        s.execute("DELETE FROM jobs WHERE id=?", (ident,))

    asyncio.run(scenario())
    database = (s.DATA / "videoedit.sqlite3").read_bytes()
    assert (
        b"never-persist-this" not in database
        and b"authorized-secret-session" not in database
    )
    assert calls[-1] == "logout"
    s.execute("DELETE FROM clips WHERE id=?", (clip_id,))
    for path in (s.DATA / "renders").glob(clip_id + "-*.jpg"):
        path.unlink(missing_ok=True)
    s.set_setting("telegram", {})


def test_chatid_command_and_numeric_chat_resolution(monkeypatch):
    replies = []

    class Event:
        def __init__(self, chat_id, chat):
            self.chat_id = chat_id
            self.chat = chat

        async def get_chat(self):
            return self.chat

        async def reply(self, text):
            replies.append(text)

    tg = Telegram()
    asyncio.run(
        tg.receive_chatid(
            Event(1234, SimpleNamespace(first_name="Test", last_name="User"))
        )
    )
    asyncio.run(
        tg.receive_chatid(
            Event(
                -1001234567890,
                SimpleNamespace(title="Test Group", first_name=None, last_name=None),
            )
        )
    )
    assert "Test User" in replies[0] and "Chat ID: 1234" in replies[0]
    assert "Test Group" in replies[1] and "Chat ID: -1001234567890" in replies[1]

    channel = types.Channel(
        id=1234567890,
        access_hash=987654321,
        title="Test Group",
        photo=types.ChatPhotoEmpty(),
        date=datetime.now(timezone.utc),
    )

    class Client:
        async def get_entity(self, value):
            raise ValueError("not cached")

        async def iter_dialogs(self):
            yield SimpleNamespace(entity=channel)

    monkeypatch.setattr(tg, "get", AsyncMock(return_value=Client()))
    resolved = asyncio.run(tg._resolve_chat("-1001234567890"))
    assert resolved is channel


def test_upload_admission_prevents_spool_exhaustion():
    with TestClient(app) as client:
        client.post(
            "/api/login",
            json={"username": "admin", "password": "test-password-do-not-use"},
        )
        response = client.post(
            "/api/import/upload",
            headers={
                "Content-Length": str(30 * 1024**3),
                "Content-Type": "multipart/form-data; boundary=test",
            },
            content=b"",
        )
        assert response.status_code == 413
        assert (
            client.post(
                "/api/import/upload",
                headers={"Transfer-Encoding": "chunked"},
                content=iter([b"chunk"]),
            ).status_code
            == 411
        )
