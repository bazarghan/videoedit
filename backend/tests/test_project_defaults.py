import asyncio
import hashlib
import json
import time
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app import main, media, store as s
from app.models import ProjectDefaults
from app.project_defaults import get_defaults, remove_default_asset


@pytest.fixture
def client(monkeypatch):
    previous = get_defaults()
    projects_before = {row["id"] for row in s.rows("SELECT id FROM projects")}
    assets_before = {row["id"] for row in s.rows("SELECT id FROM assets")}
    s.set_setting("project_defaults", {})
    token = s.uid()
    digest = hashlib.sha256(token.encode()).hexdigest()
    s.execute("INSERT INTO sessions VALUES (?,?)", (digest, time.time() + 3600))
    monkeypatch.setattr(main, "validate_url", lambda url: url)
    client = TestClient(main.app)
    client.cookies.set("videoedit_session", token)
    try:
        yield client
    finally:
        for row in s.rows("SELECT id FROM projects"):
            if row["id"] not in projects_before:
                s.execute("DELETE FROM jobs WHERE project_id=?", (row["id"],))
                assert client.delete(f"/api/projects/{row['id']}").status_code == 200
        for row in s.rows("SELECT id FROM assets WHERE project_id IS NULL"):
            if row["id"] not in assets_before:
                remove_default_asset(row["id"])
        s.set_setting("project_defaults", previous.model_dump())
        s.execute("DELETE FROM sessions WHERE token=?", (digest,))
        client.close()


def preset():
    defaults = ProjectDefaults().model_dump()
    defaults["subtitles"].update(
        font="Vazirmatn",
        size=72,
        color="#ffff00",
        outline=4,
        shadow=2,
        box=True,
        box_opacity=0.6,
        position="top",
        align="right",
        margin=80,
        offset=1.5,
        burn=False,
        preserve_ass=True,
    )
    defaults["watermark"].update(
        kind="text",
        text="My channel",
        font="Shabnam",
        size=55,
        color="#ff0000",
        opacity=0.5,
        x=0.1,
        y=0.9,
        margin=35,
        start=2,
        end=8,
    )
    return defaults


def import_url(client):
    response = client.post(
        "/api/import/url", json={"url": "https://example.com/video.mp4"}
    )
    assert response.status_code == 200, response.text
    return response.json()["project_id"]


def test_defaults_require_authentication():
    with TestClient(main.app) as client:
        # Lifespan initializes authentication; no session is created for this client.
        for method in ("get", "put", "patch", "delete"):
            assert (
                getattr(client, method)("/api/settings/project-defaults").status_code
                == 401
            )
        assert (
            client.post("/api/settings/project-defaults/watermark").status_code == 401
        )


def test_persistent_defaults_snapshot_for_both_imports_and_ingest(client, monkeypatch):
    assert (
        client.get("/api/settings/project-defaults").json()
        == ProjectDefaults().model_dump()
    )
    defaults = preset()
    assert (
        client.put("/api/settings/project-defaults", json=defaults).json() == defaults
    )
    # The encrypted settings record survives new reads and new clients.
    raw = s.one("SELECT value FROM settings WHERE key='project_defaults'")["value"]
    assert "My channel" not in raw and s.decrypt(raw) == defaults
    first = import_url(client)
    response = client.post(
        "/api/import/upload",
        files={"file": ("source.webm", b"\x1aE\xdf\xa3video", "video/webm")},
    )
    assert response.status_code == 200, response.text
    second = response.json()["project_id"]
    changed = preset()
    changed["subtitles"]["size"] = 100
    changed["watermark"]["start"] = 4
    assert client.put("/api/settings/project-defaults", json=changed).status_code == 200

    monkeypatch.setattr(
        media,
        "probe",
        AsyncMock(
            return_value={
                "duration": 12.5,
                "video_codec": "vp9",
                "width": 640,
                "height": 360,
                "audio": [],
                "subtitles": [
                    {
                        "index": 1,
                        "title": "English",
                        "language": "eng",
                        "codec": "subrip",
                        "editable": True,
                    }
                ],
            }
        ),
    )
    monkeypatch.setattr(media, "run", AsyncMock())

    async def add_subtitle(project_id, *args):
        ident = s.uid()
        s.execute(
            "INSERT INTO subtitles VALUES (?,?,?,?,?,?,?,?)",
            (ident, project_id, "English", "eng", "subrip", "[]", None, 1),
        )
        return ident

    monkeypatch.setattr(media, "add_subtitle", add_subtitle)
    source = Path(s.one("SELECT source FROM projects WHERE id=?", (second,))["source"])
    for pid in (first, second):
        asyncio.run(media.ingest(pid, source, "no-job"))
        project = client.get(f"/api/projects/{pid}").json()
        edit = project["edit"]
        assert edit["start"] == 0 and edit["end"] == 12.5
        track_id = edit["subtitles"].pop("track_id")
        assert track_id == project["subtitles"][0]["id"]
        assert edit["subtitles"] == defaults["subtitles"]
        assert edit["watermark"] == defaults["watermark"]
    third = import_url(client)
    assert (
        client.get(f"/api/projects/{third}").json()["edit"]["subtitles"]["size"] == 100
    )
    assert (
        client.delete("/api/settings/project-defaults").json()
        == ProjectDefaults().model_dump()
    )
    assert (
        client.get(f"/api/projects/{third}").json()["edit"]["subtitles"]["size"] == 100
    )


