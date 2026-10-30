import asyncio
import json
import re
import time
from pathlib import Path
from fractions import Fraction

import pysubs2

from . import store as s
from .font_catalog import FONT_DIR, font_path
from .models import Edit

TEXT_SUBS = {"subrip", "ass", "ssa", "mov_text", "webvtt", "text"}


class Cancelled(Exception):
    pass


def cancelled(ident):
    row = s.one("SELECT status FROM jobs WHERE id=?", (ident,))
    return not row or row["status"] == "cancelled"


async def run(args, ident=None, duration=0):
    # Media operations never need network protocols or executable input helpers.
    if args[0] == "ffmpeg":
        args = [args[0], "-protocol_whitelist", "file,pipe", *args[1:]]
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    errors = bytearray()

    async def drain():
        while chunk := await proc.stderr.read(4096):
            errors.extend(chunk)
            if len(errors) > 16000:
                del errors[:-16000]

    err_task = asyncio.create_task(drain())

    async def read_progress():
        while line := await proc.stdout.readline():
            if ident and duration and line.startswith(b"out_time_us="):
                try:
                    elapsed = int(line.split(b"=")[1]) / 1e6
                    s.update_job(ident, progress=min(99, elapsed / duration * 100))
                except ValueError:
                    pass

    stdout_task = asyncio.create_task(read_progress())
    last_space_check = time.monotonic()
    try:
        while proc.returncode is None:
            if ident and cancelled(ident):
                raise Cancelled()
            if ident and time.monotonic() - last_space_check >= 1:
                s.space_for()
                last_space_check = time.monotonic()
            try:
                await asyncio.wait_for(proc.wait(), 0.3)
            except asyncio.TimeoutError:
                continue
        await stdout_task
        await err_task
        if proc.returncode:
            # Commands use only managed local files; never include network URLs in diagnostics.
            message = errors.decode(errors="replace")[-1500:]
            message = message.replace(str(s.DATA), "[media]")
            raise ValueError("Media processing failed: " + message)
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        await asyncio.gather(err_task, stdout_task, return_exceptions=True)


async def probe(path):
    proc = await asyncio.create_subprocess_exec(
        "ffprobe",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), 60)
    except BaseException:
        proc.kill()
        await proc.wait()
        raise
    if proc.returncode:
        raise ValueError("This file could not be read as valid media.")
    data = json.loads(out)
    streams = data.get("streams", [])
    video = next(
        (
            st
            for st in streams
            if st["codec_type"] == "video"
            and not st.get("disposition", {}).get("attached_pic")
        ),
        None,
    )
    audio = [st for st in streams if st["codec_type"] == "audio"]

    def track(st):
        return {
            "index": st["index"],
            "codec": st.get("codec_name", "unknown"),
            "language": st.get("tags", {}).get("language", ""),
            "title": st.get("tags", {}).get("title", ""),
        }

    width, height = (video.get("width", 0), video.get("height", 0)) if video else (0, 0)
    rotation = (
        next(
            (
                item.get("rotation", 0)
                for item in video.get("side_data_list", [])
                if "rotation" in item
            ),
            0,
        )
        if video
        else 0
    )
    if round(abs(float(rotation))) % 180 == 90:
        width, height = height, width
    with Path(path).open("rb") as source:
        header = source.read(256)
    formats = data.get("format", {}).get("format_name", "").split(",")
    brand = data.get("format", {}).get("tags", {}).get("major_brand", "")
    container = (
        "mp4"
        if "mp4" in formats and brand.strip() != "qt"
        else "webm"
        if header.startswith(b"\x1aE\xdf\xa3") and b"\x42\x82\x84webm" in header
        else None
    )
    return {
        "duration": float(data.get("format", {}).get("duration", 0)),
        "size": Path(path).stat().st_size,
        "width": width,
        "height": height,
        "video_codec": video.get("codec_name") if video else None,
        "pixel_format": video.get("pix_fmt") if video else None,
        "browser_container": container,
        "video_codec_tag": video.get("codec_tag_string") if video else None,
        "video_duration": float(
            (video or {}).get("duration") or data.get("format", {}).get("duration", 0)
        ),
        "fps": float(Fraction((video or {}).get("avg_frame_rate") or "0/1"))
        if (video or {}).get("avg_frame_rate") != "0/0"
        else 0,
        "format": data.get("format", {}).get("format_name", ""),
        "audio": [track(st) for st in audio],
        "subtitles": [
            {**track(st), "editable": st.get("codec_name") in TEXT_SUBS}
            for st in streams
            if st["codec_type"] == "subtitle"
        ],
    }


