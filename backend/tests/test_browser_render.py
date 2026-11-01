import asyncio
import base64
import json

import pytest
from fastapi.testclient import TestClient

from app import media, store as s
from app.main import app
from app.models import Edit
from test_workflow import ffmpeg, login


@pytest.fixture(scope="module")
def local_footage(tmp_path_factory):
    path = tmp_path_factory.mktemp("browser")
    source = path / "local.mp4"
    ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=24:duration=4",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=4",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        source,
    )
    thumbnail = path / "thumb.jpg"
    ffmpeg("-ss", "1", "-i", source, "-frames:v", "1", "-vf", "scale=320:-2", thumbnail)
    rendered = path / "rendered.mp4"
    ffmpeg(
        "-ss",
        "1",
        "-i",
        source,
        "-t",
        "2",
        "-vf",
        "scale=1920:1080",
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        rendered,
    )
    cover = path / "cover.jpg"
    ffmpeg("-ss", "2", "-i", source, "-frames:v", "1", "-vf", "scale=640:-2", cover)
    return {
        "source": source,
        "rendered": rendered,
        "thumbnail": "data:image/jpeg;base64,"
        + base64.b64encode(thumbnail.read_bytes()).decode(),
        "cover": "data:image/jpeg;base64,"
        + base64.b64encode(cover.read_bytes()).decode(),
    }


@pytest.fixture
def client():
    with TestClient(app) as client:
        login(client)
        yield client


def create_local(client, footage, name="Browser project"):
    metadata = asyncio.run(media.probe(footage["source"]))
    response = client.post(
        "/api/import/local",
        json={"name": name, "metadata": metadata, "thumbnail": footage["thumbnail"]},
    )
    assert response.status_code == 200, response.text
    ident = response.json()["project_id"]
    return ident, metadata


def test_local_import_stores_no_source(client, local_footage):
    ident, metadata = create_local(client, local_footage)
    project = client.get(f"/api/projects/{ident}").json()
    assert project["has_source"] is False
    assert project["has_thumbnail"] is True
    assert project["metadata"]["local"] is True
    assert project["metadata"]["duration"] == pytest.approx(metadata["duration"])
    assert project["edit"]["end"] == pytest.approx(metadata["duration"])
    thumbnail = client.get(f"/api/media/project/{ident}/thumbnail")
    assert thumbnail.status_code == 200
    assert thumbnail.headers["content-type"] == "image/jpeg"
    assert client.get(f"/api/media/project/{ident}/source").status_code == 404


def test_local_edit_and_server_render_guard(client, local_footage):
    ident, _ = create_local(client, local_footage)
    project = client.get(f"/api/projects/{ident}").json()
    edit = {**project["edit"], "start": 0.5, "end": 3.5}
    assert client.put(f"/api/projects/{ident}/edit", json=edit).status_code == 200
    blocked = client.post(f"/api/projects/{ident}/render", json=edit)
    assert blocked.status_code == 400
    assert "browser" in blocked.text


def test_browser_plan_matches_server_filters(client, local_footage):
    ident, _ = create_local(client, local_footage)
    project = client.get(f"/api/projects/{ident}").json()
    edit = {**project["edit"], "start": 0.5, "end": 3.5}
    response = client.post(f"/api/projects/{ident}/render-plan", json=edit)
    assert response.status_code == 200, response.text
    plan = response.json()
    assert plan["args"][0] != "ffmpeg"
    assert "{{INPUT}}" in plan["args"]
    assert plan["output"] == "/output.mp4"
    assert "-movflags" not in plan["args"]
    assert "/work/watermark.ass" in " ".join(plan["args"])
    assert "/fonts" in " ".join(plan["args"])
    assert plan["files"] and plan["files"][0]["path"].startswith("/work/")
    assert "Watermark" in plan["files"][0]["content"]

    # The browser argv must be the server argv with only the filesystem
    # locations swapped; this is what keeps exact cuts and effects identical.
    row = s.one("SELECT * FROM projects WHERE id=?", (ident,))
    body = Edit.model_validate(edit)
    server_paths = media.RenderPaths(
        "{{INPUT}}", "/output.mp4", s.DATA / "work" / s.uid()
    )
    server_paths.work.mkdir(parents=True, exist_ok=True)
    payload = {
        "edit": body.model_dump(),
        "preview": False,
        "subtitle_snapshot": None,
        "subtitle_snapshot_fa": None,
    }
    server_args = asyncio.run(
        media.build_render_args(
            row,
            payload,
            server_paths,
            plan["duration"],
            plan["width"],
            plan["height"],
            threads=1,
            faststart=False,
        )
    )
    assert server_args[0] == "ffmpeg"
    normalized = [
        arg.replace(str(server_paths.work), "/work").replace(
            str(media.FONT_DIR), "/fonts"
        )
        for arg in server_args[1:]
    ]
    assert normalized == plan["args"]
    for path in server_paths.work.iterdir():
        path.unlink()
    server_paths.work.rmdir()


