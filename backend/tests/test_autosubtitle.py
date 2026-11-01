import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from app import autosubtitle
from app import store as s
from app.models import Edit


def test_max_duration_defaults_and_clamps():
    assert autosubtitle.max_duration_minutes({}) == 6
    assert autosubtitle.max_duration_minutes({"max_duration_minutes": 15}) == 15
    assert autosubtitle.max_duration_minutes({"max_duration_minutes": 0}) == 1
    assert autosubtitle.max_duration_minutes({"max_duration_minutes": "bad"}) == 6


def test_cues_from_words_groups_pauses_and_respects_sentences():
    words = [
        {"type": "word", "text": "Hello", "start": 0.0, "end": 0.3},
        {"type": "word", "text": "world.", "start": 0.35, "end": 0.8},
        {"type": "word", "text": "A", "start": 2.0, "end": 2.1},
        {"type": "word", "text": "new", "start": 2.15, "end": 2.4},
        {"type": "word", "text": "line", "start": 2.45, "end": 2.9},
    ]
    cues = autosubtitle.cues_from_words(words)
    assert [cue["text"] for cue in cues] == ["Hello world.", "A new line"]
    assert cues[0]["start"] == 0 and cues[0]["end"] <= cues[1]["start"]
    assert cues[1]["start"] >= 2.0


def test_transcript_fallback_uses_plain_text_when_words_are_missing():
    cues = autosubtitle.transcript_cues({"text": "Only text was returned"}, duration=8)
    assert len(cues) == 1 and cues[0]["text"] == "Only text was returned"
    assert cues[0]["end"] == 8


def test_parse_numbered_translation_accepts_common_model_formats():
    parsed = autosubtitle.parse_numbered("1. سلام\n2) دنیا\n3- خوبی؟", 3)
    assert parsed == ["سلام", "دنیا", "خوبی؟"]
    assert autosubtitle.parse_numbered("سلام\nدنیا", 2) == ["سلام", "دنیا"]
    assert autosubtitle.parse_numbered("1. only one", 2) is None


def test_run_writes_english_and_persian_tracks(monkeypatch, tmp_path):
    project_id = s.uid()
    source = tmp_path / "source.mp4"
    source.write_bytes(b"video")
    s.execute(
        "INSERT INTO projects(id,name,source,metadata,edit,status,created) VALUES (?,?,?,?,?,?,?)",
        (
            project_id,
            "Dual subtitles",
            str(source),
            json.dumps({"duration": 10}),
            Edit().model_dump_json(),
            "ready",
            0,
        ),
    )
    s.set_setting("elevenlabs", {"api_key": "eleven", "model": "scribe_v1"})
    s.set_setting("ai", {"api_key": "router", "model": "test-model"})
    job_id = s.uid()
    s.execute(
        "INSERT INTO jobs(id,kind,project_id,payload,status,created) VALUES (?,?,?,?,?,?)",
        (job_id, "autosubtitle", project_id, "{}", "running", 0),
    )
    monkeypatch.setattr(autosubtitle.media, "run", AsyncMock())
    monkeypatch.setattr(
        autosubtitle,
        "transcribe_audio",
        AsyncMock(
            return_value={
                "words": [
                    {"type": "word", "text": "Hello.", "start": 0.0, "end": 0.8},
                    {"type": "word", "text": "Again.", "start": 1.2, "end": 2.0},
                ]
            }
        ),
    )
    monkeypatch.setattr(
        autosubtitle,
        "translate_cues",
        AsyncMock(
            return_value=[
                {"start": 0.0, "end": 0.8, "text": "سلام."},
                {"start": 1.2, "end": 2.0, "text": "دوباره."},
            ]
        ),
    )
    result = asyncio.run(
        autosubtitle.run(
            s.one("SELECT * FROM projects WHERE id=?", (project_id,)),
            {"language": "en", "translate": True},
            job_id,
        )
    )
    assert result["cues"] == 2
    tracks = s.rows(
        "SELECT * FROM subtitles WHERE project_id=? AND origin='auto' ORDER BY role",
        (project_id,),
    )
    assert {track["role"] for track in tracks} == {"main", "fa"}
    edit = Edit.model_validate(
        json.loads(s.one("SELECT edit FROM projects WHERE id=?", (project_id,))["edit"])
    )
    assert edit.subtitles.track_id == result["track_id"]
    assert edit.subtitles.fa_track_id == result["fa_track_id"]
    assert edit.subtitles.burn is True and edit.subtitles.soft is False
    s.execute("DELETE FROM subtitles WHERE project_id=?", (project_id,))
    s.execute("DELETE FROM projects WHERE id=?", (project_id,))
    s.execute("DELETE FROM jobs WHERE id=?", (job_id,))
    s.set_setting("elevenlabs", {})
    s.set_setting("ai", {})