def original_media_type(info):
    if info.get("browser_container") == "webm":
        return "video/webm"
    if "mp4" in info.get("format", "").split(","):
        return "video/mp4"
    return "video/x-matroska"


def telegram_compatible(info):
    return (
        info.get("video_codec") == "h264"
        and info.get("pixel_format") == "yuv420p"
        and "mp4" in info.get("format", "").split(",")
        and all(track["codec"] == "aac" for track in info.get("audio", []))
        and info.get("width", 0) > 0
        and info.get("height", 0) > 0
        and not info["width"] % 2
        and not info["height"] % 2
    )


def cover_paths(clip):
    info = (
        json.loads(clip["metadata"])
        if isinstance(clip["metadata"], str)
        else clip["metadata"]
    )
    revision = info.get("cover", {}).get("revision", "")
    if not re.fullmatch(r"[0-9a-f]{32}", revision):
        return ()
    return tuple(
        s.DATA / "renders" / f"{clip['id']}-{revision}-{kind}.jpg"
        for kind in ("cover", "thumb")
    )


def frame_filter(edit, info):
    """Crop/pad a source frame exactly like the rendered output."""
    w, h = dimensions(info, edit)
    crop = edit.crop
    if crop.mode == "fill":
        vf = (
            f"scale={w}:{h}:force_original_aspect_ratio=increase,"
            f"crop={w}:{h}:(iw-ow)*{crop.x}:(ih-oh)*{crop.y},setsar=1"
        )
    else:
        vf = (
            f"scale={w}:{h}:force_original_aspect_ratio=decrease:"
            f"force_divisible_by=2,"
            f"pad={w}:{h}:(ow-iw)*{crop.x}:(oh-ih)*{crop.y}:black,setsar=1"
        )
    return w, h, vf


async def _write_cover_files(clip_id, revision, input_path, position, vf_prefix, ident):
    paths = tuple(
        s.DATA / "renders" / f"{clip_id}-{revision}-{kind}.jpg"
        for kind in ("cover", "thumb")
    )
    prefix = f"{vf_prefix}," if vf_prefix else ""
    s.space_for(2 * 1024**2)
    try:
        for path, edge in zip(paths, (1280, 320)):
            for quality in (6, 12, 20, 31):
                await run(
                    [
                        "ffmpeg",
                        "-v",
                        "error",
                        "-y",
                        "-ss",
                        str(position),
                        "-i",
                        str(input_path),
                        "-frames:v",
                        "1",
                        "-vf",
                        f"{prefix}scale='min({edge},iw)':'min({edge},ih)':force_original_aspect_ratio=decrease,setsar=1",
                        "-q:v",
                        str(quality),
                        "-threads",
                        "1",
                        str(path),
                    ],
                    ident,
                )
                if not path.exists() or not path.stat().st_size:
                    raise ValueError(
                        "The selected video frame could not be decoded. Choose an earlier frame."
                    )
                if edge != 320 or path.stat().st_size < 20 * 1024:
                    break
            else:
                raise ValueError(
                    "The cover thumbnail could not be reduced to Telegram's supported size."
                )
        return paths
    except BaseException:
        for path in paths:
            path.unlink(missing_ok=True)
        raise


async def make_cover(clip, info, timestamp=None, ident=None):
    duration = min(info["duration"], info.get("video_duration") or info["duration"])
    if timestamp is not None and not 0 <= timestamp < info["duration"]:
        raise ValueError("Choose a cover frame inside the rendered clip.")
    # Seek no later than the last decodable frame, including very short clips.
    position = min(1, duration / 2) if timestamp is None else timestamp
    position = min(position, max(0, duration - 1 / max(1, info.get("fps", 30))))
    revision = s.uid()
    result = {
        "time": position,
        "mode": "auto" if timestamp is None else "manual",
        "origin": "render",
        "revision": revision,
    }
    await _write_cover_files(clip["id"], revision, clip["path"], position, "", ident)
    return result


