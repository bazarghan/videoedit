import json

from fastapi.testclient import TestClient

from app import caption
from app import store as s
from app.main import app
from app.models import Edit
from test_workflow import login


def test_subtitle_excerpt_filters_to_clip_range():
    row = {
        "cues": json.dumps(
            [
                {"start": 0, "end": 2, "text": "Before"},
                {"start": 2.5, "end": 4, "text": "Inside"},
                {"start": 5, "end": 7, "text": "After"},
            ]
        )
    }
    assert caption.subtitle_excerpt(row, 2, 4.5) == "Inside"


def test_clean_caption_escapes_html_and_caps_length():
    clean = caption.clean_caption("A & B <tag>")
    assert clean == "A &amp; B &lt;tag&gt;"
    long = caption.clean_caption("x" * 2000)
    assert len(long) <= caption.CAPTION_MAX
    assert long.endswith("…")


def test_caption_prompt_setting_round_trip_and_preserves_when_omitted():
    before = s.setting("ai", {})
    try:
        with TestClient(app) as client:
            login(client)
            saved = client.put(
                "/api/settings/ai",
                json={
                    "base_url": "http://localhost:20128/v1",
                    "model": "test-model",
                    "caption_prompt": "Custom caption prompt",
                },
            )
            assert saved.status_code == 200, saved.text
            assert saved.json()["caption_prompt"] == "Custom caption prompt"
            updated = client.put(
                "/api/settings/ai",
                json={
                    "base_url": "http://localhost:20128/v1",
                    "model": "test-model-2",
                },
            )
            assert updated.json()["caption_prompt"] == "Custom caption prompt"
    finally:
        s.set_setting("ai", before)


def test_caption_endpoint_uses_rendered_clip_context(monkeypatch):
    project_id, clip_id, track_id = s.uid(), s.uid(), s.uid()
    before = s.setting("ai", {})
    s.execute(
        "INSERT INTO projects(id,name,source,metadata,edit,status,created) VALUES (?,?,?,?,?,?,?)",
        (
            project_id,
            "Get Out",
            "",
            json.dumps({"duration": 10, "audio": [], "subtitles": []}),
            Edit(start=2, end=8).model_dump_json(),
            "ready",
            0,
        ),
    )
    s.execute(
        "INSERT INTO subtitles VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            track_id,
            project_id,
            "فارسی",
            "fa",
            "subrip",
            json.dumps(
                [
                    {"start": 0, "end": 2, "text": "بیرون"},
                    {"start": 3, "end": 5, "text": "هیپنوتیزم"},
                    {"start": 8, "end": 9, "text": "بعد"},
                ]
            ),
            None,
            1,
            "fa",
            "upload",
        ),
    )
    s.execute(
        "INSERT INTO clips VALUES (?,?,?,?,?,?,?)",
        (
            clip_id,
            project_id,
            "get-out.mp4",
            "",
            json.dumps(
                {
                    "duration": 5,
                    "caption_context": {
                        "start": 3,
                        "end": 7,
                        "track_id": "",
                        "fa_track_id": track_id,
                    },
                }
            ),
            0,
            0,
        ),
    )
    s.set_setting("ai", {"api_key": "router", "model": "test-model"})
    seen = {}

    async def fake_generate(project, clip, config):
        seen["project"] = project["name"]
        seen["clip"] = clip["id"]
        return "نام اثر:\nGet Out"

    monkeypatch.setattr(caption, "generate_caption", fake_generate)
    try:
        with TestClient(app) as client:
            login(client)
            response = client.post(f"/api/clips/{clip_id}/caption")
            assert response.status_code == 200, response.text
            assert response.json()["caption"].startswith("نام اثر")
            assert seen == {"project": "Get Out", "clip": clip_id}
            blocks = caption.subtitle_blocks(
                project_id, 3, 7, "", track_id
            )
            assert blocks == [("فارسی", "هیپنوتیزم")]
    finally:
        s.set_setting("ai", before)
        for table in ("jobs", "clips", "subtitles", "projects"):
            column = "id" if table == "projects" else "project_id"
            s.execute(f"DELETE FROM {table} WHERE {column}=?", (project_id,))
