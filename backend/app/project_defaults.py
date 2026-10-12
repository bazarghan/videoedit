"""Persistent import presets, with independent copies of watermark images."""

import shutil
from pathlib import Path

from . import store as s
from .models import Edit, ProjectDefaults


def get_defaults():
    return ProjectDefaults.model_validate(s.setting("project_defaults", {}))


def copy_watermark(asset_id, project_id):
    asset = s.one("SELECT * FROM assets WHERE id=? AND kind='watermark'", (asset_id,))
    if not asset or not Path(asset["path"]).is_file():
        raise ValueError("Choose an available watermark image before saving defaults.")
    source = Path(asset["path"])
    s.space_for(source.stat().st_size)
    ident = s.uid()
    path = s.DATA / "assets" / (ident + source.suffix)
    try:
        shutil.copyfile(source, path)
        s.execute(
            "INSERT INTO assets VALUES (?,?,?,?,?)",
            (ident, project_id, "watermark", str(path), asset["name"]),
        )
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return ident


def save_defaults(body):
    with s.lock:
        if (
            body.watermark.end is not None
            and body.watermark.end <= body.watermark.start
        ):
            raise ValueError(
                "The watermark end must follow its start (relative to the clip)."
            )
        previous = get_defaults()
        asset_id = body.watermark.asset_id
        if body.watermark.kind == "image" and not asset_id:
            raise ValueError("Choose a watermark image before saving defaults.")
        if asset_id and asset_id != previous.watermark.asset_id:
            body.watermark.asset_id = copy_watermark(asset_id, None)
        try:
            s.set_setting("project_defaults", body.model_dump())
        except BaseException:
            if body.watermark.asset_id != asset_id:
                remove_default_asset(body.watermark.asset_id)
            raise
        if previous.watermark.asset_id != body.watermark.asset_id:
            remove_default_asset(previous.watermark.asset_id)
        return body


def remove_default_asset(asset_id):
    asset = s.one("SELECT * FROM assets WHERE id=? AND project_id IS NULL", (asset_id,))
    if asset:
        Path(asset["path"]).unlink(missing_ok=True)
        s.execute("DELETE FROM assets WHERE id=?", (asset_id,))


def initial_edit(project_id):
    # Snapshot at import time, before queued downloads or inspection can run.
    with s.lock:
        defaults = get_defaults()
        if defaults.watermark.asset_id:
            defaults.watermark.asset_id = copy_watermark(
                defaults.watermark.asset_id, project_id
            )
        return Edit(**defaults.model_dump())
