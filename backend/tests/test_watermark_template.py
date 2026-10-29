from app.media import make_watermark, watermark_windows
from app.models import (
    ProjectDefaults,
    Watermark,
    WatermarkTemplate,
    WatermarkText,
)


def test_builtin_defaults_use_the_viditor_template():
    defaults = ProjectDefaults()
    watermark = defaults.watermark
    assert watermark.kind == "text"
    assert watermark.template is not None
    template = watermark.template
    assert template.repeat is True
    assert template.decay_time == 2
    assert template.replication_count == 5
    assert template.gap_horizontal == 36
    assert template.gap_vertical == 36
    assert template.border_thickness == 0
    assert len(template.rows) == 1 and len(template.rows[0]) == 1
    element = template.rows[0][0]
    assert element.text == "TELEGRAM: @hl_clips"
    assert element.font_family == "Arial"
    assert element.font_size == 60
    assert element.bold is True
    assert element.color == "#ffffff"
    assert element.opacity == 0.2
    assert element.alignment == "left"

    subtitles = defaults.subtitles
    assert subtitles.font == "Arial"
    assert subtitles.size == 60
    assert subtitles.bold is True
    assert subtitles.color == "#ffffff"
    assert subtitles.outline_color == "#000000"
    assert subtitles.outline == 3.75
    assert subtitles.shadow == 0
    assert subtitles.margin == 90


def test_legacy_watermarks_keep_their_single_element_rendering():
    watermark = Watermark(kind="text", text="My channel", x=0.9, y=0.1)
    assert watermark.template is None
    assert watermark.text == "My channel"


def test_multi_element_template_lays_out_rows_and_repeats(tmp_path):
    watermark = Watermark(
        template=WatermarkTemplate(
            rows=[
                [
                    WatermarkText(text="Telegram:", alignment="right"),
                    WatermarkText(text="@channel"),
                ],
                [
                    WatermarkText(text="Instagram:", alignment="right"),
                    WatermarkText(text="@channel_ig"),
                ],
            ]
        )
    )
    template = watermark.template
    assert template is not None
    windows = watermark_windows(watermark, template, 10)
    assert len(windows) == 5
    assert windows[0][0] < windows[1][0]
    assert all(start < end for start, end in windows)

    card = make_watermark(watermark, 10, 1080, 1920, tmp_path)
    assert card is not None
    text = card.read_text()
    assert text.count("Dialogue:") == 20
    assert "\\an6" in text and "\\an4" in text
    assert "Telegram:" in text and "@channel_ig" in text
    assert "\\fnArial" in text and "\\b1" in text


def test_template_repeats_only_inside_the_visibility_window(tmp_path):
    watermark = Watermark(
        start=2,
        end=8,
        template=WatermarkTemplate(
            rows=[[WatermarkText(text="Mark")]],
            decay_time=2,
            replication_count=2,
        ),
    )
    template = watermark.template
    assert template is not None
    windows = watermark_windows(watermark, template, 12)
    assert windows == [(2.5, 4.5), (5.5, 7.5)]
    card = make_watermark(watermark, 12, 1080, 1920, tmp_path)
    assert card is not None
    text = card.read_text()
    assert "0:00:02.50,0:00:04.50" in text
    assert "0:00:05.50,0:00:07.50" in text
