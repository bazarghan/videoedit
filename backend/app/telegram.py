"""Encrypted StringSession; login codes and 2FA passwords remain in memory only."""

import asyncio
import json
import time

from telethon import TelegramClient, errors, types
from telethon.sessions import StringSession

from . import store as s
from .media import Cancelled, cancelled


class Telegram:
    def __init__(self):
        self.client = None
        self.phone_hash = None
        self.lock = asyncio.Lock()
        self.pending_since = 0

    async def get(self):
        config = s.setting("telegram", {})
        if not config.get("api_id") or not config.get("api_hash"):
            raise ValueError(
                "Save your Telegram API ID, API hash and phone number first."
            )
        if self.client is None:
            self.client = TelegramClient(
                StringSession(s.setting("telegram_session", "")),
                config["api_id"],
                config["api_hash"],
                request_retries=2,
                connection_retries=2,
                flood_sleep_threshold=0,
            )
        if not self.client.is_connected():
            await self.client.connect()
        return self.client

    async def save_session(self):
        s.set_setting("telegram_session", self.client.session.save())

    async def status(self):
        if not s.setting("telegram_session"):
            return {
                "connected": False,
                "step": "code" if self.phone_hash else "connect",
            }
        try:
            client = await self.get()
            if not await client.is_user_authorized():
                return {"connected": False, "step": "connect"}
            me = await client.get_me()
            return {
                "connected": True,
                "name": (" ".join(filter(None, [me.first_name, me.last_name]))),
                "username": me.username,
            }
        except Exception:
            return {
                "connected": False,
                "step": "connect",
                "error": "Telegram is unreachable. Try connecting again.",
            }

    async def connect(self):
        async with self.lock:
            client = await self.get()
            if await client.is_user_authorized():
                return await self.status()
            phone = s.setting("telegram")["phone"]
            sent = await client.send_code_request(phone)
            self.phone_hash = sent.phone_code_hash
            self.pending_since = time.time()
            return {"connected": False, "step": "code"}

    async def verify(self, code="", password=""):
        async with self.lock:
            if not self.phone_hash or time.time() - self.pending_since > 600:
                raise ValueError("Request a new login code before signing in.")
            client = await self.get()
            try:
                if password:
                    await client.sign_in(password=password)
                else:
                    await client.sign_in(
                        phone=s.setting("telegram")["phone"],
                        code=code,
                        phone_code_hash=self.phone_hash,
                    )
            except errors.SessionPasswordNeededError:
                return {"connected": False, "step": "password"}
            await self.save_session()
            self.phone_hash = None
            return await self.status()

    async def disconnect(self, logout=True):
        async with self.lock:
            if self.client:
                if logout:
                    try:
                        await self.client.log_out()
                    finally:
                        await self.client.disconnect()
                else:
                    await self.client.disconnect()
            elif logout and s.setting("telegram_session"):
                client = await self.get()
                try:
                    await client.log_out()
                finally:
                    await client.disconnect()
            self.client = None
            self.phone_hash = None
            if logout:
                s.set_setting("telegram_session", "")

    async def dialogs(self):
        client = await self.get()
        if not await client.is_user_authorized():
            raise ValueError("Connect your Telegram account first.")
        result = [{"id": "me", "name": "Saved Messages"}]
        async for dialog in client.iter_dialogs(limit=200):
            entity = dialog.entity
            if getattr(entity, "left", False) or getattr(entity, "deactivated", False):
                continue
            if (
                dialog.is_channel
                and getattr(entity, "broadcast", False)
                and not (
                    getattr(entity, "creator", False)
                    or getattr(entity, "admin_rights", None)
                )
            ):
                continue
            if getattr(
                getattr(entity, "default_banned_rights", None), "send_messages", False
            ) and not getattr(entity, "admin_rights", None):
                continue
            result.append({"id": str(dialog.id), "name": dialog.name})
        return result

    async def send(self, payload, ident):
        client = await self.get()
        if not await client.is_user_authorized():
            raise ValueError(
                "Connect your Telegram account in Settings before sending."
            )
        clip = s.one("SELECT * FROM clips WHERE id=?", (payload["clip_id"],))
        if not clip:
            raise ValueError("The rendered clip was deleted.")
        me = await client.get_me()
        limit = (4 if getattr(me, "premium", False) else 2) * 1024**3
        from pathlib import Path

        if Path(clip["path"]).stat().st_size >= limit:
            raise ValueError(
                "This clip exceeds the Telegram file-size limit for your account."
            )
        dest = payload["destination"]
        entity = await client.get_input_entity(
            int(dest) if dest.lstrip("-").isdigit() else dest
        )
        started = time.monotonic()

        async def progress(sent, total):
            if cancelled(ident):
                raise Cancelled()
            s.update_job(
                ident,
                progress=sent / total * 100,
                bytes=sent,
                speed=sent / max(1, time.monotonic() - started),
            )

        info = json.loads(clip["metadata"])
        # Text is sent literally; Telegram markup is never interpreted.
        await client.send_file(
            entity,
            clip["path"],
            caption=payload["caption"],
            force_document=payload["as_file"],
            supports_streaming=not payload["as_file"],
            parse_mode=None,
            progress_callback=progress,
            attributes=[
                types.DocumentAttributeFilename(clip["name"]),
                types.DocumentAttributeVideo(
                    duration=round(info["duration"]),
                    w=info["width"],
                    h=info["height"],
                    supports_streaming=True,
                ),
            ]
            if not payload["as_file"]
            else [types.DocumentAttributeFilename(clip["name"])],
        )
        await self.save_session()
        s.update_job(ident, result_id=clip["id"])


def error_message(exc):
    if isinstance(exc, errors.FloodWaitError):
        return f"Telegram rate limit: wait {exc.seconds} seconds, then retry."
    if isinstance(exc, (errors.PhoneCodeInvalidError, errors.PhoneCodeExpiredError)):
        return "The code is incorrect or expired. Request another code if needed."
    if isinstance(exc, errors.PasswordHashInvalidError):
        return "The two-step verification password is incorrect."
    if isinstance(
        exc,
        (
            errors.ChatWriteForbiddenError,
            errors.UserBannedInChannelError,
            errors.ChatAdminRequiredError,
        ),
    ):
        return "Your Telegram account does not have permission to send to this destination."
    if isinstance(exc, ValueError):
        return str(exc)
    return "Telegram could not complete the request. Check your connection and account permissions, then retry."


telegram = Telegram()
