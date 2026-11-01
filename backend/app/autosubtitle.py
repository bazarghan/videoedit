"""Automatic English transcription and Persian translation for subtitles.

ElevenLabs Scribe produces word-level English timing. The text is grouped into
readable cues, translated through the OpenAI-compatible 9Router endpoint, and
stored as two editable tracks in the same layout as Viditor: English above,
Persian below in yellow.
"""

import json
import re
import shutil
from pathlib import Path

import aiohttp
import pysubs2

from . import media
from . import store as s
from .models import (
    AUTO_SUBTITLE_DEFAULT_MINUTES,
    AUTO_SUBTITLE_MAX_MINUTES,
    Edit,
)

ELEVENLABS_URL = "https://api.elevenlabs.io/v1/speech-to-text"
MAX_CUE_SECONDS = 6.0
MAX_CUE_CHARS = 90
SENTENCE_END = re.compile(r"[.!?…。！？]$")
NUMBERED_LINE = re.compile(r"^\s*\[?(\d{1,4})\]?[\s.:：)\-–—]+(.+?)\s*$")


def max_duration_minutes(config):
    """Return the saved auto-subtitle duration cap in whole minutes."""
    try:
        value = int(
            (config or {}).get(
                "max_duration_minutes", AUTO_SUBTITLE_DEFAULT_MINUTES
            )
        )
    except (TypeError, ValueError):
        value = AUTO_SUBTITLE_DEFAULT_MINUTES
    return max(1, min(AUTO_SUBTITLE_MAX_MINUTES, value))


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def cues_from_words(words, duration=0.0):
    """Group ElevenLabs word timestamps into readable subtitle cues."""
    clean = []
    for word in words or []:
        if word.get("type", "word") != "word":
            continue
        text = (word.get("text") or "").strip()
        start, end = _number(word.get("start")), _number(word.get("end"))
        if not text or start is None or end is None or end < start:
            continue
        clean.append({"text": text, "start": max(0.0, start), "end": max(0.0, end)})
    clean.sort(key=lambda item: (item["start"], item["end"]))
    cues = []
    current = []

    def flush():
        if not current:
            return
        text = " ".join(item["text"] for item in current).strip()
        start = current[0]["start"]
        end = max(current[-1]["end"] + 0.12, start + 0.4)
        cues.append({"start": start, "end": end, "text": text})
        current.clear()

    for word in clean:
        if current:
            previous = current[-1]
            elapsed = word["start"] - current[0]["start"]
            gap = word["start"] - previous["end"]
            length = len(" ".join(item["text"] for item in current))
            if (
                gap >= 0.8
                or elapsed >= MAX_CUE_SECONDS
                or length >= MAX_CUE_CHARS
                or SENTENCE_END.search(previous["text"])
            ):
                flush()
        current.append(word)
    flush()
    for index, cue in enumerate(cues):
        if index + 1 < len(cues):
            cue["end"] = min(cue["end"], cues[index + 1]["start"])
        cue["start"] = round(cue["start"], 3)
        cue["end"] = round(max(cue["start"] + 0.05, cue["end"]), 3)
        cue["text"] = re.sub(r"\s+", " ", cue["text"]).strip()
    return [cue for cue in cues if cue["text"] and cue["end"] > cue["start"]]


def transcript_cues(payload, duration=0.0):
    cues = cues_from_words(payload.get("words"), duration)
    if cues:
        return cues
    text = re.sub(r"\s+", " ", (payload.get("text") or "")).strip()
    if not text:
        raise ValueError(
            "ElevenLabs returned no speech. Check that the video has an audible voice track."
        )
    # Last-resort fallback when the API omitted word timings.
    end = duration or max(3.0, len(text) / 12)
    return [{"start": 0.0, "end": round(end, 3), "text": text}]


def split_batches(cues, max_chars=2600, max_items=28):
    batches, current, size = [], [], 0
    for cue in cues:
        length = len(cue["text"]) + 8
        if current and (len(current) >= max_items or size + length > max_chars):
            batches.append(current)
            current, size = [], 0
        current.append(cue)
        size += length
    if current:
        batches.append(current)
    return batches


def parse_numbered(text, count):
    """Parse a numbered translation response, accepting common model formats."""
    found = {}
    for line in (text or "").splitlines():
        match = NUMBERED_LINE.match(line)
        if not match:
            continue
        index = int(match.group(1)) - 1
        translation = match.group(2).strip().strip('"“”')
        if 0 <= index < count and index not in found and translation:
            found[index] = translation
    if len(found) == count:
        return [found[index] for index in range(count)]
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    if len(lines) == count and not found:
        return [line.strip('"“”') for line in lines]
    return None


def chat_endpoint(base_url):
    from urllib.parse import urlparse

    base = (base_url or "").rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    if urlparse(base).path in ("", "/"):
        base += "/v1"
    return base + "/chat/completions"


