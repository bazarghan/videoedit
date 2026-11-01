from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .font_catalog import FontFamily

AUTO_SUBTITLE_DEFAULT_MINUTES = 6
AUTO_SUBTITLE_MAX_MINUTES = 600


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Cue(Strict):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    text: str = Field(max_length=4000)


class SubtitleDefaults(Strict):
    burn: bool = True
    preserve_ass: bool = False
    soft: bool = False
    font: FontFamily = "Arial"
    size: int = Field(default=60, ge=12, le=160)
    bold: bool = True
    color: str = "#ffffff"
    outline_color: str = "#000000"
    outline: float = Field(default=3.75, ge=0, le=12)
    shadow: float = Field(default=0, ge=0, le=12)
    # Viditor's Farsi track uses IRAN Yekan ExtraBold in yellow below the
    # main language. Sizes and margins use the same 1080-pixel reference as
    # the main track. The defaults mirror Viditor's 384×288 ASS values.
    fa_font: FontFamily = "IRANYekanWeb ExtraBold"
    fa_size: int = Field(default=60, ge=12, le=160)
    fa_bold: bool = False
    fa_color: str = "#ffff00"
    fa_outline_color: str = "#000000"
    fa_outline: float = Field(default=3.75, ge=0, le=12)
    fa_shadow: float = Field(default=0, ge=0, le=12)
    gap: float = Field(default=22.5, ge=0, le=200)
    box: bool = False
    box_opacity: float = Field(default=0.5, ge=0, le=1)
    position: Literal["bottom", "middle", "top"] = "bottom"
    align: Literal["left", "center", "right"] = "center"
    margin: int = Field(default=90, ge=0, le=400)
    offset: float = Field(default=0, ge=-600, le=600)

    @field_validator("color", "outline_color", "fa_color", "fa_outline_color")
    @classmethod
    def hex_color(cls, v):
        import re

        if not re.fullmatch(r"#[0-9a-fA-F]{6}", v):
            raise ValueError("Choose a valid color.")
        return v


class SubtitleStyle(SubtitleDefaults):
    track_id: str = ""
    fa_track_id: str = ""


class AutoSubtitleRequest(Strict):
    language: str = Field(default="en", min_length=2, max_length=12)
    translate: bool = True


DEFAULT_CAPTION_PROMPT = """تو یک نویسندهٔ حرفه‌ای کپشن تلگرام هستی. بر اساس زیرنویس‌های انگلیسی یا فارسی کلیپ و نام پروژه، یک کپشن فارسی جذاب و دقیق بنویس.

ساختار خروجی را دقیقاً به این شکل رعایت کن و هیچ متن اضافه‌ای قبل یا بعد از آن ننویس:

نام اثر:
[نام فیلم یا سریال]

سال انتشار:
[سال]

امتیاز IMDb:
[امتیاز] از [تعداد رأی] هزار رأی

توضیحات صحنه:
[یک پاراگراف کوتاه، جذاب و توصیفی دربارهٔ صحنه، شخصیت‌ها، تنش و مفهوم آن، فقط بر اساس زیرنویس‌ها و زمینهٔ کلیپ]

قواعد:
- متن داخل [] را با مقدار واقعی جایگزین کن و خود کروشه‌ها را ننویس.
- اگر نام اثر، سال یا امتیاز IMDb را با اطمینان نمی‌دانی، همان مقدار را «نامشخص» بنویس و حدس نزن.
- توضیحات صحنه را به فارسی روان و طبیعی بنویس.
- از Markdown، ایموجی، هشتگ یا بولت استفاده نکن.
- خروجی فقط متن خام کپشن باشد و کمتر از ۹۰۰ کاراکتر باشد."""


class AIConfig(Strict):
    api_key: str = Field(default="", max_length=512)
    base_url: str = Field(default="http://localhost:20128/v1", max_length=500)
    model: str = Field(default="kr/claude-sonnet-4.5", max_length=200)
    caption_prompt: str = Field(default=DEFAULT_CAPTION_PROMPT, max_length=8000)
    clear_key: bool = False


class ElevenLabsConfig(Strict):
    api_key: str = Field(default="", max_length=512)
    model: str = Field(default="scribe_v2", max_length=100)
    max_duration_minutes: int | None = Field(
        default=None, ge=1, le=AUTO_SUBTITLE_MAX_MINUTES
    )
    clear_key: bool = False