async def make_source_cover(clip_id, project, edit, timestamp, ident=None, duration=None):
    """Save a clean cover from the source before captions are burned in."""
    info = json.loads(project["metadata"])
    end = edit.start + (
        duration if duration is not None else max(0, edit.end - edit.start)
    )
    if timestamp is None or not edit.start <= timestamp < end:
        raise ValueError("Choose a Telegram cover frame inside the current clip.")
    _, _, vf = frame_filter(edit, info)
    revision = s.uid()
    await _write_cover_files(clip_id, revision, project["source"], timestamp, vf, ident)
    return {
        "time": round(max(0, timestamp - edit.start), 3),
        "source_time": round(timestamp, 3),
        "mode": "manual",
        "origin": "prerender",
        "revision": revision,
    }


async def make_project_frame(
    project, edit, timestamp, dest, ident=None, max_edge=480, quality=5
):
    """Write a cropped JPEG from the source without subtitles or watermark."""
    source = project.get("source")
    if not source or not Path(source).exists():
        raise ValueError("The original source is not available for cover frames.")
    info = json.loads(project["metadata"])
    if not 0 <= timestamp < float(info.get("duration") or 0):
        raise ValueError("Choose a cover frame inside the current clip.")
    _, _, vf = frame_filter(edit, info)
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    s.space_for(1024**2)
    try:
        await run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-ss",
                str(timestamp),
                "-i",
                str(source),
                "-frames:v",
                "1",
                "-vf",
                f"{vf},scale='min({max_edge},iw)':'min({max_edge},ih)':force_original_aspect_ratio=decrease,setsar=1",
                "-q:v",
                str(quality),
                "-threads",
                "1",
                str(dest),
            ],
            ident,
        )
        if not dest.exists() or not dest.stat().st_size:
            raise ValueError("The selected frame could not be decoded.")
        return dest
    except BaseException:
        dest.unlink(missing_ok=True)
        raise


async def update_cover(clip, timestamp=None, ident=None):
    info = json.loads(clip["metadata"])
    if not info.get("pixel_format"):
        info = {**info, **await probe(clip["path"])}
    previous = cover_paths(clip)
    cover = await make_cover(clip, info, timestamp, ident)
    paths = cover_paths({**clip, "metadata": {**info, "cover": cover}})
    try:
        info.update(cover=cover, telegram_compatible=telegram_compatible(info))
        s.execute(
            "UPDATE clips SET metadata=? WHERE id=?", (json.dumps(info), clip["id"])
        )
    except BaseException:
        for path in paths:
            path.unlink(missing_ok=True)
        raise
    for path in previous:
        path.unlink(missing_ok=True)
    return info


async def add_subtitle(
    project_id,
    path,
    title,
    language="",
    codec="subrip",
    original_ass=None,
    role="",
    origin="",
):
    try:
        subs = await asyncio.to_thread(pysubs2.load, str(path), encoding="utf-8-sig")
    except Exception:
        raise ValueError(
            "Could not read subtitles. Upload UTF-8 SRT, VTT, ASS or SSA text subtitles."
        )
    if len(subs) > 30000:
        raise ValueError("This subtitle file has too many cues (maximum 30,000).")
    cues = [
        {
            "start": max(0, event.start / 1000),
            "end": max(0, event.end / 1000),
            "text": event.plaintext,
        }
        for event in subs
        if event.end > event.start
    ]
    ident = s.uid()
    ass = None
    if codec in ("ass", "ssa"):
        ass = str(s.DATA / "subtitles" / (ident + ".ass"))
        await asyncio.to_thread(subs.save, ass)
    s.execute(
        "INSERT INTO subtitles VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            ident,
            project_id,
            title[:150],
            language,
            codec,
            json.dumps(cues),
            ass,
            1,
            role,
            origin,
        ),
    )
    return ident


