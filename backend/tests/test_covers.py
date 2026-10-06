import asyncio
import json
import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from app import media, store as s
from app.main import app, new_project
from test_workflow import ffmpeg, login, wait_job


@pytest.fixture
def legacy_clip():
    pid, ident = new_project("Cover test", "ready"), s.uid()
    path = s.DATA / "renders" / (ident + ".mp4")
    ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=640x360:r=30:d=1",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=640x360:r=30:d=1",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        path,
    )
    # Deliberately use the metadata shape from older installations.
    s.execute(
        "INSERT INTO clips VALUES (?,?,?,?,?,?,?)",
        (
            ident,
            pid,
            "cover-test.mp4",
            str(path),
            json.dumps(
                {
                    "duration": 2,
                    "width": 640,
                    "height": 360,
                    "video_codec": "h264",
                    "audio": [],
                }
            ),
            time.time(),
            0,
        ),
    )
    yield ident, pid
    clip = s.one("SELECT * FROM clips WHERE id=?", (ident,))
    if clip:
        for file in (*media.cover_paths(clip), path):
            file.unlink(missing_ok=True)
    for table in ("jobs", "clips", "projects"):
        s.execute(
            f"DELETE FROM {table} WHERE {'id' if table == 'projects' else 'project_id'}=?",
            (pid,),
        )


def rgb(path):
    return subprocess.check_output(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-vf",
            "scale=1:1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ]
    )


def test_automatic_backfill_manual_frame_reset_and_cleanup(legacy_clip):
    ident, pid = legacy_clip
    with TestClient(app) as client:
        login(client)
        job = next(
            job
            for job in client.get("/api/jobs").json()
            if job["project_id"] == pid and job["kind"] == "cover"
        )
        wait_job(client, job["id"])
        clip = s.one("SELECT * FROM clips WHERE id=?", (ident,))
        old_files = media.cover_paths(clip)
        info = json.loads(clip["metadata"])
        assert info["cover"]["mode"] == "auto" and info["telegram_compatible"]
        color = rgb(old_files[0])
        assert color[0] > 240 and color[2] < 10  # Automatic 1s frame is red.
        endpoint = f"/api/clips/{ident}/cover"
        assert client.put(endpoint, json={"time": 2}).status_code == 400
        assert client.put(endpoint, json={"time": -1}).status_code == 422
        response = client.put(endpoint, json={"time": 0.25})
        assert response.status_code == 200
        wait_job(client, response.json()["job_id"])
        clip = s.one("SELECT * FROM clips WHERE id=?", (ident,))
        info = json.loads(clip["metadata"])
        assert info["cover"]["time"] == 0.25 and info["cover"]["mode"] == "manual"
        files = media.cover_paths(clip)
        color = rgb(files[0])
        assert color[2] > 240 and color[0] < 10  # Chosen 0.25s frame is blue.
        assert all(not path.exists() for path in old_files)
        assert (
            client.get(f"/api/media/clip/{ident}/cover").content
            == files[0].read_bytes()
        )
        response = client.put(endpoint, json={"time": None})
        wait_job(client, response.json()["job_id"])
        current = s.one("SELECT * FROM clips WHERE id=?", (ident,))
        assert json.loads(current["metadata"])["cover"]["mode"] == "auto"
        assert all(not path.exists() for path in files)
        files = media.cover_paths(current)
        blocked = s.job("telegram", pid, {"clip_id": ident})
        s.update_job(blocked, status="running")
        assert client.put(endpoint, json={"time": 0.5}).status_code == 409
        s.execute("DELETE FROM jobs WHERE id=?", (blocked,))
        assert client.delete(f"/api/clips/{ident}").status_code == 200
        assert all(not path.exists() for path in files)


def test_cover_failure_preserves_previous_selection(legacy_clip, monkeypatch):
    ident, _ = legacy_clip
    clip = s.one("SELECT * FROM clips WHERE id=?", (ident,))
    asyncio.run(media.update_cover(clip, 0.25))
    clip = s.one("SELECT * FROM clips WHERE id=?", (ident,))
    paths = media.cover_paths(clip)
    original = media.run
    count = 0

    async def interrupted(*args, **kwargs):
        nonlocal count
        count += 1
        if count == 2:
            raise media.Cancelled()
        await original(*args, **kwargs)

    monkeypatch.setattr(media, "run", interrupted)
    with pytest.raises(media.Cancelled):
        asyncio.run(media.update_cover(clip, 1.5))
    assert (
        s.one("SELECT metadata FROM clips WHERE id=?", (ident,))["metadata"]
        == clip["metadata"]
    )
    assert all(path.exists() for path in paths)
    assert set((s.DATA / "renders").glob(ident + "-*.jpg")) == set(paths)
