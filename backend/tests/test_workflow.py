import subprocess
import time

import pysubs2
import pytest
from app import store as s
from app.main import app
from app.media import dimensions, make_subs
from app.models import Edit
from app.network import validate_url
from fastapi.testclient import TestClient


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *map(str, args)], check=True)


@pytest.fixture(scope="module")
def footage(tmp_path_factory):
    path = tmp_path_factory.mktemp("footage")
    (path / "captions.srt").write_text(
        "1\n00:00:01,000 --> 00:00:04,000\nA moment worth keeping\n\n2\n00:00:04,000 --> 00:00:09,000\nMake it yours\n"
    )
    ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=30:duration=10",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=10",
        "-i",
        path / "captions.srt",
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-map",
        "2:s",
        "-c:v",
        "libx265",
        "-x265-params",
        "pools=1:frame-threads=1:log-level=error",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        "-c:s",
        "srt",
        "-metadata:s:s:0",
        "language=eng",
        path / "source.mkv",
    )
    ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:duration=3",
        "-c:a",
        "pcm_s16le",
        path / "music.wav",
    )
    ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "color=c=red@0.5:s=100x50,format=rgba",
        "-frames:v",
        "1",
        path / "mark.png",
    )
    return path


def wait_job(client, ident):
    deadline = time.time() + 120
    while time.time() < deadline:
        row = next(j for j in client.get("/api/jobs").json() if j["id"] == ident)
        if row["status"] not in ("queued", "running"):
            assert row["status"] == "completed", row
            return row
        time.sleep(0.2)
    pytest.fail("Job did not finish")


def login(client):
    response = client.post(
        "/api/login", json={"username": "admin", "password": "test-password-do-not-use"}
    )
    assert response.status_code == 200, response.text