async def ingest(project_id, path, ident):
    with Path(path).open("rb") as f:
        header = f.read(32)
    if not (
        header[:4] == b"\x1aE\xdf\xa3"
        or header[4:8] in (b"ftyp", b"moov", b"mdat", b"wide", b"free")
    ):
        raise ValueError("The source is not a supported MP4, MKV or WebM video file.")
    meta = await probe(path)
    if not meta["video_codec"] or meta["duration"] <= 0:
        raise ValueError("Choose a video with a readable duration and video stream.")
    s.execute(
        "UPDATE projects SET source=?, metadata=?, status=? WHERE id=?",
        (str(path), json.dumps(meta), "processing", project_id),
    )
    for track in meta["subtitles"]:
        title = (
            track["title"] or (track["language"] or "Subtitle") + " · " + track["codec"]
        )
        if not track["editable"]:
            s.execute(
                "INSERT INTO subtitles VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    s.uid(),
                    project_id,
                    title,
                    track["language"],
                    track["codec"],
                    "[]",
                    None,
                    0,
                    "",
                    "embedded",
                ),
            )
            continue
        extension = ".ass" if track["codec"] in ("ass", "ssa") else ".srt"
        dest = s.DATA / "work" / (s.uid() + extension)
        try:
            await run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-y",
                    "-i",
                    str(path),
                    "-map",
                    f"0:{track['index']}",
                    str(dest),
                ],
                ident,
            )
            language = (track["language"] or "").lower().split("-")[0]
            role = (
                "fa"
                if language in ("fa", "per", "fas", "persian")
                else "main"
                if language in ("en", "eng", "english")
                else ""
            )
            await add_subtitle(
                project_id,
                dest,
                title,
                track["language"],
                track["codec"],
                role=role,
                origin="embedded",
            )
        finally:
            dest.unlink(missing_ok=True)
    row = s.one("SELECT edit FROM projects WHERE id=?", (project_id,))
    edit = Edit.model_validate(json.loads(row["edit"])).model_dump()
    edit["end"] = meta["duration"]
    # Embedded source subtitles are kept available but are not selected
    # automatically: soft subtitles are off by default, so a new project uses
    # the editable/automatic subtitle tracks instead unless the operator
    # explicitly selects a source track or enables soft subtitles.
    s.execute("UPDATE projects SET edit=? WHERE id=?", (json.dumps(edit), project_id))
    thumb = s.DATA / "previews" / (project_id + ".jpg")
    try:
        await run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-ss",
                str(min(1, meta["duration"] / 2)),
                "-i",
                str(path),
                "-frames:v",
                "1",
                "-vf",
                "scale=640:-2",
                str(thumb),
            ],
            ident,
        )
        s.execute(
            "UPDATE projects SET thumbnail=? WHERE id=?", (str(thumb), project_id)
        )
    except ValueError:
        pass
    s.execute("UPDATE projects SET status='ready' WHERE id=?", (project_id,))


def dimensions(meta, edit):
    ratio = (
        meta["width"] / meta["height"]
        if edit.crop.ratio == "original"
        else float(edit.crop.ratio.split(":")[0]) / float(edit.crop.ratio.split(":")[1])
    )
    longest = edit.resolution
    if ratio >= 1:
        w, h = longest, round(longest / ratio / 2) * 2
    else:
        w, h = round(longest * ratio / 2) * 2, longest
    return max(2, w), max(2, h)


def ass_color(color, opacity=1):
    return pysubs2.Color(
        int(color[1:3], 16),
        int(color[3:5], 16),
        int(color[5:7], 16),
        round((1 - opacity) * 255),
    )


def ass_override_color(color):
    return f"&H{int(color[5:7], 16):02X}{int(color[3:5], 16):02X}{int(color[1:3], 16):02X}&"


def ass_override_alpha(opacity):
    return f"&H{round((1 - opacity) * 255):02X}&"


def ass_escape(text):
    return (
        text.replace("{", "｛")
        .replace("}", "｝")
        .replace("\\", "＼")
        .replace("\n", r"\N")
    )


RTL_EMBED_START = "\u202b"  # RIGHT-TO-LEFT EMBEDDING
RTL_EMBED_END = "\u202c"  # POP DIRECTIONAL FORMATTING


def rtl_embed(text):
    """Force a right-to-left paragraph direction for libass.

    libass renders every event as a left-to-right paragraph unless the text
    asks otherwise (see ass_resolve_base_direction), so trailing Persian
    punctuation ends up on the wrong side. The editor preview uses
    ``direction: rtl``, so an explicit Unicode RTL embedding makes burned-in
    captions match it, even when a line starts with Latin text or digits.
    """
    return f"{RTL_EMBED_START}{text}{RTL_EMBED_END}"