def test_run_rejects_video_over_duration_limit_without_spending_tokens(
    monkeypatch, tmp_path
):
    project_id = s.uid()
    source = tmp_path / "long.mp4"
    source.write_bytes(b"video")
    s.execute(
        "INSERT INTO projects(id,name,source,metadata,edit,status,created) VALUES (?,?,?,?,?,?,?)",
        (
            project_id,
            "Too long",
            str(source),
            json.dumps({"duration": 400}),
            Edit().model_dump_json(),
            "ready",
            0,
        ),
    )
    s.set_setting(
        "elevenlabs",
        {"api_key": "eleven", "max_duration_minutes": 6},
    )
    s.set_setting("ai", {"api_key": "router"})
    failed = AsyncMock()
    monkeypatch.setattr(autosubtitle.media, "run", failed)
    job_id = s.uid()
    s.execute(
        "INSERT INTO jobs(id,kind,project_id,payload,status,created) VALUES (?,?,?,?,?,?)",
        (job_id, "autosubtitle", project_id, "{}", "running", 0),
    )
    with pytest.raises(ValueError, match="limited to 6 minutes"):
        asyncio.run(
            autosubtitle.run(
                s.one("SELECT * FROM projects WHERE id=?", (project_id,)),
                {"language": "en", "translate": True},
                job_id,
            )
        )
    failed.assert_not_called()
    s.execute("DELETE FROM projects WHERE id=?", (project_id,))
    s.execute("DELETE FROM jobs WHERE id=?", (job_id,))
    s.set_setting("elevenlabs", {})
    s.set_setting("ai", {})


def test_dual_subtitle_layout_places_english_above_persian(tmp_path):
    from app import media

    project_id = s.uid()
    s.execute(
        "INSERT INTO projects(id,name,source,metadata,edit,status,created) VALUES (?,?,?,?,?,?,?)",
        (
            project_id,
            "Layout",
            "",
            json.dumps({"duration": 10}),
            Edit().model_dump_json(),
            "ready",
            0,
        ),
    )
    for ident, role, text in (("main-layout", "main", "Hello"), ("fa-layout", "fa", "سلام")):
        s.execute(
            "INSERT INTO subtitles VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                ident,
                project_id,
                role,
                "en" if role == "main" else "fa",
                "subrip",
                json.dumps([{"start": 1, "end": 3, "text": text}]),
                None,
                1,
                role,
                "auto",
            ),
        )
    edit = Edit()
    edit.subtitles.track_id = "main-layout"
    edit.subtitles.fa_track_id = "fa-layout"
    path = media.make_subs(project_id, edit, 0, 10, 1920, 1080, Path(tmp_path))
    import pysubs2

    subs = pysubs2.load(str(path))
    assert [event.style for event in subs] == ["FaStyle", "MainStyle"]
    assert subs.styles["MainStyle"].fontname == "Arial"
    assert subs.styles["FaStyle"].fontname == "IRANYekanWeb ExtraBold"
    assert subs.styles["MainStyle"].primarycolor.r == 255
    assert subs.styles["MainStyle"].primarycolor.b == 255
    assert subs.styles["FaStyle"].primarycolor.r == 255
    assert subs.styles["FaStyle"].primarycolor.g == 255
    assert subs[0].text == f"{media.RTL_EMBED_START}سلام{media.RTL_EMBED_END}"
    assert "\\N" in subs[1].text and "Hello" in subs[1].text
    assert media.RTL_EMBED_START not in subs[1].text
    s.execute("DELETE FROM subtitles WHERE project_id=?", (project_id,))
    s.execute("DELETE FROM projects WHERE id=?", (project_id,))


def test_run_uses_uploaded_clip_audio_and_shifts_cues(monkeypatch, tmp_path):
    project_id = s.uid()
    s.execute(
        "INSERT INTO projects(id,name,source,metadata,edit,status,created) VALUES (?,?,?,?,?,?,?)",
        (
            project_id,
            "Browser subtitles",
            None,
            json.dumps({"duration": 20}),
            Edit().model_dump_json(),
            "ready",
            0,
        ),
    )
    s.set_setting("elevenlabs", {"api_key": "eleven", "model": "scribe_v1"})
    s.set_setting("ai", {"api_key": "router", "model": "test-model"})
    audio = tmp_path / "clip.mp3"
    audio.write_bytes(b"audio")
    job_id = s.uid()
    s.execute(
        "INSERT INTO jobs(id,kind,project_id,payload,status,created) VALUES (?,?,?,?,?,?)",
        (job_id, "autosubtitle", project_id, "{}", "running", 0),
    )
    extract = AsyncMock(side_effect=AssertionError("must not re-extract audio"))
    monkeypatch.setattr(autosubtitle.media, "run", extract)
    monkeypatch.setattr(
        autosubtitle,
        "transcribe_audio",
        AsyncMock(
            return_value={
                "words": [
                    {"type": "word", "text": "Clip", "start": 0.0, "end": 0.6},
                    {"type": "word", "text": "only.", "start": 0.8, "end": 1.4},
                ]
            }
        ),
    )
    monkeypatch.setattr(
        autosubtitle,
        "translate_cues",
        AsyncMock(return_value=[{"start": 0.0, "end": 1.4, "text": "فقط کلیپ."}]),
    )
    result = asyncio.run(
        autosubtitle.run(
            s.one("SELECT * FROM projects WHERE id=?", (project_id,)),
            {
                "language": "en",
                "translate": True,
                "audio_path": str(audio),
                "offset": 10.5,
                "duration": 20,
            },
            job_id,
        )
    )
    assert result["cues"] == 1
    assert not audio.exists()
    extract.assert_not_awaited()
    track = s.one(
        "SELECT * FROM subtitles WHERE project_id=? AND role='fa'", (project_id,)
    )
    cues = json.loads(track["cues"])
    assert cues[0]["start"] == pytest.approx(10.5)
    assert cues[0]["end"] == pytest.approx(11.9)
    s.execute("DELETE FROM subtitles WHERE project_id=?", (project_id,))
    s.execute("DELETE FROM projects WHERE id=?", (project_id,))
    s.execute("DELETE FROM jobs WHERE id=?", (job_id,))
    s.set_setting("elevenlabs", {})