def test_complete_workflow(footage, tmp_path):
    with TestClient(app) as client:
        assert client.get("/api/projects").status_code == 401
        assert (
            client.post(
                "/api/import/url", json={"url": "https://example.com/source.mp4"}
            ).status_code
            == 401
        )
        login(client)
        with (footage / "source.mkv").open("rb") as f:
            result = client.post(
                "/api/import/upload",
                files={"file": ("demo.mkv", f, "video/x-matroska")},
            )
        assert result.status_code == 200, result.text
        result = result.json()
        pid = result["project_id"]
        wait_job(client, result["job_id"])
        p = client.get("/api/projects/" + pid).json()
        assert p["metadata"]["width"] == 640 and p["subtitles"][0]["editable"] == 1
        assert p["metadata"]["video_codec"] == "hevc"
        proxy = next(
            j
            for j in client.get("/api/jobs").json()
            if j["kind"] == "proxy" and j["project_id"] == pid
        )
        wait_job(client, proxy["id"])
        playback = client.get(
            f"/api/media/project/{pid}/preview", headers={"Range": "bytes=0-99"}
        )
        assert playback.status_code == 206 and len(playback.content) == 100
        assert playback.headers["content-range"].startswith("bytes 0-99/")
        track = p["subtitles"][0]["id"]
        cue_result = client.get(f"/api/projects/{pid}/subtitles/{track}").json()
        assert cue_result["cues"][0]["text"] == "A moment worth keeping"
        edit = p["edit"]
        edit.update(start=2.25, end=6.75, filename="verified-vertical", resolution=720)
        edit["subtitles"].update(size=72, color="#ffff00", offset=0.25)
        edit["crop"].update(ratio="9:16", x=0.4)
        edit["watermark"].update(kind="text", text="VideoEdit", x=0.9, y=0.1, size=50)
        with (footage / "music.wav").open("rb") as f:
            music = client.post(
                f"/api/projects/{pid}/assets/music", files={"file": ("music.wav", f)}
            ).json()["asset_id"]
        edit["audio"].update(
            music_id=music, music_volume=0.25, fade_in=0.5, fade_out=0.8
        )
        # Cues crossing either trim boundary are clipped and shifted to output time.
        model = Edit.model_validate(edit)
        w, h = dimensions(p["metadata"], model)
        ass = make_subs(pid, model, 2.25, 6.75, w, h, tmp_path)
        events = pysubs2.load(str(ass))
        assert events[0].start == 0 and events[-1].end == 4500
        boundary = round((cue_result["cues"][1]["start"] + 0.25 - 2.25) * 1000)
        assert (
            abs(events[0].end - boundary) <= 10
            and abs(events[1].start - boundary) <= 10
        )
        assert events.styles["Default"].fontsize == 48
        assert events.styles["Default"].primarycolor.r == 255
        rendered = client.post(f"/api/projects/{pid}/render", json=edit)
        assert rendered.status_code == 200, rendered.text
        job_id = rendered.json()["job_id"]
        # Cleanup cannot delete files required by queued/running jobs.
        assert client.post("/api/settings/cleanup/sources").status_code == 409
        job = wait_job(client, job_id)
        clip = next(
            c for c in client.get("/api/clips").json() if c["id"] == job["result_id"]
        )
        assert abs(clip["metadata"]["duration"] - 4.5) < 0.1
        assert (clip["metadata"]["width"], clip["metadata"]["height"]) == (404, 720)
        assert (
            clip["metadata"]["video_codec"] == "h264"
            and clip["metadata"]["audio"][0]["codec"] == "aac"
        )
        # Decode actual rendered audio: both the source tone and music must remain audible.
        assert (
            clip["metadata"]["pixel_format"] == "yuv420p"
            and clip["metadata"]["telegram_compatible"]
        )
        assert clip["has_cover"] and clip["metadata"]["cover"]["mode"] == "auto"
        cover = client.get(f"/api/media/clip/{clip['id']}/cover")
        assert (
            cover.status_code == 200 and cover.headers["content-type"] == "image/jpeg"
        )
        assert cover.content.startswith(b"\xff\xd8")
        from app.media import cover_paths
        import json

        cover_files = cover_paths(
            s.one("SELECT * FROM clips WHERE id=?", (clip["id"],))
        )
        thumbnail = json.loads(
            subprocess.check_output(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_streams",
                    "-of",
                    "json",
                    str(cover_files[1]),
                ]
            )
        )["streams"][0]
        assert max(thumbnail["width"], thumbnail["height"]) <= 320
        assert cover_files[1].stat().st_size < 20 * 1024
        from array import array
        from math import cos, hypot, pi, sin

        clip_path = s.one("SELECT path FROM clips WHERE id=?", (clip["id"],))["path"]
        # Fast-start MP4 places its metadata before the media payload.
        from pathlib import Path

        data = Path(clip_path).read_bytes()
        assert data.find(b"moov") < data.find(b"mdat")
        pcm = subprocess.check_output(
            [
                "ffmpeg",
                "-v",
                "error",
                "-ss",
                "1",
                "-i",
                clip_path,
                "-t",
                "0.25",
                "-f",
                "s16le",
                "-ac",
                "1",
                "-ar",
                "16000",
                "pipe:1",
            ]
        )
        samples = array("h", pcm)

        def amplitude(freq):
            return hypot(
                sum(v * cos(2 * pi * freq * n / 16000) for n, v in enumerate(samples)),
                sum(v * sin(2 * pi * freq * n / 16000) for n, v in enumerate(samples)),
            ) / len(samples)

        assert amplitude(440) > 300 and amplitude(880) > 50
        assert (
            client.get(f"/api/media/clip/{clip['id']}?download=true")
            .headers["content-disposition"]
            .startswith("attachment")
        )
        assert client.get("/api/jobs").json()[0].get("payload") is None
        # Image watermark and fit mode exercise an independent filter graph.
        with (footage / "mark.png").open("rb") as f:
            image = client.post(
                f"/api/projects/{pid}/assets/watermark", files={"file": ("mark.png", f)}
            ).json()["asset_id"]
        edit["watermark"].update(kind="image", asset_id=image, start=0.5, end=2)
        edit["crop"]["mode"] = "fit"
        second = client.post(
            f"/api/projects/{pid}/render?preview=true", json=edit
        ).json()
        wait_job(client, second["job_id"])
        # Untrusted origins cannot invoke mutations even with a valid cookie.
        assert (
            client.post(
                "/api/settings/cleanup/previews",
                headers={"Origin": "https://evil.example"},
            ).status_code
            == 403
        )
        client.post("/api/logout")
        assert client.get(f"/api/media/clip/{clip['id']}").status_code == 401
        assert client.get(f"/api/media/clip/{clip['id']}/cover").status_code == 401


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/a",
        "http://10.1.2.3/a",
        "http://[::1]/a",
        "http://169.254.169.254/a",
        "file:///etc/passwd",
        "https://user:pass@example.com/a",
        "http://a.internal/a",
    ],
)
def test_private_urls_rejected(url):
    with pytest.raises(ValueError):
        validate_url(url)


def test_signed_url_preserved():
    url = "https://example.com/video.mkv?token=a%2Fb&expires=123&signature=xyz%2B1"
    assert validate_url(url) == url


def test_encrypted_settings():
    s.set_setting("test_secret", "do-not-expose-this")
    row = s.one("SELECT value FROM settings WHERE key='test_secret'")
    assert "do-not-expose-this" not in row["value"]
    assert s.setting("test_secret") == "do-not-expose-this"
