# VideoEdit

A private, self-hosted clip studio. Import a video, choose a moment, shape the frame, style the captions, and export a finished MP4. Send an export through your own Telegram account when you choose.

Built with React, TypeScript, FastAPI, FFmpeg/libass, SQLite, and Telethon. VideoEdit keeps the original source for final rendering and creates cached H.264/AAC browser previews for MP4, MKV, and WebM inputs, including HEVC and embedded text subtitles.

## Features

- Direct HTTP/HTTPS downloads with complete signed URLs, upload progress, cancellation, and actionable errors.
- Persistent projects and background jobs; one render at a time with three encoding threads.
- Browser playback, seeking, playback speed, fullscreen, audio-track selection, and clip looping.
- Draggable trim handles, exact time fields, and cuts re-encoded for precision.
- Embedded and external SRT, ASS/SSA, and WebVTT text subtitles, cue editing, timing offsets, font/color/outline/shadow controls, background boxes, alignment, and margins.
- Original, landscape, vertical, square, and portrait frames with fit/fill and visual positioning.
- Text and PNG/JPEG watermarks, drag positioning, corner presets, opacity, and timed visibility.
- Original audio selection and volume, mute, background music, looping, and fades.
- Six-second rendered previews and MP4 exports with H.264, AAC, and fast-start metadata.
- Encrypted Telegram API credentials and authorized sessions, code/2FA sign-in, destinations, captions, playable-video/file sending, progress, and retry.
- Administrator authentication on every media, job, project, and settings endpoint; protected cookies and origin checks.
- Storage limits, a disk-space reserve, and explicit cleanup that refuses to delete media used by active jobs.

## Quick start with Docker

Install Docker with the Compose plugin and Git. Use an HTTPS reverse proxy and a hostname you control for public access.

```sh
git clone https://github.com/bazarghan/videoedit.git
cd videoedit
./deploy/initialize.sh
```

Edit `.env` with a unique `ADMIN_PASSWORD` of at least 12 characters, the desired `ADMIN_USERNAME`, and the exact public `PUBLIC_URL` including any nonstandard port. The application stores a password hash on first startup; later edits to the bootstrap password do not reset it.

Prepare the persistent directory for the image's unprivileged user and start:

```sh
sudo chown 10001:10001 data
chmod 700 data
chmod 600 .env
docker compose up -d --build --wait
```

The application binds only to `127.0.0.1:8010` by default. Change `APP_PORT` if needed. Configure a reverse proxy using [the example Caddyfile](deploy/Caddyfile.example), replacing its example hostname and port. Caddy can issue and renew HTTPS certificates when its ACME challenge ports are reachable. Keep the application port private.

Sign in using the administrator credentials configured in `.env`. For local HTTP development only, set `COOKIE_SECURE=false`; use `true` for HTTPS deployments.

## Create a clip

1. Click **New project** and paste a direct media URL or upload a video. Website page URLs, platform scraping, DRM, and adaptive playlists are outside the importer.
2. Wait for inspection and the browser preview. Select a subtitle track in **Captions**; text subtitles appear over the player.
3. Drag the timeline handles or enter exact start/end seconds. Use **Set start here**, **Set end here**, and loop to refine the selection.
4. Choose a frame in **Frame**. Fill crops the edges; Fit retains the whole source with black padding. Drag to reframe or use the position sliders.
5. Style captions, add a watermark in **Mark**, and choose music or an audio track in **Audio**. Save cue text changes with **Save cues**; other valid edit settings save automatically.
6. Click **Render preview** to check up to six seconds of the actual output. Click **Render clip** for the full selected section. Results appear below the editor and in **Rendered clips**.
7. Download the MP4, or open a clip and explicitly click **Send now** after connecting Telegram.

Font sizes and margins use a 1080-pixel reference height and scale with the output. Resolution controls the longest output edge. Subtitle timing offsets use source time; watermark visibility uses time relative to the clip start. Cues that cross trim boundaries are clipped and shifted correctly. A render captures its edit settings and subtitle text when queued.

## Telegram