async def _post_json(session, url, headers, body, timeout=180):
    async with session.post(
        url,
        headers=headers,
        json=body,
        timeout=aiohttp.ClientTimeout(total=timeout, connect=20, sock_read=timeout),
    ) as response:
        raw = await response.text()
        if response.status >= 400:
            detail = ""
            try:
                detail = json.loads(raw).get("detail") or json.loads(raw).get("error")
            except (ValueError, AttributeError):
                detail = raw.strip()
            if isinstance(detail, dict):
                detail = detail.get("message", "")
            raise ValueError(
                f"9Router translation failed (HTTP {response.status}). "
                f"{(str(detail) or 'Check the token and model in Settings.')[:500]}"
            )
        try:
            return json.loads(raw)
        except ValueError:
            raise ValueError("9Router returned an unreadable response.") from None


async def translate_cues(cues, config, ident=None):
    api_key = (config.get("api_key") or "").strip()
    if not api_key:
        raise ValueError("Add your 9Router API token in Settings first.")
    model = (config.get("model") or "").strip() or "kr/claude-sonnet-4.5"
    endpoint = chat_endpoint(config.get("base_url") or "http://localhost:20128/v1")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "x-api-key": api_key,
        "Content-Type": "application/json",
    }
    batches = split_batches(cues)
    translated = []
    for batch_index, batch in enumerate(batches):
        if ident and media.cancelled(ident):
            raise media.Cancelled()
        numbered = "\n".join(
            f"{index + 1}. {cue['text']}" for index, cue in enumerate(batch)
        )
        messages = [
            {
                "role": "system",
                "content": (
                    "You translate English subtitles into natural, conversational "
                    "Persian (Farsi). Translate meaning, not word-for-word. Keep "
                    "names, numbers and technical terms accurate. Each numbered "
                    "line is one subtitle cue. Return exactly one numbered line per "
                    "input, using the same numbers. Never merge, split, omit or "
                    "explain lines. Return only the numbered translations."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Translate these subtitle cues to Persian. Preserve the line "
                    "count and numbering exactly:\n\n" + numbered
                ),
            },
        ]
        body = {
            "model": model,
            "messages": messages,
            "temperature": 0.2,
            "stream": False,
        }
        async with aiohttp.ClientSession(trust_env=False) as session:
            result = await _post_json(session, endpoint, headers, body)
        try:
            text = result["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise ValueError("9Router returned an unexpected translation response.")
        if isinstance(text, list):
            text = "".join(
                part.get("text", "") if isinstance(part, dict) else str(part)
                for part in text
            )
        parsed = parse_numbered(text, len(batch))
        if parsed is None:
            # One retry with a stricter instruction is cheaper than a failed job
            # after a long transcription, and smaller batches avoid truncation.
            retry_messages = [
                {
                    "role": "system",
                    "content": (
                        "Return only numbered Persian subtitle lines. The number of "
                        "lines must match the input exactly."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Translate to Persian. Return exactly {len(batch)} lines, "
                        f"numbered 1 to {len(batch)}:\n\n{numbered}"
                    ),
                },
            ]
            async with aiohttp.ClientSession(trust_env=False) as session:
                result = await _post_json(
                    session,
                    endpoint,
                    headers,
                    {**body, "messages": retry_messages, "temperature": 0},
                )
            try:
                text = result["choices"][0]["message"]["content"]
            except (KeyError, IndexError, TypeError):
                raise ValueError("9Router returned an unexpected translation response.")
            if isinstance(text, list):
                text = "".join(
                    part.get("text", "") if isinstance(part, dict) else str(part)
                    for part in text
                )
            parsed = parse_numbered(text, len(batch))
        if parsed is None:
            raise ValueError(
                "The AI model did not return one Persian line per subtitle cue. "
                "Try a stronger model in Settings."
            )
        translated.extend(
            {"start": cue["start"], "end": cue["end"], "text": text}
            for cue, text in zip(batch, parsed)
        )
        if ident:
            progress = 35 + 55 * (batch_index + 1) / max(1, len(batches))
            s.update_job(ident, progress=progress)
    return translated


async def transcribe_audio(audio_path, config, language, ident=None):
    api_key = (config.get("api_key") or "").strip()
    model = (config.get("model") or "").strip() or "scribe_v2"
    headers = {"xi-api-key": api_key}
    form = aiohttp.FormData()
    form.add_field("model_id", model)
    form.add_field("timestamps_granularity", "word")
    if language and language.lower() not in ("auto", "detect"):
        form.add_field("language_code", language.lower())
    file = audio_path.open("rb")
    form.add_field("file", file, filename="audio.mp3", content_type="audio/mpeg")
    timeout = aiohttp.ClientTimeout(total=None, connect=30, sock_read=600)
    try:
        async with aiohttp.ClientSession(
            timeout=timeout, trust_env=False
        ) as session:
            async with session.post(
                ELEVENLABS_URL, headers=headers, data=form
            ) as response:
                raw = await response.text()
                if response.status >= 400:
                    if response.status == 401:
                        message = "ElevenLabs rejected the API token. Check it in Settings."
                    elif response.status == 429:
                        message = "ElevenLabs rate limit reached. Wait and retry."
                    else:
                        detail = ""
                        try:
                            payload = json.loads(raw)
                            detail = payload.get("detail") or payload.get("message") or ""
                            if isinstance(detail, dict):
                                detail = detail.get("message", "")
                        except ValueError:
                            detail = raw.strip()
                        message = f"ElevenLabs transcription failed (HTTP {response.status}). {str(detail)[:500]}"
                    raise ValueError(message)
                try:
                    return json.loads(raw)
                except ValueError:
                    raise ValueError("ElevenLabs returned an unreadable response.") from None
    finally:
        file.close()


def _write_track(work, cues, name):
    subs = pysubs2.SSAFile()
    for cue in cues:
        subs.events.append(
            pysubs2.SSAEvent(
                start=round(cue["start"] * 1000),
                end=round(cue["end"] * 1000),
                text=cue["text"],
            )
        )
    path = work / name
    subs.save(str(path))
    return path


async def run(project, payload, ident):
    source = project.get("source")
    uploaded_audio = payload.get("audio_path")
    if uploaded_audio:
        if not Path(uploaded_audio).exists():
            raise ValueError("The uploaded audio for transcription is missing.")
    elif not source or not Path(source).exists():
        raise ValueError("The original video is not available for transcription.")
    elevenlabs = s.setting("elevenlabs", {})
    if not (elevenlabs.get("api_key") or "").strip():
        raise ValueError("Add your ElevenLabs API token in Settings first.")
    ai = s.setting("ai", {})
    translate = bool(payload.get("translate", True))
    if translate and not (ai.get("api_key") or "").strip():
        raise ValueError("Add your 9Router API token in Settings first.")

    meta = json.loads(project["metadata"])
    duration = float(payload.get("duration") or meta.get("duration") or 0)
    offset = float(payload.get("offset") or 0)
    limit = max_duration_minutes(elevenlabs)
    if duration > limit * 60 + 0.5:
        raise ValueError(
            f"This clip is {duration / 60:.1f} minutes long. Automatic "
            f"subtitles are limited to {limit} minutes; raise the limit in "
            "Settings → Auto subtitles or import a shorter video."
        )
    work = s.DATA / "work" / (ident + "-autosubtitle")
    work.mkdir(parents=True, exist_ok=True)
    try:
        if uploaded_audio:
            audio = Path(uploaded_audio)
        else:
            audio = work / "audio.mp3"
            await media.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-v",
                    "error",
                    "-y",
                    "-i",
                    str(source),
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "libmp3lame",
                    "-b:a",
                    "64k",
                    str(audio),
                ],
                ident,
            )
        s.update_job(ident, progress=12)
        transcript = await transcribe_audio(
            audio, elevenlabs, payload.get("language", "en"), ident
        )
        if ident and media.cancelled(ident):
            raise media.Cancelled()
        english = transcript_cues(transcript, duration)
        s.update_job(ident, progress=35)
        persian = await translate_cues(english, ai, ident) if translate else []
        if ident and media.cancelled(ident):
            raise media.Cancelled()
        if offset:
            # The browser only uploads the selected clip's audio. Shift the
            # cues back into source time so subtitle trimming keeps working.
            for cue in english:
                cue["start"] += offset
                cue["end"] += offset
            for cue in persian:
                cue["start"] += offset
                cue["end"] += offset

        main_path = _write_track(work, english, "english.srt")
        fa_path = _write_track(work, persian, "persian.srt") if persian else None
        # Replace only this pipeline's previous output, never uploaded or
        # embedded tracks.
        s.execute(
            "DELETE FROM subtitles WHERE project_id=? AND origin='auto'",
            (project["id"],),
        )
        main_id = await media.add_subtitle(
            project["id"],
            main_path,
            "English (auto)",
            payload.get("language", "en"),
            "subrip",
            role="main",
            origin="auto",
        )
        fa_id = ""
        if fa_path:
            fa_id = await media.add_subtitle(
                project["id"],
                fa_path,
                "فارسی (خودکار)",
                "fa",
                "subrip",
                role="fa",
                origin="auto",
            )
        row = s.one("SELECT edit FROM projects WHERE id=?", (project["id"],))
        edit = Edit.model_validate(json.loads(row["edit"]))
        edit.subtitles.track_id = main_id
        edit.subtitles.fa_track_id = fa_id
        edit.subtitles.burn = True
        edit.subtitles.soft = False
        s.execute(
            "UPDATE projects SET edit=? WHERE id=?",
            (edit.model_dump_json(), project["id"]),
        )
        return {
            "track_id": main_id,
            "fa_track_id": fa_id,
            "cues": len(english),
        }
    finally:
        if uploaded_audio:
            Path(uploaded_audio).unlink(missing_ok=True)
        shutil.rmtree(work, ignore_errors=True)
