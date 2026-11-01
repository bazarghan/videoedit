"""Telegram delivery through a bot account.

The Telegram Bot API only accepts uploads up to 20 MB, so clips are uploaded
through MTProto using the bot token together with an API ID and API hash.
This keeps large renders available without signing in as a personal account.
"""

import asyncio
import json
import re
import time
from pathlib import Path

from telethon import TelegramClient, errors, events, functions, types, utils
from telethon.sessions import StringSession

from . import store as s
from .media import (
    Cancelled,
    cancelled,
    cover_paths,
    probe,
    telegram_compatible,
    update_cover,
)

BOT_FILE_LIMIT = 2 * 1024**3
CHANNEL_ID = re.compile(r"-?\d+")
CHAT_ID_COMMAND = r"(?i)^/chatid(?:@\w+)?(?:\s|$)"
CHAT_TARGET = re.compile(r"-?\d+|@?[A-Za-z][A-Za-z0-9_]{3,}")


def public_channel(channel):
    return {
        "id": str(channel["id"]),
        "name": channel.get("name") or "Telegram channel",
        "username": channel.get("username") or "",
        "verified": channel.get("verified") or 0,
        "error": channel.get("error") or "",
    }


class Telegram:
    def __init__(self):
        self.client = None
        self.client_key = None
        self.handler_registered = False
        self.lock = asyncio.Lock()

    async def get(self):
        config = s.setting("telegram", {})
        if not config.get("api_id") or not config.get("api_hash"):
            raise ValueError("Save your Telegram API ID and API hash first.")
        if not config.get("bot_token"):
            raise ValueError("Save your Telegram bot token first.")
        key = (config["api_id"], config["api_hash"], config["bot_token"])
        async with self.lock:
            if self.client is None or self.client_key != key:
                if self.client is not None:
                    await self.client.disconnect()
                session = s.setting("telegram_session", "")
                if session and not s.setting("telegram_bot_session", False):
                    # Never reuse a session created by the old account login.
                    session = ""
                    s.set_setting("telegram_session", "")
                self.client = TelegramClient(
                    StringSession(session),
                    config["api_id"],
                    config["api_hash"],
                    request_retries=2,
                    connection_retries=2,
                    flood_sleep_threshold=0,
                )
                self.client_key = key
                self.handler_registered = False
            if not self.client.is_connected():
                await self.client.connect()
            if not await self.client.is_user_authorized():
                await self.client.sign_in(bot_token=config["bot_token"])
                await self.save_session()
            if not self.handler_registered:
                # The bot stays connected so /chatid works in private chats and
                # groups; Telethon reconnects automatically after network drops.
                self.client.add_event_handler(
                    self.receive_chatid, events.NewMessage(pattern=CHAT_ID_COMMAND)
                )
                self.handler_registered = True
        return self.client

    async def start(self):
        """Connect the bot and start listening for /chatid commands."""
        try:
            await self.get()
            return True
        except Exception:
            # Startup must not fail when Telegram is not configured or offline.
            # The Settings page reports connection problems with a retry path.
            return False

    async def receive_chatid(self, event):
        try:
            chat = await event.get_chat()
        except Exception:
            chat = None
        title = getattr(chat, "title", None)
        if not title:
            title = " ".join(
                filter(
                    None,
                    [
                        getattr(chat, "first_name", None),
                        getattr(chat, "last_name", None),
                    ],
                )
            )
        lines = [f"Chat ID: {event.chat_id}"]
        if title:
            lines.insert(0, title)
        lines.append(
            "Use this ID as the test destination in VideoEdit. "
            "The bot must be able to message this chat."
        )
        await event.reply("\n".join(lines))

    async def save_session(self):
        if self.client is not None:
            s.set_setting("telegram_session", self.client.session.save())
            s.set_setting("telegram_bot_session", True)

    async def status(self):
        config = s.setting("telegram", {})
        configured = bool(
            config.get("api_id") and config.get("api_hash") and config.get("bot_token")
        )
        if not configured:
            return {"connected": False, "configured": False}
        try:
            client = await self.get()
            me = await client.get_me()
            return {
                "connected": True,
                "configured": True,
                "name": " ".join(filter(None, [me.first_name, me.last_name]))
                or "Telegram bot",
                "username": me.username,
            }
        except Exception as exc:
            return {
                "connected": False,
                "configured": True,
                "error": error_message(exc),
            }

    async def check(self):
        status = await self.status()
        if not status["connected"]:
            raise ValueError(
                status.get("error")
                or "Connect your Telegram bot in Settings before sending."
            )
        return status

    async def disconnect(self, logout=True):
        async with self.lock:
            if self.client:
                if logout:
                    try:
                        await self.client.log_out()
                    except Exception:
                        pass
                await self.client.disconnect()
            self.client = None
            self.client_key = None
            if logout:
                s.set_setting("telegram_session", "")
                s.set_setting("telegram_bot_session", False)

    async def _resolve(self, value):
        client = await self.get()
        value = (value or "").strip()
        if not value:
            raise ValueError("Enter a channel username, link or ID.")
        for prefix in (
            "https://t.me/",
            "http://t.me/",
            "t.me/",
            "https://telegram.me/",
            "http://telegram.me/",
            "telegram.me/",
        ):
            if value.lower().startswith(prefix):
                url = value if "://" in value else "https://" + value
                value = url.rstrip("/").split("/")[-1].split("?")[0]
                if value.startswith("+"):
                    # Private invite links only resolve while the bot is a member.
                    return await client.get_entity(url)
                break
        if CHANNEL_ID.fullmatch(value.replace(" ", "")):
            channel_id = int(value.replace(" ", ""))
            try:
                return await client.get_entity(channel_id)
            except ValueError:
                async for dialog in client.iter_dialogs():
                    if (
                        utils.get_peer_id(dialog.entity) == channel_id
                        or getattr(dialog.entity, "id", None) == channel_id
                    ):
                        return dialog.entity
                raise ValueError(
                    "The bot cannot see this channel. Add the bot to the channel "
                    "as an administrator first."
                ) from None
        username = value.removeprefix("@")
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{3,}", username):
            raise ValueError("Enter a public @username, t.me link or channel ID.")
        return await client.get_entity("@" + username)

    async def _resolve_chat(self, value):
        """Resolve a chat ID from /chatid, or a public @username.

        Bot accounts only know chats they have seen. A numeric ID therefore
        falls back to the bot's dialogs when Telethon has no cached entity yet.
        """
        client = await self.get()
        value = (value or "").strip()
        if not value:
            raise ValueError("Enter the chat ID returned by the bot's /chatid command.")
        if CHANNEL_ID.fullmatch(value.replace(" ", "")):
            target = int(value.replace(" ", ""))
            try:
                return await client.get_entity(target)
            except Exception:
                async for dialog in client.iter_dialogs():
                    if (
                        utils.get_peer_id(dialog.entity) == target
                        or getattr(dialog.entity, "id", None) == target
                    ):
                        return dialog.entity
            raise ValueError(
                "The bot cannot reach this chat. Send /chatid to the bot in a "
                "private chat, or add the bot to the group, then retry."
            ) from None
        return await self._resolve(value)

    async def _require_admin(self, client, entity):
        if isinstance(entity, types.User):
            raise ValueError("That is a user, not a channel.")
        if not isinstance(entity, types.Channel):
            raise ValueError("Choose a Telegram channel or supergroup.")
        try:
            permissions = await client.get_permissions(entity, "me")
        except errors.UserNotParticipantError:
            raise ValueError(
                "The bot is not a member of this channel. Add it as an "
                "administrator first."
            ) from None
        if not permissions or not permissions.is_admin:
            raise ValueError(
                "The bot is not an administrator of this channel. Promote the "
                "bot to an administrator with permission to post messages."
            )
        if getattr(entity, "broadcast", False) and not permissions.post_messages:
            raise ValueError(
                "The bot is an administrator but cannot post. Give it the "
                "Post messages permission for this channel."
            )
        return permissions

    def _channels(self):
        return s.setting("telegram", {}).get("channels", [])

    def _save_channels(self, channels):
        config = s.setting("telegram", {})
        config["channels"] = channels
        if not any(
            str(c["id"]) == str(config.get("default_channel")) for c in channels
        ):
            config["default_channel"] = str(channels[0]["id"]) if channels else ""
        s.set_setting("telegram", config)

    def channel(self, ident):
        channels = self._channels()
        for channel in channels:
            if str(channel["id"]) == str(ident) or (
                channel.get("username")
                and channel["username"].lower() == str(ident).lstrip("@").lower()
            ):
                return channel
        if not channels:
            raise ValueError("Add a Telegram channel in Settings before posting.")
        if not ident:
            return channels[0]
        raise ValueError("That Telegram channel is no longer configured.")

    async def list_channels(self):
        return [public_channel(channel) for channel in self._channels()]

    async def add_channel(self, value):
        client = await self.get()
        entity = await self._resolve(value)
        await self._require_admin(client, entity)
        channels = self._channels()
        channel = {
            "id": entity.id,
            "access_hash": getattr(entity, "access_hash", None),
            "name": getattr(entity, "title", None) or "Telegram channel",
            "username": getattr(entity, "username", None) or "",
            "verified": time.time(),
            "error": "",
        }
        channels = [c for c in channels if c["id"] != channel["id"]]
        channels.append(channel)
        self._save_channels(channels)
        return public_channel(channel)

    async def verify_channel(self, ident):
        client = await self.get()
        channels = self._channels()
        channel = self.channel(ident)
        try:
            entity = None
            if channel.get("access_hash") is not None:
                try:
                    entity = await client.get_entity(
                        types.InputPeerChannel(
                            channel_id=int(channel["id"]),
                            access_hash=int(channel["access_hash"]),
                        )
                    )
                except Exception:
                    entity = None
            if entity is None:
                entity = await self._resolve(
                    channel.get("username") or str(channel["id"])
                )
            await self._require_admin(client, entity)
            channel.update(
                access_hash=getattr(entity, "access_hash", channel.get("access_hash")),
                name=getattr(entity, "title", None) or channel["name"],
                username=getattr(entity, "username", None) or "",
                verified=time.time(),
                error="",
            )
        except Exception as exc:
            channel["error"] = error_message(exc)
            channel["verified"] = 0
            self._save_channels(channels)
            raise
        self._save_channels(channels)
        return public_channel(channel)

    async def remove_channel(self, ident):
        channels = [c for c in self._channels() if str(c["id"]) != str(ident)]
        self._save_channels(channels)
        return [public_channel(channel) for channel in channels]

    async def send(self, payload, ident):
        if cancelled(ident):
            raise Cancelled()
        client = await self.get()
        if not await client.is_user_authorized():
            raise ValueError("Save a valid Telegram bot token in Settings first.")
        clip = s.one("SELECT * FROM clips WHERE id=?", (payload["clip_id"],))
        if not clip:
            raise ValueError("The rendered clip was deleted.")
        path = Path(clip["path"])
        if path.stat().st_size >= BOT_FILE_LIMIT:
            raise ValueError("This clip exceeds the 2 GB Telegram bot upload limit.")
        chat_id = (payload.get("chat_id") or "").strip()
        if chat_id:
            # Test deliveries go straight to the chat ID from /chatid and do
            # not need a configured channel or administrator permissions.
            entity = await self._resolve_chat(chat_id)
        else:
            channel = self.channel(payload.get("destination", ""))
            if channel.get("access_hash") is not None:
                entity = types.InputPeerChannel(
                    channel_id=int(channel["id"]),
                    access_hash=int(channel["access_hash"]),
                )
            else:
                entity = await self._resolve(
                    channel.get("username") or str(channel["id"])
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
        if not info.get("pixel_format"):
            info = {**info, **await probe(clip["path"])}
        if not payload["as_file"] and not telegram_compatible(info):
            raise ValueError(
                "Render this clip again as a Telegram-compatible MP4 before sending it as a video."
            )
        paths = cover_paths(clip)
        if not paths or not all(path.exists() for path in paths):
            info = await update_cover(clip, ident=ident)
            paths = cover_paths({**clip, "metadata": info})

        async def check_cancel(*args):
            if cancelled(ident):
                raise Cancelled()

        attributes = [types.DocumentAttributeFilename(clip["name"])]
        file = clip["path"]
        if not payload["as_file"]:
            attributes.append(
                types.DocumentAttributeVideo(
                    duration=info["duration"],
                    w=info["width"],
                    h=info["height"],
                    supports_streaming=True,
                    nosound=not bool(info["audio"]),
                    video_codec="h264",
                )
            )
            video = await client.upload_file(
                file, file_name=clip["name"], progress_callback=progress
            )
            thumbnail = await client.upload_file(
                str(paths[1]), progress_callback=check_cancel
            )
            image = await client.upload_file(
                str(paths[0]), progress_callback=check_cancel
            )
            photo = await client(
                functions.messages.UploadMediaRequest(
                    peer=entity,
                    media=types.InputMediaUploadedPhoto(file=image),
                )
            )
            await check_cancel()
            file = types.InputMediaUploadedDocument(
                file=video,
                mime_type="video/mp4",
                attributes=attributes,
                thumb=thumbnail,
                video_cover=utils.get_input_photo(photo.photo),
                nosound_video=not bool(info["audio"]),
            )
        # Covers are uploaded as media, without posting a separate photo message.
        # Captions come from the Telegram HTML editor, so markup is interpreted.
        await check_cancel()
        await client.send_file(
            entity,
            file,
            caption=payload["caption"],
            force_document=payload["as_file"],
            supports_streaming=not payload["as_file"],
            parse_mode="html",
            progress_callback=progress,
            attributes=attributes,
            thumb=str(paths[1]) if payload["as_file"] else None,
        )
        await self.save_session()
        s.update_job(ident, result_id=clip["id"], progress=100)


def error_message(exc):
    if isinstance(exc, errors.FloodWaitError):
        return f"Telegram rate limit: wait {exc.seconds} seconds, then retry."
    if isinstance(
        exc,
        (
            errors.UnauthorizedError,
            errors.AuthKeyInvalidError,
            errors.AuthKeyUnregisteredError,
        ),
    ):
        return "The bot token is invalid or was revoked. Save a new token in Settings."
    if isinstance(exc, errors.BotMethodInvalidError):
        return "This Telegram bot cannot use that action. Check the bot token and try again."
    if isinstance(
        exc,
        (
            errors.ChatWriteForbiddenError,
            errors.UserBannedInChannelError,
            errors.ChatAdminRequiredError,
            errors.ChannelPrivateError,
        ),
    ):
        return "The bot does not have permission to post to this channel. Make it an administrator with Post messages access."
    if isinstance(exc, errors.UserNotParticipantError):
        return (
            "The bot is not a member of this channel. Add it as an administrator first."
        )
    if isinstance(exc, ValueError):
        return str(exc)
    return "Telegram could not complete the request. Check your bot token and channel permissions, then retry."


telegram = Telegram()
