import asyncio
import subprocess

import pytest
from fastapi.testclient import TestClient

from app.font_catalog import BUNDLED_FONTS, FONT_DIR, font_path
from app.main import app
from app.media import filter_path
from app.models import Edit


@pytest.mark.parametrize("family", ["Vazirmatn", "Shabnam", "Sahel"])
def test_persian_font_preview_and_render(family, tmp_path):
    path = BUNDLED_FONTS[family]
    assert asyncio.run(font_path(family)) == path
    with TestClient(app) as client:
        assert client.get(f"/api/fonts/{family.lower()}").status_code == 401
        login = client.post(
            "/api/login",
            json={"username": "admin", "password": "test-password-do-not-use"},
        )
        assert login.status_code == 200
        response = client.get(f"/api/fonts/{family.lower()}")
        assert response.status_code == 200
        assert response.headers["content-type"] == "font/ttf"
        assert response.content == path.read_bytes()
        assert client.get("/api/fonts/unknown").status_code == 404

    edit = Edit(subtitles={"font": family}, watermark={"font": family})
    assert edit.subtitles.font == edit.watermark.font == family
    captions = tmp_path / "captions.ass"
    captions.write_text(
        "[Script Info]\nPlayResX: 640\nPlayResY: 360\n"
        "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, "
        "SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, "
        "StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{family},36,&H00FFFFFF,&H00FFFFFF,&H00000000,"
        "&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,20,20,20,1\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, "
        "MarginV, Effect, Text\n"
        "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,سلام فارسی، گچ پژ\n"
    )
    watermark = tmp_path / "watermark.txt"
    watermark.write_text("متن فارسی ۱۲۳")
    result = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=s=640x360:d=1",
            "-vf",
            f"ass=filename='{filter_path(captions)}':fontsdir='{filter_path(FONT_DIR)}',"
            f"drawtext=fontfile='{filter_path(path)}':textfile='{filter_path(watermark)}':"
            "fontsize=30:fontcolor=white:x=20:y=20",
            "-frames:v",
            "1",
            str(tmp_path / "render.png"),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    selected = next(
        line for line in result.stderr.splitlines() if "fontselect:" in line
    )
    assert f"({family}," in selected and family in selected.split("->", 1)[1]
    assert "Glyph 0x" not in result.stderr
    assert (tmp_path / "render.png").stat().st_size > 1000
