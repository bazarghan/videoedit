import hashlib
import sys
import threading
import time
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main, store as s, youtube


@pytest.fixture
def client():
    token = s.uid()
    digest = hashlib.sha256(token.encode()).hexdigest()
    s.execute("INSERT INTO sessions VALUES (?,?)", (digest, time.time() + 3600))
    before = {row["id"] for row in s.rows("SELECT id FROM projects")}
    test_client = TestClient(main.app)
    test_client.cookies.set("videoedit_session", token)
    try:
        yield test_client
    finally:
        for row in s.rows("SELECT id FROM projects"):
            if row["id"] not in before:
                s.execute("DELETE FROM jobs WHERE project_id=?", (row["id"],))
                s.execute("DELETE FROM projects WHERE id=?", (row["id"],))
        s.execute("DELETE FROM sessions WHERE token=?", (digest,))
        test_client.close()


@pytest.mark.parametrize(
    "link",
    [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtube.com/shorts/dQw4w9WgXcQ?si=share-token",
        "https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
        "https://www.youtube.com/embed/dQw4w9WgXcQ",
        "youtu.be/dQw4w9WgXcQ",
    ],
)
def test_youtube_links_are_normalized(link):
    value = youtube.validate_youtube_url(link)
    assert value.startswith("https://")
    assert youtube.is_youtube_url(value)


@pytest.mark.parametrize(
    "link",
    [
        "https://example.com/video.mp4",
        "https://vimeo.com/123456",
        "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
        "https://www.youtube.com/playlist?list=PL123",
        "https://www.youtube.com/@somechannel",
        "https://www.youtube.com/results?search_query=clips",
        "https://www.youtube.com/watch?v=",
        "https://www.youtube.com/",
        "https://youtu.be/short",
        "ftp://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "http://127.0.0.1/watch?v=dQw4w9WgXcQ",
    ],
)
def test_non_video_youtube_links_are_rejected(link):
    with pytest.raises(ValueError):
        youtube.validate_youtube_url(link)


def test_import_url_routes_youtube_to_the_downloader(client):
    response = client.post(
        "/api/import/url",
        json={"url": "https://youtu.be/dQw4w9WgXcQ", "name": ""},
    )
    assert response.status_code == 200
    data = response.json()
    job = s.one("SELECT kind, payload FROM jobs WHERE id=?", (data["job_id"],))
    payload = s.decrypt(job["payload"])
    assert job["kind"] == "youtube"
    assert payload == {"url": "https://youtu.be/dQw4w9WgXcQ"}
    project = s.one("SELECT name FROM projects WHERE id=?", (data["project_id"],))
    assert project["name"] == "Imported video"


def test_import_url_keeps_direct_downloads(client):
    response = client.post(
        "/api/import/url", json={"url": "https://example.com/video.mp4"}
    )
    assert response.status_code == 200
    data = response.json()
    job = s.one("SELECT kind FROM jobs WHERE id=?", (data["job_id"],))
    assert job["kind"] == "download"


def test_downloader_moves_the_finished_file(monkeypatch):
    class FakeYoutubeDL:
        def __init__(self, options):
            self.options = options

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def extract_info(self, url, download):
            assert download is True
            produced = Path(self.options["outtmpl"].replace("%(ext)s", "mp4"))
            produced.write_bytes(b"\x00\x00\x00\x18ftypmp42")
            return {"title": "  A  test\nvideo "}

    fake = types.SimpleNamespace(
        YoutubeDL=FakeYoutubeDL,
        utils=types.SimpleNamespace(YoutubeDLError=Exception),
    )
    monkeypatch.setitem(sys.modules, "yt_dlp", fake)
    project_id = s.uid()
    destination = s.DATA / "sources" / (project_id + ".media")
    job_id = s.job("youtube", project_id, {"url": "https://youtu.be/dQw4w9WgXcQ"})
    s.update_job(job_id, status="running")
    try:
        title = youtube._download_sync(
            project_id,
            "https://youtu.be/dQw4w9WgXcQ",
            None,
            job_id,
            threading.Event(),
        )
        assert youtube._clean_title(title) == "A test video"
        assert destination.read_bytes().startswith(b"\x00\x00\x00\x18ftyp")
        assert not list((s.DATA / "sources").glob(project_id + ".ytdlp.*"))
    finally:
        destination.unlink(missing_ok=True)
        s.execute("DELETE FROM jobs WHERE id=?", (job_id,))