class Crop(Strict):
    ratio: Literal["original", "16:9", "9:16", "1:1", "4:5"] = "original"
    mode: Literal["fill", "fit"] = "fill"
    x: float = Field(default=0.5, ge=0, le=1)
    y: float = Field(default=0.5, ge=0, le=1)


class WatermarkText(Strict):
    text: str = Field(default="", max_length=300)
    font_family: FontFamily = "Arial"
    font_size: int = Field(default=60, ge=8, le=400)
    bold: bool = True
    color: str = "#ffffff"
    opacity: float = Field(default=0.2, ge=0, le=1)
    alignment: Literal["left", "center", "right"] = "left"
    _color = field_validator("color")(SubtitleStyle.hex_color.__func__)


class WatermarkTemplate(Strict):
    rows: list[list[WatermarkText]] = Field(default_factory=list)
    gap_horizontal: int = Field(default=36, ge=0, le=600)
    gap_vertical: int = Field(default=36, ge=0, le=600)
    border_color: str = "#000000"
    border_thickness: float = Field(default=0, ge=0, le=20)
    decay_time: float = Field(default=2, gt=0, le=120)
    replication_count: int = Field(default=5, ge=1, le=50)
    repeat: bool = True
    _color = field_validator("border_color")(SubtitleStyle.hex_color.__func__)


def default_watermark_text():
    # Mirrors Viditor's active default template, scaled to the 1080-pixel
    # reference height used by this app.
    return WatermarkText(
        text="TELEGRAM: @hl_clips",
        font_family="Arial",
        font_size=60,
        bold=True,
        color="#ffffff",
        opacity=0.2,
        alignment="left",
    )


def default_watermark_template():
    return WatermarkTemplate(rows=[[default_watermark_text()]])


class Watermark(Strict):
    kind: Literal["none", "text", "image"] = "text"
    template: WatermarkTemplate | None = None
    text: str = Field(default="", max_length=300)
    asset_id: str = ""
    x: float = Field(default=0.5, ge=0, le=1)
    y: float = Field(default=0.5, ge=0, le=1)
    size: int = Field(default=60, ge=12, le=200)
    width: float = Field(default=0.18, ge=0.02, le=0.8)
    opacity: float = Field(default=0.8, ge=0, le=1)
    margin: int = Field(default=0, ge=0, le=400)
    color: str = "#ffffff"
    font: FontFamily = "Arial"
    start: float = Field(default=0, ge=0)
    end: float | None = Field(default=None, gt=0)
    _color = field_validator("color")(SubtitleStyle.hex_color.__func__)


def default_watermark():
    return Watermark(
        kind="text",
        template=default_watermark_template(),
        text="TELEGRAM: @hl_clips",
        x=0.5,
        y=0.5,
        size=60,
        margin=0,
        color="#ffffff",
        font="Arial",
    )


class Audio(Strict):
    track: int = Field(default=0, ge=0)
    mute: bool = False
    volume: float = Field(default=1, ge=0, le=3)
    music_id: str = ""
    music_volume: float = Field(default=0.3, ge=0, le=3)
    fade_in: float = Field(default=0.5, ge=0, le=30)
    fade_out: float = Field(default=1, ge=0, le=30)


class ProjectDefaults(Strict):
    subtitles: SubtitleDefaults = Field(default_factory=SubtitleDefaults)
    watermark: Watermark = Field(default_factory=default_watermark)


class ProjectDefaultsPatch(Strict):
    subtitles: SubtitleDefaults | None = None
    watermark: Watermark | None = None


class Edit(Strict):
    start: float = Field(default=0, ge=0)
    end: float = Field(default=0, ge=0)
    subtitles: SubtitleStyle = Field(default_factory=SubtitleStyle)
    crop: Crop = Field(default_factory=Crop)
    watermark: Watermark = Field(default_factory=default_watermark)
    audio: Audio = Field(default_factory=Audio)
    resolution: Literal[720, 1080, 1920] = 1920
    fps: Literal[24, 25, 30, 50, 60] = 30
    quality: Literal["fast", "balanced", "high"] = "fast"
    filename: str = Field(default="clip", max_length=100)