def test_section_updates_and_invalid_defaults(client):
    defaults = preset()
    assert (
        client.put("/api/settings/project-defaults", json=defaults).status_code == 200
    )
    subtitles = {**defaults["subtitles"], "font": "Sahel", "size": 60}
    saved = client.patch(
        "/api/settings/project-defaults", json={"subtitles": subtitles}
    ).json()
    assert saved["subtitles"] == subtitles
    assert saved["watermark"] == defaults["watermark"]
    watermark = {**defaults["watermark"], "start": 3, "end": 6}
    saved = client.patch(
        "/api/settings/project-defaults", json={"watermark": watermark}
    ).json()
    assert saved["subtitles"] == subtitles and saved["watermark"] == watermark
    assert (
        client.patch(
            "/api/settings/project-defaults",
            json={"subtitles": {"track_id": "old-project"}},
        ).status_code
        == 422
    )
    assert (
        client.patch(
            "/api/settings/project-defaults", json={"subtitles": {"size": 999}}
        ).status_code
        == 422
    )
    assert (
        client.patch(
            "/api/settings/project-defaults", json={"watermark": {"start": 9, "end": 8}}
        ).status_code
        == 400
    )
    assert (
        client.patch(
            "/api/settings/project-defaults",
            json={"watermark": {"kind": "image", "asset_id": "missing"}},
        ).status_code
        == 400
    )
    assert (
        client.patch(
            "/api/settings/project-defaults", json={"watermark": {"kind": "image"}}
        ).status_code
        == 400
    )
    assert client.get("/api/settings/project-defaults").json() == saved


def test_image_defaults_survive_source_project_and_preset_deletion(client):
    original = import_url(client)
    asset_id = s.uid()
    path = s.DATA / "assets" / (asset_id + ".png")
    path.write_bytes(b"saved-watermark-image")
    s.execute(
        "INSERT INTO assets VALUES (?,?,?,?,?)",
        (asset_id, original, "watermark", str(path), "logo.png"),
    )
    defaults = preset()
    defaults["watermark"].update(kind="image", asset_id=asset_id, width=0.25)
    saved = client.put("/api/settings/project-defaults", json=defaults).json()
    saved_id = saved["watermark"]["asset_id"]
    assert saved_id != asset_id
    s.execute("DELETE FROM jobs WHERE project_id=?", (original,))
    assert client.delete(f"/api/projects/{original}").status_code == 200
    assert not path.exists()
    imported = import_url(client)
    project = client.get(f"/api/projects/{imported}").json()
    copied_id = project["edit"]["watermark"]["asset_id"]
    assert copied_id != saved_id and copied_id == project["assets"][0]["id"]
    copied = s.one("SELECT * FROM assets WHERE id=?", (copied_id,))
    assert copied["project_id"] == imported
    assert Path(copied["path"]).read_bytes() == b"saved-watermark-image"
    assert client.delete("/api/settings/project-defaults").status_code == 200
    assert s.one("SELECT * FROM assets WHERE id=?", (saved_id,)) is None
    assert Path(copied["path"]).read_bytes() == b"saved-watermark-image"


def test_upload_default_image_saves_style_and_cleans_replaced_images(
    client, monkeypatch
):
    monkeypatch.setattr(
        media, "probe", AsyncMock(return_value={"width": 100, "height": 50})
    )
    defaults = preset()
    defaults["watermark"]["kind"] = "image"
    for image in (b"\x89PNG\r\n\x1a\nfirst", b"\x89PNG\r\n\x1a\nsecond"):
        previous_id = get_defaults().watermark.asset_id
        response = client.post(
            "/api/settings/project-defaults/watermark",
            data={"defaults": json.dumps(defaults)},
            files={"file": ("logo.png", image, "image/png")},
        )
        assert response.status_code == 200, response.text
        saved = response.json()
        assert saved["subtitles"] == defaults["subtitles"]
        assert saved["watermark"]["start"] == 2
        asset = s.one(
            "SELECT * FROM assets WHERE id=?", (saved["watermark"]["asset_id"],)
        )
        assert asset["project_id"] is None and Path(asset["path"]).read_bytes() == image
        assert len(s.rows("SELECT * FROM assets WHERE project_id IS NULL")) == 1
        if previous_id:
            assert s.one("SELECT * FROM assets WHERE id=?", (previous_id,)) is None
    invalid = client.post(
        "/api/settings/project-defaults/watermark",
        data={"defaults": json.dumps(defaults)},
        files={"file": ("bad.png", b"not-an-image", "image/png")},
    )
    assert invalid.status_code == 400
    assert client.get("/api/settings/project-defaults").json() == saved
