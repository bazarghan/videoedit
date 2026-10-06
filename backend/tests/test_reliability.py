import asyncio
import json
import socket
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
from telethon import errors


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


def test_telegram_login_and_explicit_upload(monkeypatch, tmp_path):
    from app import telegram as module

    calls = []

    class Client:
        def __init__(self, *args, **kwargs):
            self.authorized = False
            self.connected = False
            self.session = SimpleNamespace(save=lambda: "authorized-secret-session")

        def is_connected(self):
            return self.connected

        async def connect(self):
            self.connected = True

        async def disconnect(self):
            self.connected = False

        async def is_user_authorized(self):
            return self.authorized

        async def send_code_request(self, phone):
            calls.append("request-code")
            return SimpleNamespace(phone_code_hash="ephemeral-code-hash")

        async def sign_in(self, **kwargs):
            if "password" not in kwargs:
                raise errors.SessionPasswordNeededError(None)
            self.authorized = True
            calls.append("sign-in")

        async def get_me(self):
            return SimpleNamespace(
                first_name="Test", last_name="Account", username="test", premium=False
            )

        async def get_input_entity(self, dest):
            return dest

        async def send_file(self, entity, path, **kwargs):
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
            "phone": "+15551234567",
            "destination": "me",
        },
    )
    tg = Telegram()
    clip_id = s.uid()
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"video")
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
        assert (await tg.connect())["step"] == "code"
        assert (await tg.verify(code="12345"))["step"] == "password"
        assert (await tg.verify(password="never-persist-this"))["connected"]
        assert not any(isinstance(c, tuple) for c in calls)
        payload = {
            "clip_id": clip_id,
            "destination": "me",
            "caption": "Literal <caption>",
            "as_file": False,
        }
        ident = s.job("telegram", "test-project", payload)
        await tg.send(payload, ident)
        assert (
            s.one("SELECT progress FROM jobs WHERE id=?", (ident,))["progress"] == 100
        )
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
    s.set_setting("telegram", {})


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
