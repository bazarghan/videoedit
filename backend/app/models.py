from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Cue(Strict):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    text: str = Field(max_length=4000)


class SubtitleStyle(Strict):
    track_id: str = ""
    burn: bool = True
    preserve_ass: bool = False
    font: Literal[
        "DejaVu Sans",
        "DejaVu Serif",
        "Liberation Sans",
        "Liberation Serif",
        "Noto Sans Arabic",
    ] = "DejaVu Sans"
    size: int = Field(default=48, ge=12, le=160)
    color: str = "#ffffff"
    outline_color: str = "#000000"
    outline: float = Field(default=2, ge=0, le=12)
    shadow: float = Field(default=1, ge=0, le=12)
    box: bool = False
    box_opacity: float = Field(default=0.5, ge=0, le=1)
    position: Literal["bottom", "middle", "top"] = "bottom"
    align: Literal["left", "center", "right"] = "center"
    margin: int = Field(default=60, ge=0, le=400)
    offset: float = Field(default=0, ge=-600, le=600)

    @field_validator("color", "outline_color")
    @classmethod
    def hex_color(cls, v):
        import re

        if not re.fullmatch(r"#[0-9a-fA-F]{6}", v):
            raise ValueError("Choose a valid color.")
        return v


class Crop(Strict):
    ratio: Literal["original", "16:9", "9:16", "1:1", "4:5"] = "original"
    mode: Literal["fill", "fit"] = "fill"
    x: float = Field(default=0.5, ge=0, le=1)
    y: float = Field(default=0.5, ge=0, le=1)


class Watermark(Strict):
    kind: Literal["none", "text", "image"] = "none"
    text: str = Field(default="", max_length=300)
    asset_id: str = ""
    x: float = Field(default=0.95, ge=0, le=1)
    y: float = Field(default=0.05, ge=0, le=1)
    size: int = Field(default=38, ge=12, le=200)
    width: float = Field(default=0.18, ge=0.02, le=0.8)
    opacity: float = Field(default=0.8, ge=0, le=1)
    margin: int = Field(default=24, ge=0, le=400)
    color: str = "#ffffff"
    font: Literal[
        "DejaVu Sans",
        "DejaVu Serif",
        "Liberation Sans",
        "Liberation Serif",
        "Noto Sans Arabic",
    ] = "DejaVu Sans"
    start: float = Field(default=0, ge=0)
    end: float | None = Field(default=None, gt=0)
    _color = field_validator("color")(SubtitleStyle.hex_color.__func__)


class Audio(Strict):
    track: int = Field(default=0, ge=0)
    mute: bool = False
    volume: float = Field(default=1, ge=0, le=3)
    music_id: str = ""
    music_volume: float = Field(default=0.3, ge=0, le=3)
    fade_in: float = Field(default=0.5, ge=0, le=30)
    fade_out: float = Field(default=1, ge=0, le=30)


class Edit(Strict):
    start: float = Field(default=0, ge=0)
    end: float = Field(default=0, ge=0)
    subtitles: SubtitleStyle = Field(default_factory=SubtitleStyle)
    crop: Crop = Field(default_factory=Crop)
    watermark: Watermark = Field(default_factory=Watermark)
    audio: Audio = Field(default_factory=Audio)
    resolution: Literal[720, 1080, 1920] = 1920
    fps: Literal[24, 25, 30, 50, 60] = 30
    quality: Literal["fast", "balanced", "high"] = "fast"
    filename: str = Field(default="clip", max_length=100)


class ImportURL(Strict):
    url: str = Field(min_length=8, max_length=12000)
    name: str = Field(default="Imported video", min_length=1, max_length=120)


class Login(Strict):
    username: str
    password: str = Field(max_length=1024)


class TelegramConfig(Strict):
    api_id: int = Field(gt=0)
    api_hash: str = Field(default="", max_length=100)
    phone: str = Field(min_length=7, max_length=30)
    destination: str = "me"


class TelegramCode(Strict):
    code: str = Field(default="", max_length=20)
    password: str = Field(default="", max_length=512)


class SendClip(Strict):
    destination: str = Field(default="me", max_length=150)
    caption: str = Field(default="", max_length=1024)
    as_file: bool = False


class StorageConfig(Strict):
    limit_gb: int = Field(ge=2, le=10000)


class Rename(Strict):
    name: str = Field(min_length=1, max_length=120)
