import asyncio
from pathlib import Path
from typing import Literal

FontFamily = Literal[
    "DejaVu Sans",
    "DejaVu Serif",
    "Liberation Sans",
    "Liberation Serif",
    "Noto Sans Arabic",
    "Vazirmatn",
    "Shabnam",
    "Sahel",
    "IRANYekanWeb",
]

FONT_DIR = Path(__file__).resolve().parent / "fonts"
BUNDLED_FONTS = {
    "Vazirmatn": FONT_DIR / "Vazirmatn-Regular.ttf",
    "Shabnam": FONT_DIR / "Shabnam.ttf",
    "Sahel": FONT_DIR / "Sahel.ttf",
    "IRANYekanWeb": FONT_DIR / "IRANYekanWebRegular.ttf",
}
FONT_SLUGS = {
    "sans": "DejaVu Sans",
    "serif": "DejaVu Serif",
    "liberation-sans": "Liberation Sans",
    "liberation-serif": "Liberation Serif",
    "arabic": "Noto Sans Arabic",
    "vazirmatn": "Vazirmatn",
    "shabnam": "Shabnam",
    "sahel": "Sahel",
    "iranyekanweb": "IRANYekanWeb",
}


async def font_path(family: FontFamily) -> Path:
    if family in BUNDLED_FONTS:
        return BUNDLED_FONTS[family]
    proc = await asyncio.create_subprocess_exec(
        "fc-match", "-f", "%{file}", family, stdout=asyncio.subprocess.PIPE
    )
    return Path((await proc.communicate())[0].decode())