def watermark_windows(watermark, template, duration):
    lower = max(0.0, watermark.start)
    upper = duration if watermark.end is None else min(duration, watermark.end)
    if upper <= lower:
        return []
    if not template.repeat:
        return [(lower, upper)]
    decay = template.decay_time
    count = template.replication_count
    usable = upper - lower
    stepping = max(0.0, (usable - decay * count) / count)
    windows = []
    for index in range(count):
        start = lower + stepping / 2 + index * (stepping + decay)
        end = min(upper, start + decay)
        if start < upper and end > start:
            windows.append((start, end))
    return windows


def make_watermark(watermark, duration, w, h, work):
    template = watermark.template
    if not template:
        return None
    rows = [[element for element in row if element.text] for row in template.rows]
    rows = [row for row in rows if row]
    windows = watermark_windows(watermark, template, duration)
    if not rows or not windows:
        return None
    scale = h / 1080
    first = rows[0][0]
    subs = pysubs2.SSAFile()
    subs.info["PlayResX"], subs.info["PlayResY"] = str(w), str(h)
    subs.styles["Watermark"] = pysubs2.SSAStyle(
        fontname=first.font_family,
        fontsize=first.font_size * scale,
        primarycolor=ass_color(first.color, first.opacity),
        outlinecolor=ass_color(template.border_color),
        outline=template.border_thickness * scale,
        shadow=0,
        borderstyle=1,
        alignment=pysubs2.Alignment.MIDDLE_CENTER,
        marginl=0,
        marginr=0,
        marginv=0,
    )

    def tags(element):
        result = (
            f"\\fn{element.font_family}"
            f"\\fs{element.font_size * scale:.1f}"
            f"\\b{1 if element.bold else 0}"
            f"\\c{ass_override_color(element.color)}"
            f"\\alpha{ass_override_alpha(element.opacity)}"
        )
        if template.border_thickness:
            result += (
                f"\\bord{template.border_thickness * scale:.1f}"
                f"\\3c{ass_override_color(template.border_color)}"
            )
        else:
            result += "\\bord0"
        return result

    def estimate_width(element):
        return len(element.text) * element.font_size * scale * 0.62

    margin = watermark.margin * scale
    center_x = margin + (w - 2 * margin) * watermark.x
    center_y = margin + (h - 2 * margin) * watermark.y
    row_heights = [
        max(element.font_size for element in row) * scale * 1.2 for row in rows
    ]
    gap = template.gap_vertical * scale
    total_height = sum(row_heights) + gap * (len(rows) - 1)
    top = center_y - total_height / 2
    columns = max(len(row) for row in rows)
    column_widths = [
        max(estimate_width(row[index]) for row in rows if len(row) > index)
        for index in range(columns)
    ]
    grid_width = sum(column_widths) + template.gap_horizontal * scale * (columns - 1)
    grid_left = center_x - grid_width / 2
    placements = []
    for row, row_height in zip(rows, row_heights):
        row_center = top + row_height / 2
        if columns == 1:
            placements.append((row[0], center_x, row_center, "\\an5"))
        else:
            for index, element in enumerate(row):
                column_left = grid_left + sum(column_widths[:index])
                column_left += template.gap_horizontal * scale * index
                anchor = {
                    "left": ("\\an4", column_left),
                    "center": ("\\an5", column_left + column_widths[index] / 2),
                    "right": ("\\an6", column_left + column_widths[index]),
                }[element.alignment]
                placements.append((element, anchor[1], row_center, anchor[0]))
        top += row_height + gap
    for element, x, y, anchor in placements:
        text = f"{{{anchor}\\pos({x:.1f},{y:.1f})}}{{{tags(element)}}}{ass_escape(element.text)}"
        for start, end in windows:
            subs.events.append(
                pysubs2.SSAEvent(
                    start=round(start * 1000),
                    end=round(end * 1000),
                    style="Watermark",
                    text=text,
                )
            )
    dest = work / "watermark.ass"
    subs.save(str(dest))
    return dest