Create an API application at [my.telegram.org](https://my.telegram.org/apps). In Settings, save your API ID, API hash, and phone number with country code, then click **Connect account**. Enter the code delivered by Telegram and the two-step verification password if requested.

Login codes and 2FA passwords are never persisted. API credentials and the authorized StringSession are encrypted with the installation's persistent key. The saved API hash is never returned to the browser. Disconnect logs out the Telegram session. No message is sent during setup or testing.

Destinations include Saved Messages and up to 200 recent dialogs; Telegram validates the account's current send permissions. Set a default destination in Settings. Telegram rate limits and upload failures are shown in Activity. Review Telegram before retrying an interrupted send: it may already have completed.

## Operations

Configuration lives in `.env`. Persistent state lives in `data/`: SQLite, encrypted settings, the encryption key, originals, previews, subtitles, assets, and exports. Do not commit either directory or file. Compose configures startup after a reboot through `restart: unless-stopped`.

```sh
# Status and recent diagnostic logs (access logging is disabled)
docker compose ps
docker compose logs --tail 100 app

# Restart — running jobs become interrupted; queued jobs resume
docker compose restart app

# Update from the public repository; no GitHub key is needed
./deploy/update.sh

# Consistent backup, with a brief application stop
sudo ./deploy/backup.sh
```

Store backups securely outside the deployment volume. A backup contains account sessions and credentials. Preserve **both** `data/` and `.env`, especially `data/encryption.key`; losing the key makes encrypted settings, Telegram authorization, and queued job payloads unreadable. Restore only trusted backups.

To move an installation, wait for jobs to finish, make a backup, clone the public repository on the new host, and restore `.env` and `data/` into the new checkout. Restore ownership to UID/GID `10001:10001`, update `PUBLIC_URL` and the HTTPS proxy/DNS as needed, and run `docker compose up -d --build --wait`. Keep only one instance active against a given data directory. TLS configuration and certificates are managed by your reverse proxy and should be backed up separately.

To reset the administrator password without exposing it in shell history:

```sh
docker compose exec app python -c 'from getpass import getpass; from pwdlib import PasswordHash; from app import store; p=getpass("New password: "); assert len(p)>=12; store.set_setting("admin_hash", PasswordHash.recommended().hash(p)); store.execute("DELETE FROM sessions")'
```

Cleanup is manual. Removing originals prevents future rendering of those projects. Removing cached previews leaves originals available for regeneration. Removing rendered clips deletes those exports. Active and stopping jobs block destructive file operations.

## Development and verification

Requires Python 3.12+, Node 22.12+ or 24, FFmpeg with H.264/AAC/libass/drawtext, Fontconfig, and the DejaVu, Liberation, and Noto Arabic fonts. Docker supplies the media dependencies.

```sh
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt -c backend/constraints.txt
.venv/bin/pip install -r backend/requirements-dev.txt
npm --prefix frontend ci

# Backend terminal — choose your own development password
export DATA_DIR="$PWD/data" COOKIE_SECURE=false ADMIN_PASSWORD='a-unique-development-password'
PYTHONPATH=backend .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000

# Frontend terminal
npm --prefix frontend run dev

# Verification
PYTHONPATH=backend .venv/bin/pytest backend/tests -q
npm --prefix frontend run build
```

Tests generate real footage with embedded subtitles and audio, import it, verify authenticated range playback, trim boundaries and subtitle styling, mix music, render vertical MP4s with text and image watermarks, and check output dimensions, codecs, duration, download headers, origin checks, encrypted state, URL validation, and cleanup protection. Telegram workflow tests use an in-memory substitute; live authentication and sends are always initiated by the operator.

## Design and practical limits

A single FastAPI process owns persistent SQLite queues and three background lanes: download/inspection, preview/render, and Telegram upload. CPU-heavy work runs in FFmpeg subprocesses. Do not scale this application to multiple web workers against the same database without adding a coordinated external queue.

The editor provides a responsive approximation of libass captions. Original ASS styles, animated effects, complex shaping, outline rendering, and background boxes can differ from the browser overlay; rendered previews provide the exact output. With **Preserve original ASS styling** enabled, original ASS events and styles are used, so custom cue edits and uniform style controls apply only when that option is disabled.

Image subtitle tracks such as PGS are detected and clearly labeled; OCR, editing, and image-subtitle burn-in are not implemented. Upload a text subtitle file to caption those videos. Browser preview generation can take time for long HEVC sources and creates a separate cached file for each selected audio track. Full-file proxy generation is intentionally serialized with exports.

Downloads restart from the beginning after failure; they do not resume partial byte ranges. Uploading a source file is synchronous, with browser progress; probing, proxy generation, rendering, network downloads, and Telegram uploads run as background jobs. Preview original-audio changes regenerate the proxy. Music preview volume is limited by browser playback APIs; verify amplification above 1× through a rendered preview.

Default storage capacity is 20 GB and a 1 GB free-space reserve. MP4/MKV/WebM sources and recognized image/audio file signatures are required. Signed URLs are encrypted in the job store and excluded from diagnostic responses. HTTP redirects and DNS answers are validated on every connection to prevent private-network requests; downloader requests never use environment proxies. FFmpeg is invoked with argument arrays and restricted local input protocols. Only trusted administrators should access an installation.

See [SECURITY.md](SECURITY.md) for security reporting and deployment considerations. Licensed under [MIT](LICENSE).
