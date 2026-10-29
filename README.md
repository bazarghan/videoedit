# VideoEdit

A private, self-hosted clip studio. Import a video, choose a moment, shape the frame, style the captions, and export a finished MP4. Send an export through your own Telegram account when you choose.

Built with React, TypeScript, FastAPI, FFmpeg/libass, SQLite, and Telethon. VideoEdit keeps the original source for final rendering. Imports try the original in your browser; if the browser cannot play its codecs or container, trimming, captions, and renders still use the original. Embedded text subtitles remain editable either way.

## Features

- Direct HTTP/HTTPS downloads with complete signed URLs, optional SOCKS5 proxies, upload progress, cancellation, and actionable errors.
- Telegram-ready MP4 exports with automatic video covers and manual frame selection from the finished clip.
- Persistent projects and background jobs; one render at a time with three encoding threads.
- Browser playback, seeking, playback speed, fullscreen, audio-track selection, and clip looping.
- Draggable trim handles, exact time fields, and cuts re-encoded for precision.
- Embedded and external SRT, ASS/SSA, and WebVTT text subtitles, cue editing, timing offsets, font/color/outline/shadow controls, background boxes, alignment, and margins.
- Dual English + Persian subtitles in Viditor's exact layout: bold white English Arial above, yellow IRAN Yekan ExtraBold Persian below, with the same gap and bottom margins.
- One-click **Auto subtitle** using ElevenLabs Scribe for English timing and an OpenAI-compatible 9Router model for the Persian translation.
- Pause the player, click a caption on the video, and edit its text in place; save with Ctrl/⌘+Enter or by clicking away.
- Source soft subtitles are ignored by default so the editable/automatic tracks win. Enable **Use the video's original soft subtitles** to keep the embedded text track instead.
- Bundled Vazirmatn, Shabnam, Sahel, IRAN Yekan (IRANYekanWeb), and IRAN Yekan ExtraBold Persian fonts for captions and text watermarks, with the same font files used in the editor and exports.
- Original, landscape, vertical, square, and portrait frames with fit/fill and visual positioning.
- Text and PNG/JPEG watermarks, drag positioning, corner presets, opacity, timed visibility, and multi-element text templates with rows, per-element fonts, sizes, colours, weight, and alignment.
- A built-in default watermark template with the centred **TELEGRAM: @hl_clips** mark, repeating for two seconds five times across the clip.
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
2. Wait for inspection. The original video plays if your browser supports its codecs and container. In **Captions**, click **Auto subtitle** for English + Persian, or choose/upload your own tracks. Embedded source subtitles are listed but stay off by default; enable **Use the video's original soft subtitles** to use them instead. If the original cannot play, you can still trim and render it.
3. Drag the timeline handles or enter exact start/end seconds. Use **Set start here**, **Set end here**, and loop to refine the selection.
4. Choose a frame in **Frame**. Fill crops the edges; Fit retains the whole source with black padding. Drag to reframe or use the position sliders.
5. Style captions, add a watermark in **Mark**, and choose music or an audio track in **Audio**. Save cue text changes with **Save cues**; other valid edit settings save automatically.
6. Click **Render preview** to check up to six seconds of the actual output. Click **Render clip** for the full selected section. Results appear below the editor and in **Rendered clips**.
7. Download the MP4, or open a clip and explicitly click **Send now** after connecting Telegram.

Font sizes and margins use a 1080-pixel reference height and scale with the output. Resolution controls the longest output edge; the default 1920-pixel edge produces Full HD landscape or vertical clips. Subtitle timing offsets use source time; watermark visibility uses time relative to the clip start. Cues that cross trim boundaries are clipped and shifted correctly. A render captures its edit settings and subtitle text when queued.

In **Settings → Project defaults**, choose the English and Persian subtitle fonts, sizes, weights, colors, outlines, gap, background, positioning, soft-subtitle behavior, and timing offset, plus the watermark type, text or image, multi-element template, placement, and visibility times. Text watermarks use a row-based template: each element has its own text, font, size, bold weight, colour, opacity, and alignment, and the template controls gaps, border, and timed repetition. The built-in default mirrors the Viditor template: a centred, bold Arial **TELEGRAM: @hl_clips** mark at 20% opacity, shown for two seconds five times, with Arial bold captions. Click **Save project defaults** to use them for each new URL or uploaded-video import. In the editor, **Save subtitle settings as defaults** and **Save watermark settings as defaults** update that section independently. Existing projects keep their settings. Image watermarks are copied into new projects and remain available even if the original project is deleted. **Reset to built-in defaults** restores the original presets for future imports.

## Automatic English and Persian subtitles