def subtitle_style(style, h, fa=False, name="Default"):
    """Build one ASS style using the same 1080-pixel reference as the editor."""
    scale = h / 1080
    alignment = {"bottom": 0, "middle": 3, "top": 6}[style.position] + {
        "left": 1,
        "center": 2,
        "right": 3,
    }[style.align]
    if fa:
        font = style.fa_font
        size = style.fa_size
        bold = style.fa_bold
        color = style.fa_color
        outline_color = style.fa_outline_color
        outline = style.fa_outline
        shadow = style.fa_shadow
    else:
        font = style.font
        size = style.size
        bold = style.bold
        color = style.color
        outline_color = style.outline_color
        outline = style.outline
        shadow = style.shadow
    substyle = pysubs2.SSAStyle(
        fontname=font,
        fontsize=size * scale,
        bold=bold,
        primarycolor=ass_color(color),
        outlinecolor=ass_color(outline_color),
        backcolor=ass_color("#000000", style.box_opacity if style.box else 0.6),
        outline=outline * scale,
        shadow=shadow * scale,
        borderstyle=3 if style.box else 1,
        alignment=pysubs2.Alignment(alignment),
        marginl=round(style.margin * scale),
        marginr=round(style.margin * scale),
        marginv=round(style.margin * scale),
    )
    # Opaque boxes use OutlineColour in libass.
    if style.box:
        substyle.outlinecolor = ass_color(outline_color, style.box_opacity)
    return substyle


def subtitle_events(row, style, start, end, w, h, fa=False, preserve=False):
    """Load one track, optionally preserving an uploaded ASS file, then trim it."""
    if preserve and row["ass_path"]:
        subs = pysubs2.load(row["ass_path"])
    else:
        subs = pysubs2.SSAFile()
        subs.info["PlayResX"], subs.info["PlayResY"] = str(w), str(h)
        subs.info["ScaledBorderAndShadow"] = "yes"
        subs.info["Collision"] = "Normal"
        subs.styles["Default"] = subtitle_style(style, h, fa, "Default")
        for cue in json.loads(row["cues"]):
            text = ass_escape(cue["text"])
            if fa:
                text = rtl_embed(text)
            subs.events.append(
                pysubs2.SSAEvent(
                    start=round(cue["start"] * 1000),
                    end=round(cue["end"] * 1000),
                    text=text,
                )
            )
    events = []
    for event in subs:
        a, b = event.start / 1000 + style.offset, event.end / 1000 + style.offset
        if b > start and a < end:
            event.start = round((max(a, start) - start) * 1000)
            event.end = round((min(b, end) - start) * 1000)
            events.append(event)
    subs.events = events
    return subs


def make_subs(
    project_id,
    edit,
    start,
    end,
    w,
    h,
    work,
    snapshot=None,
    snapshot_fa=None,
):
    style = edit.subtitles
    main_row = snapshot or (
        s.one(
            "SELECT * FROM subtitles WHERE id=? AND project_id=?",
            (style.track_id, project_id),
        )
        if style.track_id
        else None
    )
    fa_row = snapshot_fa or (
        s.one(
            "SELECT * FROM subtitles WHERE id=? AND project_id=?",
            (style.fa_track_id, project_id),
        )
        if style.fa_track_id
        else None
    )
    if not main_row and not fa_row:
        raise ValueError("The selected subtitle track no longer exists.")
    for row in (main_row, fa_row):
        if row and not row["editable"]:
            raise ValueError(
                "Image subtitles cannot be edited or burned in. Upload text subtitles instead."
            )
    if fa_row:
        # Viditor renders the Farsi line first at the bottom and the main
        # language above it. The invisible gap line gives libass room to stack
        # wrapped Farsi text without a fixed margin.
        fa_subs = subtitle_events(fa_row, style, start, end, w, h, fa=True)
        main_subs = (
            subtitle_events(main_row, style, start, end, w, h)
            if main_row
            else None
        )
        merged = pysubs2.SSAFile()
        merged.info["PlayResX"], merged.info["PlayResY"] = str(w), str(h)
        merged.info["ScaledBorderAndShadow"] = "yes"
        merged.info["Collision"] = "Normal"
        merged.styles.pop("Default", None)
        merged.styles["FaStyle"] = subtitle_style(style, h, fa=True, name="FaStyle")
        merged.styles["MainStyle"] = subtitle_style(
            style, h, fa=False, name="MainStyle"
        )
        for event in fa_subs:
            event.style = "FaStyle"
            merged.events.append(event)
        if main_subs:
            gap = style.gap * h / 1080
            for event in main_subs:
                event.style = "MainStyle"
                event.text += f"\\N{{\\alpha&HFF&\\fs{gap:.1f}}}._"
                merged.events.append(event)
        subs = merged
    else:
        row = main_row or fa_row
        subs = subtitle_events(
            row,
            style,
            start,
            end,
            w,
            h,
            fa=main_row is None,
            preserve=style.preserve_ass,
        )
    dest = work / "captions.ass"
    subs.save(str(dest))
    return dest


