import asyncio
import hashlib
import json
import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from app import media, store as s
from app.main import app, new_project
from test_workflow import login, wait_job


@pytest.fixture(scope="module")
def browser_sources(tmp_path_factory):
    root = tmp_path_factory.mktemp("browser-sources")
    cases = {
        "mp4": ("libx264", "yuv420p", "aac", "mp4", []),
        "webm": ("libvpx-vp9", "yuv420p", "libopus", "webm", []),
        "mkv": ("libx264", "yuv420p", "aac", "mkv", []),
        "unsupported": ("libx264", "yuv444p", "aac", "mp4", []),
        "hevc": (
            "libx265",
            "yuv420p",
            "aac",
            "mp4",
            [
                "-tag:v",
                "hvc1",
                "-x265-params",
                "pools=1:frame-threads=1:log-level=error",
            ],
        ),
    }
    for name, (video, pixel, audio, extension, extra) in cases.items():
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=320x180:r=25:d=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-c:v",
                video,
                "-pix_fmt",
                pixel,
                "-threads",
                "1",
                "-c:a",
                audio,
                *extra,
                str(root / f"{name}.{extension}"),
            ],
            check=True,
        )
    return root


@pytest.mark.parametrize(
    "name,extension", [("mp4", "mp4"), ("webm", "webm"), ("hevc", "mp4")]
)
def test_compatible_import_uses_original(browser_sources, name, extension):
    source = browser_sources / f"{name}.{extension}"
    with TestClient(app) as client:
        login(client)
        response = client.post(
            "/api/import/upload", files={"file": (source.name, source.read_bytes())}
        )
        assert response.status_code == 200
        imported = response.json()
        wait_job(client, imported["job_id"])
        pid = imported["project_id"]
        project = client.get(f"/api/projects/{pid}").json()
        assert project["status"] == "ready"
        assert project["source_playback_type"].startswith("video/" + extension)
        assert project["has_preview"] is False
        assert not s.rows(
            "SELECT id FROM jobs WHERE project_id=? AND kind='proxy'", (pid,)
        )
        assert not list((s.DATA / "previews").glob(pid + "-*.mp4"))
        playback = client.get(
            f"/api/media/project/{pid}/preview", headers={"Range": "bytes=0-99"}
        )
        assert playback.status_code == 206
        assert playback.content == source.read_bytes()[:100]
        assert playback.headers["content-type"] == "video/" + extension
        assert client.post(f"/api/projects/{pid}/preview").json() == {
            "job_id": None,
            "direct": True,
        }
        assert (
            client.get(
                f"/api/media/project/{pid}/preview?force_preview=true"
            ).status_code
            == 404
        )

        # A browser rejecting the original can explicitly request a fallback.
        forced = client.post(f"/api/projects/{pid}/preview?force=true").json()
        wait_job(client, forced["job_id"])
        fallback = client.get(f"/api/media/project/{pid}/preview?force_preview=true")
        assert fallback.status_code == 200
        assert fallback.headers["content-type"] == "video/mp4"
        assert media.telegram_compatible(
            asyncio.run(media.probe(media.cached_preview({"id": pid})))
        )
        assert (
            client.get(f"/api/media/project/{pid}/preview").content
            == source.read_bytes()
        )
        assert (
            client.post(f"/api/projects/{pid}/preview?force=true").json()["job_id"]
            is None
        )
    with TestClient(app) as anonymous:
        assert anonymous.get(f"/api/media/project/{pid}/preview").status_code == 401


@pytest.mark.parametrize("name,extension", [("mkv", "mkv"), ("unsupported", "mp4")])
def test_incompatible_import_generates_preview(browser_sources, name, extension):
    source = browser_sources / f"{name}.{extension}"
    with TestClient(app) as client:
        login(client)
        result = client.post(
            "/api/import/upload", files={"file": (source.name, source.read_bytes())}
        ).json()
        wait_job(client, result["job_id"])
        pid = result["project_id"]
        jobs = s.rows("SELECT id FROM jobs WHERE project_id=? AND kind='proxy'", (pid,))
        assert len(jobs) == 1
        wait_job(client, jobs[0]["id"])
        project = client.get(f"/api/projects/{pid}").json()
        assert project["source_playback_type"] is None
        assert project["has_preview"]
        assert client.get(f"/api/media/project/{pid}/preview").status_code == 200


def test_existing_import_is_backfilled(browser_sources):
    source = browser_sources / "mp4.mp4"
    pid = new_project("Existing compatible source", source=str(source), status="ready")
    old_metadata = asyncio.run(media.probe(source))
    old_metadata.pop("browser_container")
    old_metadata.pop("pixel_format")
    s.execute(
        "UPDATE projects SET metadata=? WHERE id=?", (json.dumps(old_metadata), pid)
    )
    with TestClient(app) as client:
        login(client)
        project = client.get(f"/api/projects/{pid}").json()
        assert project["source_playback_type"].startswith("video/mp4")
        assert (
            client.get(f"/api/media/project/{pid}/preview").content
            == source.read_bytes()
        )
        assert s.one("SELECT source FROM projects WHERE id=?", (pid,))["source"] == str(
            source
        )


def test_audio_tracks_have_separate_preview_jobs(browser_sources):
    source = browser_sources / "mkv.mkv"
    pid = new_project("Multiple audio tracks", source=str(source), status="ready")
    metadata = asyncio.run(media.probe(source))
    metadata["audio"].append({**metadata["audio"][0], "index": 2})
    s.execute("UPDATE projects SET metadata=? WHERE id=?", (json.dumps(metadata), pid))
    # No workers: inspect queueing and deduplication without processing this fixture.
    client = TestClient(app)
    token = s.uid()
    s.execute(
        "INSERT INTO sessions VALUES (?,?)",
        (hashlib.sha256(token.encode()).hexdigest(), time.time() + 60),
    )
    client.cookies.set("videoedit_session", token)
    first = client.post(f"/api/projects/{pid}/preview?audio_track=0").json()
    second = client.post(f"/api/projects/{pid}/preview?audio_track=1").json()
    assert first["job_id"] != second["job_id"]
    assert client.post(f"/api/projects/{pid}/preview?audio_track=1").json() == second
    for job in (first, second):
        s.update_job(job["job_id"], status="cancelled", finished=time.time())
