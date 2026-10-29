import json

from app.media import RTL_EMBED_END, RTL_EMBED_START, rtl_embed, subtitle_events
from app.models import Edit


def make_subs(fa, text):
    row = {"ass_path": None, "cues": json.dumps([{"start": 0, "end": 1, "text": text}])}
    return subtitle_events(row, Edit().subtitles, 0, 1, 640, 360, fa=fa)


def test_persian_events_get_an_rtl_embedding():
    subs = make_subs(True, "سلام، این یک تست است.")
    assert subs[0].text == f"{RTL_EMBED_START}سلام، این یک تست است.{RTL_EMBED_END}"


def test_english_events_stay_left_to_right():
    subs = make_subs(False, "Hello, world.")
    assert subs[0].text == "Hello, world."
    assert RTL_EMBED_START not in subs[0].text


def test_embedding_does_not_escape_cue_text():
    subs = make_subs(True, "خط اول\\Nخط {دوم}")
    assert subs[0].text == f"{RTL_EMBED_START}خط اول＼Nخط ｛دوم｝{RTL_EMBED_END}"


def test_rtl_embed_is_idempotent_for_plain_text():
    assert rtl_embed("متن") == f"{RTL_EMBED_START}متن{RTL_EMBED_END}"