def filter_path(path):
    return str(path).replace("\\", "\\\\").replace(":", r"\:").replace("'", r"\'")


async def render(project, payload, ident):
    edit = Edit.model_validate(payload["edit"])
    meta = json.loads(project["metadata"])
    if edit.end <= edit.start or edit.end > meta["duration"] + 0.05:
        raise ValueError(
            "The clip end must follow the start and stay inside the video."
        )
    preview = bool(payload.get("preview"))
    duration = min(edit.end - edit.start, 6) if preview else edit.end - edit.start
    w, h = dimensions(meta, edit)
    work = s.DATA / "work" / ident
    work.mkdir(exist_ok=True)
    clip_id = s.uid()
    dest = s.DATA / "renders" / (clip_id + ".mp4")
    s.space_for(max(50 * 1024**2, int(duration * w * h / 3)))
    args = [
        "ffmpeg",
        "-hide_banner",
        "-v",
        "error",
        "-y",
        "-ss",
        str(edit.start),
        "-i",
        project["source"],
    ]
    filters = []
    wm = edit.watermark
    next_input = 1
    image_index = None
    if wm.kind == "image":
        asset = s.one(
            "SELECT * FROM assets WHERE id=? AND project_id=? AND kind='watermark'",
            (wm.asset_id, project["id"]),
        )
        if not asset:
            raise ValueError("Upload a watermark image first.")
        image_index = next_input
        next_input += 1
        args += ["-loop", "1", "-i", asset["path"]]
    music_index = None
    if edit.audio.music_id:
        asset = s.one(
            "SELECT * FROM assets WHERE id=? AND project_id=? AND kind='music'",
            (edit.audio.music_id, project["id"]),
        )
        if not asset:
            raise ValueError("The background music no longer exists.")
        music_index = next_input
        args += ["-stream_loop", "-1", "-i", asset["path"]]
    soft_sub_index = None
    if edit.subtitles.soft:
        text_tracks = [
            track
            for track in meta.get("subtitles", [])
            if track.get("codec") in TEXT_SUBS and track.get("editable")
        ]
        if not text_tracks:
            raise ValueError(
                "This video has no text soft subtitles. Turn off soft subtitles "
                "to use the editable English and Persian tracks."
            )
        soft_sub_index = text_tracks[0]["index"]
    _, _, vf = frame_filter(edit, meta)
    if (
        edit.subtitles.burn
        and not edit.subtitles.soft
        and (edit.subtitles.track_id or edit.subtitles.fa_track_id)
    ):
        subs = make_subs(
            project["id"],
            edit,
            edit.start,
            edit.start + duration,
            w,
            h,
            work,
            payload.get("subtitle_snapshot"),
            payload.get("subtitle_snapshot_fa"),
        )
        vf += f",ass=filename='{filter_path(subs)}':fontsdir='{filter_path(FONT_DIR)}'"
    visibility_end = duration if wm.end is None else min(wm.end, duration)
    enable = f"between(t,{wm.start},{visibility_end})"
    if wm.kind == "text" and wm.template:
        subs = make_watermark(wm, duration, w, h, work)
        if subs:
            vf += f",ass=filename='{filter_path(subs)}':fontsdir='{filter_path(FONT_DIR)}'"
    elif wm.kind == "text" and wm.text:
        textfile = work / "watermark.txt"
        textfile.write_text(wm.text)
        fontpath = await font_path(wm.font)
        fontsize = wm.size * h / 1080
        margin = wm.margin * h / 1080
        vf += f",drawtext=fontfile='{filter_path(fontpath)}':textfile='{filter_path(textfile)}':expansion=none:fontsize={fontsize}:fontcolor={wm.color}@{wm.opacity}:x={margin}+(w-tw-2*{margin})*{wm.x}:y={margin}+(h-th-2*{margin})*{wm.y}:enable='{enable}'"
    filters.append(f"[0:v:0]{vf}[base]")
    video = "base"
    if image_index is not None:
        margin = wm.margin * h / 1080
        filters.append(
            f"[{image_index}:v]scale={max(2, round(w * wm.width / 2) * 2)}:-2,format=rgba,colorchannelmixer=aa={wm.opacity}[wm]"
        )
        filters.append(
            f"[base][wm]overlay=x={margin}+(main_w-overlay_w-2*{margin})*{wm.x}:y={margin}+(main_h-overlay_h-2*{margin})*{wm.y}:enable='{enable}':shortest=1[vout]"
        )
        video = "vout"
    audios = []
    if meta["audio"] and not edit.audio.mute:
        if edit.audio.track >= len(meta["audio"]):
            raise ValueError("The selected audio track does not exist.")
        filters.append(
            f"[0:a:{edit.audio.track}]volume={edit.audio.volume},atrim=duration={duration},asetpts=PTS-STARTPTS[a0]"
        )
        audios.append("[a0]")
    if music_index is not None:
        clip_duration = edit.end - edit.start
        fade_in = min(edit.audio.fade_in, clip_duration / 2)
        fade_out = min(edit.audio.fade_out, clip_duration / 2)
        filters.append(
            f"[{music_index}:a:0]atrim=duration={duration},asetpts=PTS-STARTPTS,volume={edit.audio.music_volume},afade=t=in:d={fade_in},afade=t=out:st={clip_duration - fade_out}:d={fade_out}[music]"
        )
        audios.append("[music]")
    if len(audios) == 2:
        filters.append(
            "".join(audios) + "amix=inputs=2:duration=longest:normalize=0[aout]"
        )
        audio = "[aout]"
    else:
        audio = audios[0] if audios else None
    args += [
        "-filter_complex_threads",
        "1",
        "-filter_complex",
        ";".join(filters),
        "-map",
        f"[{video}]",
    ]
    if audio:
        args += ["-map", audio]
    if soft_sub_index is not None:
        args += ["-map", f"0:{soft_sub_index}", "-c:s", "mov_text"]
    preset, crf = {
        "fast": ("veryfast", 23),
        "balanced": ("medium", 21),
        "high": ("slow", 18),
    }[edit.quality]
    args += [
        "-t",
        str(duration),
        "-r",
        str(edit.fps),
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        str(crf),
        "-threads",
        "3",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-nostats",
        str(dest),
    ]
    try:
        await run(args, ident, duration)
        info = await probe(dest)
        if not telegram_compatible(info):
            raise ValueError(
                "The export could not be verified as a Telegram-compatible MP4. Render it again."
            )
        info["telegram_compatible"] = True
        info["caption_context"] = {
            "start": edit.start,
            "end": edit.start + duration,
            "track_id": edit.subtitles.track_id,
            "fa_track_id": edit.subtitles.fa_track_id,
        }
        if payload.get("signature"):
            info["render_signature"] = payload["signature"]
        selected = (meta.get("cover_frame") or {}).get("time")
        cover = None
        if selected is not None:
            try:
                cover = await make_source_cover(
                    clip_id,
                    project,
                    edit,
                    float(selected),
                    ident=ident,
                    duration=duration,
                )
            except Cancelled:
                raise
            except Exception:
                # A stale selection must not block an otherwise valid render.
                cover = None
        info["cover"] = cover or await make_cover(
            {"id": clip_id, "path": str(dest)}, info, ident=ident
        )
        name = re.sub(r"[^\w\- .]", "", edit.filename).strip(" .") or "clip"
        if preview:
            name += "-preview"
        s.execute(
            "INSERT INTO clips VALUES (?,?,?,?,?,?,?)",
            (
                clip_id,
                project["id"],
                name + ".mp4",
                str(dest),
                json.dumps(info),
                time.time(),
                int(preview),
            ),
        )
        s.update_job(ident, result_id=clip_id)
    except BaseException:
        dest.unlink(missing_ok=True)
        for path in (s.DATA / "renders").glob(clip_id + "-*.jpg"):
            path.unlink(missing_ok=True)
        raise
    finally:
        import shutil

        shutil.rmtree(work, ignore_errors=True)
