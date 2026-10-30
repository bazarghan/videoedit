"""AI captions for Telegram posts, generated from a clip's subtitles."""

import html
import json
import re

import aiohttp

from . import store as s
from .autosubtitle import chat_endpoint
from .models import DEFAULT_CAPTION_PROMPT, Edit

CAPTION_MAX = 1024
SUBTITLE_BLOCK_MAX = 6000


def subtitle_excerpt(row, start, end):
    """Return the cue text that overlaps a clip's source-time range."""
    if not row:
        return ""
    try:
        cues = json.loads(row.get("cues") or "[]")
    except (TypeError, ValueError):
        return ""
    lines = []
    for cue in cues:
        try:
            cue_start, cue_end = float(cue["start"]), float(cue["end"])
            text = str(cue.get("text") or "").strip()
        except (KeyError, TypeError, ValueError):
            continue
        if not text or cue_end <= start or cue_start >= end:
            continue
        lines.append(text)
    return "\n".join(lines)


def clip_bounds(clip, project):
    """Resolve source-time bounds and subtitle tracks used by one render."""
    metadata = clip.get("metadata") if isinstance(clip, dict) else clip["metadata"]
    if isinstance(metadata, dict):
        info = metadata
    else:
        try:
            info = json.loads(metadata)
        except (TypeError, ValueError):
            info = {}
    edit = Edit.model_validate(json.loads(project["edit"]))
    context = info.get("caption_context") or {}
    start = context.get("start")
    end = context.get("end")
    start = edit.start if start is None else float(start)
    end = edit.end if end is None else float(end)
    if end <= start:
        start, end = 0.0, float(info.get("duration") or 0)
    return (
        info,
        max(0.0, start),
        end,
        context.get("track_id") or edit.subtitles.track_id,
        context.get("fa_track_id") or edit.subtitles.fa_track_id,
    )


def subtitle_blocks(project_id, start, end, main_id="", fa_id=""):
    """Return labelled subtitles from both available tracks."""
    blocks = []
    seen = set()
    for label, track_id in (("فارسی", fa_id), ("انگلیسی", main_id)):
        if not track_id or track_id in seen:
            continue
        seen.add(track_id)
        row = s.one(
            "SELECT * FROM subtitles WHERE id=? AND project_id=?",
            (track_id, project_id),
        )
        text = subtitle_excerpt(row, start, end)
        if not text:
            continue
        if len(text) > SUBTITLE_BLOCK_MAX:
            text = text[:SUBTITLE_BLOCK_MAX].rsplit("\n", 1)[0] or text[:SUBTITLE_BLOCK_MAX]
        blocks.append((label, text))
    return blocks


def clean_caption(value):
    """Strip model wrappers and escape the caption as Telegram HTML."""
    text = str(value or "").strip()
    if text.startswith("```"):
        newline = text.find("\n")
        text = text[newline + 1 :] if newline != -1 else ""
        if "```" in text:
            text = text.rsplit("```", 1)[0]
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    text = re.sub(r"\n{3,}", "\n\n", text)
    escaped = html.escape(text, quote=False)
    if len(escaped) > CAPTION_MAX:
        text = text[: CAPTION_MAX - 1]
        escaped = html.escape(text, quote=False)
        while len(escaped) > CAPTION_MAX - 1 and text:
            text = text[:-1]
            escaped = html.escape(text, quote=False)
        text = text.rstrip() + "…"
        escaped = html.escape(text, quote=False)
    return escaped


async def generate_caption(project, clip, config):
    api_key = (config.get("api_key") or "").strip()
    if not api_key:
        raise ValueError("Add your 9Router API token in Settings first.")
    _, start, end, main_id, fa_id = clip_bounds(clip, project)
    blocks = subtitle_blocks(project["id"], start, end, main_id, fa_id)
    if not blocks:
        raise ValueError(
            "This clip has no subtitles to write from. Create auto subtitles "
            "or upload an English or Persian subtitle track first."
        )
    user = [
        f"نام پروژه: {project['name']}",
        f"نام فایل: {clip['name']}",
        f"بازهٔ صحنه در منبع: {start:.2f} تا {end:.2f} ثانیه",
        "",
        "زیرنویس‌های این صحنه:",
    ]
    for label, text in blocks:
        user += ["", f"[{label}]", text]
    system_prompt = (
        config.get("caption_prompt") or DEFAULT_CAPTION_PROMPT
    ).strip() or DEFAULT_CAPTION_PROMPT
    payload = {
        "model": (config.get("model") or "").strip() or "kr/claude-sonnet-4.5",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": "\n".join(user)},
        ],
        "temperature": 0.4,
        "stream": False,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "x-api-key": api_key,
        "Content-Type": "application/json",
    }
    endpoint = chat_endpoint(config.get("base_url") or "http://localhost:20128/v1")
    try:
        async with aiohttp.ClientSession(trust_env=False) as session:
            async with session.post(
                endpoint,
                headers=headers,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=180, connect=20, sock_read=180),
            ) as response:
                raw = await response.text()
                if response.status >= 400:
                    detail = ""
                    try:
                        parsed = json.loads(raw)
                        detail = parsed.get("detail") or parsed.get("error") or ""
                        if isinstance(detail, dict):
                            detail = detail.get("message", "")
                    except (ValueError, AttributeError):
                        detail = raw.strip()
                    raise ValueError(
                        f"9Router caption request failed (HTTP {response.status}). "
                        f"{(str(detail) or 'Check the token and model in Settings.')[:500]}"
                    )
                try:
                    result = json.loads(raw)
                except ValueError:
                    raise ValueError("9Router returned an unreadable caption response.")
    except (aiohttp.ClientError, TimeoutError):
        raise ValueError(
            "The caption service could not be reached. Check the 9Router "
            "settings and retry."
        ) from None
    try:
        text = result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise ValueError("9Router returned an unexpected caption response.")
    if isinstance(text, list):
        text = "".join(
            part.get("text", "") if isinstance(part, dict) else str(part)
            for part in text
        )
    caption = clean_caption(text)
    if not caption:
        raise ValueError("9Router returned an empty caption. Try again or use another model.")
    return caption
