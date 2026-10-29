import asyncio
from pathlib import Path
from typing import Literal

FontFamily = Literal[
    "Arial",
    "DejaVu Sans",
    "DejaVu Serif",
    "Liberation Sans",
    "Liberation Serif",
    "Noto Sans Arabic",
    "Vazirmatn",
    "Shabnam",
    "Sahel",
    "IRANYekanWeb",
    "IRANYekanWeb ExtraBold",
]

FONT_DIR = Path(__file__).resolve().parent / "fonts"
BUNDLED_FONTS = {
    "Vazirmatn": FONT_DIR / "Vazirmatn-Regular.ttf",
    "Shabnam": FONT_DIR / "Shabnam.ttf",
    "Sahel": FONT_DIR / "Sahel.ttf",
    "IRANYekanWeb": FONT_DIR / "IRANYekanWebRegular.ttf",
    "IRANYekanWeb ExtraBold": FONT_DIR / "IRANYekanWebExtraBold.ttf",
}
FONT_SLUGS = {
    "arial": "Arial",
    "sans": "DejaVu Sans",
    "serif": "DejaVu Serif",
    "liberation-sans": "Liberation Sans",
    "liberation-serif": "Liberation Serif",
    "arabic": "Noto Sans Arabic",
    "vazirmatn": "Vazirmatn",
    "shabnam": "Shabnam",
    "sahel": "Sahel",
    "iranyekanweb": "IRANYekanWeb",
    "iranyekanweb-extra-bold": "IRANYekanWeb ExtraBold",
}


async def font_path(family: FontFamily, bold: bool = False) -> Path:
    if family in BUNDLED_FONTS:
        return BUNDLED_FONTS[family]
    pattern = f"{family}:bold" if bold else family
    proc = await asyncio.create_subprocess_exec(
        "fc-match", "-f", "%{file}", pattern, stdout=asyncio.subprocess.PIPE
    )
    return Path((await proc.communicate())[0].decode())