def test_local_clean_cover_and_clip_upload(client, local_footage):
    ident, _ = create_local(client, local_footage)
    project = client.get(f"/api/projects/{ident}").json()
    edit = {**project["edit"], "start": 1, "end": 3}
    assert client.put(f"/api/projects/{ident}/edit", json=edit).status_code == 200
    cover = client.put(
        f"/api/projects/{ident}/cover-frame",
        json={
            "time": 2,
            "start": edit["start"],
            "end": edit["end"],
            "edit": edit,
            "image": local_footage["cover"],
        },
    )
    assert cover.status_code == 200, cover.text
    assert cover.json()["cover_frame"]["time"] == 2
    assert client.get(f"/api/media/project/{ident}/cover-frame").status_code == 200

    with local_footage["rendered"].open("rb") as video:
        uploaded = client.post(
            f"/api/projects/{ident}/clips",
            files={"file": ("clip.mp4", video, "video/mp4")},
            data={"edit": json.dumps(edit), "preview": "false"},
        )
    assert uploaded.status_code == 200, uploaded.text
    clip = uploaded.json()
    assert clip["preview"] is False
    assert clip["metadata"]["duration"] == pytest.approx(2, abs=0.1)
    assert clip["metadata"]["width"] == 1920
    assert clip["metadata"]["height"] == 1080
    assert clip["metadata"]["telegram_compatible"] is True
    assert clip["metadata"]["render_signature"]
    assert clip["metadata"]["cover"]["origin"] == "prerender"
    assert clip["metadata"]["cover"]["source_time"] == 2
    assert clip["has_cover"] is True

    refreshed = client.get(f"/api/projects/{ident}").json()
    assert refreshed["rendered"] is True


def test_local_cover_frame_requires_image(client, local_footage):
    ident, _ = create_local(client, local_footage)
    project = client.get(f"/api/projects/{ident}").json()
    edit = {**project["edit"], "start": 1, "end": 3}
    response = client.put(
        f"/api/projects/{ident}/cover-frame",
        json={"time": 2, "start": 1, "end": 3, "edit": edit},
    )
    assert response.status_code == 400
    assert "JPEG" in response.text


def test_local_autosubtitle_requires_credentials(client, local_footage):
    ident, _ = create_local(client, local_footage)
    project = client.get(f"/api/projects/{ident}").json()
    edit = {**project["edit"], "start": 0.5, "end": 2.5}
    response = client.post(
        f"/api/projects/{ident}/autosubtitle-local",
        files={"file": ("audio.mp3", b"not really audio", "audio/mpeg")},
        data={"edit": json.dumps(edit), "language": "en", "translate": "true"},
    )
    assert response.status_code == 400
    assert "ElevenLabs" in response.text


def test_browser_plan_includes_image_watermark_and_music(client, local_footage, tmp_path):
    ident, _ = create_local(client, local_footage)
    mark = tmp_path / "mark.png"
    ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "color=c=red@0.5:s=100x50,format=rgba",
        "-frames:v",
        "1",
        mark,
    )
    music = tmp_path / "music.wav"
    ffmpeg("-f", "lavfi", "-i", "sine=frequency=880:duration=3", music)
    watermark = client.post(
        f"/api/projects/{ident}/assets/watermark",
        files={"file": ("mark.png", mark.read_bytes(), "image/png")},
    ).json()
    track = client.post(
        f"/api/projects/{ident}/assets/music",
        files={"file": ("music.wav", music.read_bytes(), "audio/wav")},
    ).json()
    project = client.get(f"/api/projects/{ident}").json()
    edit = {
        **project["edit"],
        "start": 0.5,
        "end": 2.5,
        "watermark": {
            **project["edit"]["watermark"],
            "kind": "image",
            "asset_id": watermark["asset_id"],
        },
        "audio": {
            **project["edit"]["audio"],
            "music_id": track["asset_id"],
            "music_volume": 0.2,
        },
    }
    response = client.post(f"/api/projects/{ident}/render-plan", json=edit)
    assert response.status_code == 200, response.text
    plan = response.json()
    assets = {item["path"]: item["url"] for item in plan["assets"]}
    assert f"/assets/{watermark['asset_id']}.png" in assets
    assert f"/assets/{track['asset_id']}.wav" in assets
    assert assets[f"/assets/{watermark['asset_id']}.png"].endswith(
        f"/api/media/asset/{watermark['asset_id']}"
    )
    args = " ".join(plan["args"])
    assert f"/assets/{watermark['asset_id']}.png" in args
    assert f"/assets/{track['asset_id']}.wav" in args
    assert "amix=inputs=2" in args


def test_local_import_rejects_av1(client, local_footage):
    metadata = asyncio.run(media.probe(local_footage["source"]))
    metadata["video_codec"] = "av1"
    response = client.post(
        "/api/import/local",
        json={"name": "AV1", "metadata": metadata, "thumbnail": ""},
    )
    assert response.status_code == 400
    assert "AV1" in response.text