The caption pipeline follows [Viditor](https://github.com/2000ostd/viditor): the main English track is rendered above the Persian track, the English line is white Arial bold, and the Persian line is yellow IRAN Yekan ExtraBold. Both use the 1080-pixel reference used by the rest of the editor, so the 16 px / 24 px / 6 px Viditor values become 60 px / 90 px / 22.5 px at a 1080-pixel height.

In **Settings → Auto subtitles**, save both credentials:

- **ElevenLabs API token** for speech-to-text. The default model is `scribe_v2`; the audio is extracted to a small mono MP3 before upload.
- **9Router base URL, API token, and model** for translation. 9Router exposes an OpenAI-compatible `/chat/completions` endpoint; its default local address is `http://localhost:20128/v1`. Point this at the router that is reachable from the application container.

Open a project and click **Auto subtitle** in the editor header or the Captions tab. The background job extracts audio, transcribes it with word timing, groups the words into readable cues, translates every cue to Persian in numbered batches, and replaces only the previous automatic tracks. The finished project gets two editable tracks: **English (auto)** and **فارسی (خودکار)**.

To edit while watching, pause the player and click a caption line on the video. The line becomes an in-place text field; press Ctrl/⌘+Enter or click elsewhere to save. Press Escape to cancel. The same cues are available as a paginated list in the Captions tab, with separate English and Persian track buttons.

Source soft subtitles are **off by default**. New imports keep embedded subtitle tracks available in the selector but do not select, burn, or display them automatically. Enable **Use the video's original soft subtitles** to keep the embedded text track in the preview and export; rendered MP4s then contain a `mov_text` soft track instead of burned-in captions. If the browser cannot expose the source track, the export still carries it.

## SOCKS5 downloads

In **New project → Video link**, enable **Use SOCKS5 proxy** and enter its hostname/IP address and port (usually 1080). Username and password are optional. **Save proxy** stores the connection for future downloads; starting a proxied download also saves it. Keep the checkbox off to connect directly.

Passwords are encrypted and never returned to the browser. Leaving the password blank retains it only for the same host, port and username. Use **Clear saved password** to remove authentication or **Remove saved proxy** to delete the profile. Each queued job retains an encrypted snapshot, so changes apply to new downloads; existing jobs and retries keep their original connection.

Video hostnames are resolved and validated locally, then public IP addresses are sent through SOCKS5. Redirects use the same proxy and retain signed query parameters. HTTPS certificate verification and the original hostname are preserved. The proxy must be reachable from the application; in Docker, `localhost` refers to the application container. Remote proxy DNS (`socks5h`), proxy chains and HTTP proxies are not supported. These settings apply to URL imports, not Telegram uploads or browser playback.

## Telegram

Exports use H.264 video with `yuv420p` pixels, AAC audio when present, and fast-start MP4 packaging. Each render is checked for compatibility and gets a cover from the finished video, including captions, crop and watermark. Muted clips are sent as playable videos rather than animated GIFs.

Open a clip from **Rendered clips** or the editor's recent renders. Under **Telegram cover**, pause/scrub the video or enter **Preview frame (seconds)**, then click **Use current frame**. Choose **Automatic frame** to return to the default frame near the beginning. Cover changes do not require rendering the video again and apply to future sends. Existing exports receive automatic covers during startup. Wait for the cover job to finish before sending.

Playable videos include both Telegram's dedicated video cover and a small JPEG thumbnail for client compatibility. **Send as a file** attaches the thumbnail and retains document behavior. A cover changes the video's poster, not its playback starting position. Telegram clients control how covers are displayed.

Create an API application at [my.telegram.org](https://my.telegram.org/apps). In Settings, save your API ID, API hash, and phone number with country code, then click **Connect account**. Enter the code delivered by Telegram and the two-step verification password if requested.

Login codes and 2FA passwords are never persisted. API credentials and the authorized StringSession are encrypted with the installation's persistent key. The saved API hash is never returned to the browser. Disconnect logs out the Telegram session. No message is sent during setup or testing.

Destinations include Saved Messages and up to 200 recent dialogs; Telegram validates the account's current send permissions. Set a default destination in Settings. Telegram rate limits and upload failures are shown in Activity. Review Telegram before retrying an interrupted send: it may already have completed.

## Operations

Configuration lives in `.env`. Persistent state lives in `data/`: SQLite, encrypted settings, the encryption key, originals, thumbnails, subtitles, assets, and exports. Do not commit either directory or file. Compose configures startup after a reboot through `restart: unless-stopped`.

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

Cleanup is manual. Removing originals prevents future rendering of those projects. Removing thumbnails deletes the project cover images. Removing rendered clips deletes those exports. Active and stopping jobs block destructive file operations.

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

A single FastAPI process owns persistent SQLite queues and three background lanes: download/inspection, render/cover, and Telegram upload. CPU-heavy work runs in FFmpeg subprocesses. Do not scale this application to multiple web workers against the same database without adding a coordinated external queue.

The editor provides a responsive approximation of libass captions. Original ASS styles, animated effects, complex shaping, outline rendering, and background boxes can differ from the browser overlay; rendered previews provide the exact output. With **Preserve original ASS styling** enabled, original ASS events and styles are used, so custom cue edits and uniform style controls apply only when that option is disabled.

Image subtitle tracks such as PGS are detected and clearly labeled; OCR, editing, and image-subtitle burn-in are not implemented. Upload a text subtitle file to caption those videos. Original playback depends on the browser, container, and codecs; VideoEdit does not create conversion copies for playback. If the browser cannot play an MKV, HEVC, or other unsupported source, the timeline, captions, and watermark controls still work and the export is produced from the original file. Playback uses the video's default audio track; choose the export audio track in **Audio**.

Downloads restart from the beginning after failure; they do not resume partial byte ranges. Uploading a source file is synchronous, with browser progress and known-size requests; multipart files spool on the persistent data volume, and admission checks reserve space for the temporary copy. Probing, rendering, network downloads, and Telegram uploads run as background jobs. Music preview volume is limited by browser playback APIs; verify amplification above 1× through a rendered preview.

Default storage capacity is 20 GB and a 1 GB free-space reserve. Renders also check available storage during processing. MP4/MKV/WebM sources and recognized image/audio file signatures are required. Signed URLs are encrypted in the job store and excluded from diagnostic responses. HTTP redirects and DNS answers are validated on every connection to prevent private-network requests; downloader requests never use environment proxies. FFmpeg is invoked with argument arrays and restricted local input protocols. Only trusted administrators should access an installation.

See [SECURITY.md](SECURITY.md) for security reporting and deployment considerations. Licensed under [MIT](LICENSE).