class ImportURL(Strict):
    url: str = Field(min_length=8, max_length=12000)
    name: str = Field(default="Imported video", max_length=120)
    use_proxy: bool = False


class LocalAudioTrack(Strict):
    index: int = Field(ge=0)
    codec: str = Field(default="unknown", max_length=40)
    language: str = Field(default="", max_length=80)
    title: str = Field(default="", max_length=200)


class LocalSubtitleTrack(Strict):
    index: int = Field(ge=0)
    codec: str = Field(default="unknown", max_length=40)
    language: str = Field(default="", max_length=80)
    title: str = Field(default="", max_length=200)
    editable: bool = True


class LocalMetadata(Strict):
    """Source metadata extracted in the browser, shaped like ``media.probe``."""

    duration: float = Field(gt=0, le=60 * 60 * 24)
    size: int = Field(default=0, ge=0)
    width: int = Field(gt=0, le=16384)
    height: int = Field(gt=0, le=16384)
    video_codec: str | None = Field(default=None, max_length=40)
    pixel_format: str | None = Field(default=None, max_length=40)
    browser_container: str | None = Field(default=None, max_length=20)
    video_codec_tag: str | None = Field(default=None, max_length=20)
    video_duration: float = Field(default=0, ge=0)
    fps: float = Field(default=0, ge=0, le=240)
    format: str = Field(default="", max_length=200)
    audio: list[LocalAudioTrack] = Field(default_factory=list)
    subtitles: list[LocalSubtitleTrack] = Field(default_factory=list)


class LocalImport(Strict):
    name: str = Field(default="", max_length=120)
    metadata: LocalMetadata
    # A small JPEG from the browser so the project card has a thumbnail even
    # though the source video is never uploaded.
    thumbnail: str = Field(default="", max_length=4_000_000)


class DownloadProxyConfig(Strict):
    host: str = Field(min_length=1, max_length=253)
    port: int = Field(default=1080, ge=1, le=65535)
    username: str = Field(default="", max_length=255)
    password: str = Field(default="", max_length=255)
    clear_password: bool = False

    @field_validator("host")
    @classmethod
    def proxy_host(cls, value):
        import ipaddress
        import re

        value = value.strip().removeprefix("[").removesuffix("]")
        try:
            return str(ipaddress.ip_address(value))
        except ValueError:
            pass
        try:
            value = value.encode("idna").decode("ascii").lower().rstrip(".")
        except UnicodeError:
            raise ValueError("Enter a proxy hostname or IP address.") from None
        if not value or any(
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
            for label in value.split(".")
        ):
            raise ValueError(
                "Enter a proxy hostname or IP address, without a scheme or port."
            )
        return value

    @field_validator("username", "password")
    @classmethod
    def credential_size(cls, value):
        if len(value.encode("utf-8")) > 255:
            raise ValueError("SOCKS5 credentials must be at most 255 bytes each.")
        return value


class Login(Strict):
    username: str
    password: str = Field(max_length=1024)


class TelegramConfig(Strict):
    api_id: int = Field(gt=0)
    api_hash: str = Field(default="", max_length=100)
    bot_token: str = Field(default="", max_length=200)


class TelegramChannel(Strict):
    channel: str = Field(min_length=1, max_length=300)


class SendClip(Strict):
    destination: str = Field(default="", max_length=150)
    caption: str = Field(default="", max_length=1024)
    as_file: bool = False


class CoverSelection(Strict):
    time: float | None = Field(default=None, ge=0)


class CoverFrameSelection(Strict):
    time: float | None = Field(default=None, ge=0)
    start: float | None = Field(default=None, ge=0)
    end: float | None = Field(default=None, gt=0)
    edit: Edit | None = None
    # Local/browser projects extract the clean frame themselves and send a
    # JPEG data URL; the server never has the original source to seek in.
    image: str | None = Field(default=None, max_length=4_000_000)


class CoverFrameCandidates(Strict):
    count: int = Field(default=6, ge=2, le=12)
    start: float | None = Field(default=None, ge=0)
    end: float | None = Field(default=None, gt=0)
    edit: Edit | None = None


class StorageConfig(Strict):
    limit_gb: int = Field(ge=2, le=10000)


class Rename(Strict):
    name: str = Field(min_length=1, max_length=120)
