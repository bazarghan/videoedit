# VideoEdit

A private, self-hosted clip studio. Import a video, choose a moment, shape the frame, style the captions, and export a finished MP4. Post an export through your own Telegram bot when you choose.

Built with React, TypeScript, FastAPI, FFmpeg/libass, ffmpeg.wasm, SQLite, and Telethon. VideoEdit keeps the original source for final rendering. Imports try the original in your browser; if the browser cannot play its codecs or container, trimming, captions, and renders still use the original. Embedded text subtitles remain editable either way.

## Features

- Direct HTTP/HTTPS downloads with complete signed URLs, optional SOCKS5 proxies, upload progress, cancellation, and actionable errors.
- Single-video YouTube imports through yt-dlp, with the same proxy support, progress, cancellation, and automatic project naming.
- Telegram-ready MP4 exports with automatic video covers, clean pre-render frame candidates, and manual frame selection from the finished clip.
- Persistent projects and background jobs; one render at a time with three encoding threads.
- Browser playback, seeking, playback speed, fullscreen, audio-track selection, and clip looping.
- **Render in the browser:** open a local video without uploading it, edit it with the same trim, crop, captions, watermark, audio, and encoder settings as a server render, then upload only the finished MP4. The original never leaves the device.
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
- Telegram HTML caption editor with formatting, links, emoji, preview, and a 1,024-character limit, plus AI auto captions generated from the clip's English or Persian subtitles using a configurable 9Router system prompt.
- Encrypted Telegram bot credentials and session, verified channels, playable-video/file posting up to 2 GB, progress, and retry.
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

1. Click **New project** and paste a direct media URL, paste a YouTube link, or upload a video. YouTube imports accept one public video, Shorts, or youtu.be link at a time; playlists, channels, live streams, DRM, and other platform extractors are rejected. Other website page URLs, platform scraping, and adaptive playlists are outside the direct-link importer.
2. Wait for inspection. The original video plays if your browser supports its codecs and container. Click **Auto subtitle** in the editor header for English + Persian, or open **Advanced → Captions** to choose/upload your own tracks. Embedded source subtitles are listed but stay off by default; enable **Use the video's original soft subtitles** to use them instead. If the original cannot play, you can still trim and render it.
3. Drag the timeline handles or enter exact start/end seconds in **Advanced → Clip**. Use **Set start here**, **Set end here**, and loop to refine the selection.
4. Open **Advanced → Frame** to choose a frame. Fill crops the edges; Fit retains the whole source with black padding. Drag to reframe or use the position sliders.
5. In **Advanced**, style captions, add a watermark in **Mark**, and choose music or an audio track in **Audio**. Save cue text changes with **Save cues**; other valid edit settings save automatically.
6. Click **Render preview** to check up to six seconds of the actual output. Click **Render clip** for the full selected section. An identical cut is only rendered once; change the cut or delete the old export before rendering it again. Results appear below the editor and in **Rendered clips**.
7. Download the MP4, or open a clip and explicitly click **Send now** after connecting Telegram.

Font sizes and margins use a 1080-pixel reference height and scale with the output. Resolution controls the longest output edge; the default 1920-pixel edge produces Full HD landscape or vertical clips. Subtitle timing offsets use source time; watermark visibility uses time relative to the clip start. Cues that cross trim boundaries are clipped and shifted correctly. A render captures its edit settings and subtitle text when queued.

In **Settings → Project defaults**, choose the English and Persian subtitle fonts, sizes, weights, colors, outlines, gap, background, positioning, soft-subtitle behavior, and timing offset, plus the watermark type, text or image, multi-element template, placement, and visibility times. Text watermarks use a row-based template: each element has its own text, font, size, bold weight, colour, opacity, and alignment, and the template controls gaps, border, and timed repetition. The built-in default mirrors the Viditor template: a centred, bold Arial **TELEGRAM: @hl_clips** mark at 20% opacity, shown for two seconds five times, with Arial bold captions. Click **Save project defaults** to use them for each new URL or uploaded-video import. In the editor, **Save subtitle settings as defaults** and **Save watermark settings as defaults** update that section independently. Existing projects keep their settings. Image watermarks are copied into new projects and remain available even if the original project is deleted. **Reset to built-in defaults** restores the original presets for future imports.

## Render in the browser

**New project → Render in browser** keeps the source on your computer. The browser reads the file in place with the File API, sends only its metadata and a small thumbnail to the server, and renders the clip locally with ffmpeg.wasm. When the render finishes, only the finished MP4 is uploaded. The project, its edit settings, uploaded text subtitles, and the rendered clips live on the server as usual so Telegram posting and the clip library keep working.

The browser plan is generated by the server from the same edit and metadata as a normal render. It contains the identical filter graph, subtitle/watermark ASS files, font files, x264 preset/CRF, frame rate, and audio mixing, so cuts and burned-in effects match a server render. The browser writes those files into the WebAssembly filesystem, mounts the video read-only, and runs the same ffmpeg command against it. The server remuxes the uploaded MP4 for fast-start and verifies its duration, frame size, and Telegram compatibility.

Things to know:

- Rendering uses the single-threaded ffmpeg.wasm build. A five-minute 1080p clip can take several minutes to encode, depending on the machine; the tab must stay open. Lower **Resolution** or choose the **Fast** quality preset to shorten the wait.
- The original is not stored on the server. After a page reload, open the project and select the same local file again to continue playing and rendering; the size is checked against the project.
- **Auto subtitle** works without uploading the video: the browser extracts a small mono MP3 of the selected cut and uploads only that audio. The resulting English and Persian tracks use source time and are stored like any other automatic track. Uploaded SRT/ASS/VTT files work normally too.
- Source playback relies on the browser's own decoder. The bundled ffmpeg.wasm core can decode H.264, HEVC, VP8/VP9, MPEG-4, and most common audio; AV1 decoding is not included. AV1 files are rejected when importing into browser mode and you get the option to upload the file for a normal server render instead. A file the browser cannot play can still be trimmed by time.
- The ffmpeg core files are self-hosted under `/ffmpeg/` and regenerated by `npm run dev` / `npm run build`. Keep that static route and the app's CSP (`wasm-unsafe-eval` and `blob:` scripts) intact behind any reverse proxy.
- A browser render is capped to an estimated 1.2 GB output, because the encoded file is held in WebAssembly memory. Shorten the cut or lower the resolution if the editor rejects it.
- The finished upload is validated against the selected cut. A client that reports or produces a different duration, frame size, or frame rate is rejected instead of being saved as a clip.
- `@ffmpeg/core` is licensed GPL-2.0-or-later (the build includes x264), unlike the MIT-licensed application code. Review the license terms before distributing the bundled browser renderer.

## Automatic English and Persian subtitles

The caption pipeline follows [Viditor](https://github.com/2000ostd/viditor): the main English track is rendered above the Persian track, the English line is white Arial bold, and the Persian line is yellow IRAN Yekan ExtraBold. Both use the 1080-pixel reference used by the rest of the editor, so the 16 px / 24 px / 6 px Viditor values become 60 px / 90 px / 22.5 px at a 1080-pixel height.

In **Settings → Auto subtitles**, save both credentials:

- **ElevenLabs API token** for speech-to-text. The default model is `scribe_v2`; the audio is extracted to a small mono MP3 before upload.
- **Maximum video length** in minutes (default 6). Longer videos are blocked before any transcription or translation request is sent, so a long import cannot silently consume tokens. Raise the limit when you intentionally want to subtitle longer videos.
- **9Router base URL, API token, and model** for translation. 9Router exposes an OpenAI-compatible `/chat/completions` endpoint; its default local address is `http://localhost:20128/v1`. Point this at the router that is reachable from the application container.

Open a project and click **Auto subtitle** in the editor header or under **Advanced → Captions**. The background job extracts audio, transcribes it with word timing, groups the words into readable cues, translates every cue to Persian in numbered batches, and replaces only the previous automatic tracks. The finished project gets two editable tracks: **English (auto)** and **فارسی (خودکار)**. Projects that already have automatic subtitles are not transcribed again; edit the existing tracks or upload a replacement instead.

To edit while watching, pause the player and click a caption line on the video. The line becomes an in-place text field; press Ctrl/⌘+Enter or click elsewhere to save. Press Escape to cancel. The same cues are available as a paginated list in the Captions tab, with separate English and Persian track buttons.

Source soft subtitles are **off by default**. New imports keep embedded subtitle tracks available in the selector but do not select, burn, or display them automatically. Enable **Use the video's original soft subtitles** to keep the embedded text track in the preview and export; rendered MP4s then contain a `mov_text` soft track instead of burned-in captions. If the browser cannot expose the source track, the export still carries it.

## SOCKS5 downloads

In **New project → Video link** or **YouTube**, enable **Use SOCKS5 proxy** and enter its hostname/IP address and port (usually 1080). Username and password are optional. **Save proxy** stores the connection for future downloads; starting a proxied download also saves it. Keep the checkbox off to connect directly.

Passwords are encrypted and never returned to the browser. Leaving the password blank retains it only for the same host, port and username. Use **Clear saved password** to remove authentication or **Remove saved proxy** to delete the profile. Each queued job retains an encrypted snapshot, so changes apply to new downloads; existing jobs and retries keep their original connection.

Video hostnames are resolved and validated locally, then public IP addresses are sent through SOCKS5. Redirects use the same proxy and retain signed query parameters. HTTPS certificate verification and the original hostname are preserved. The proxy must be reachable from the application; in Docker, `localhost` refers to the application container. Remote proxy DNS (`socks5h`), proxy chains and HTTP proxies are not supported. These settings apply to URL and YouTube imports, not Telegram uploads or browser playback.

## YouTube imports

Use **New project → YouTube** to paste a single public YouTube video, Shorts, or youtu.be link. The server downloads it with [yt-dlp](https://github.com/yt-dlp/yt-dlp) into the same source pipeline as a direct URL, so trimming, subtitles, rendering, and storage limits behave identically. Playlists, channels, live or upcoming streams, and links from other sites are rejected. The imported project is named after the video title unless you enter a name.

Imports use the same yt-dlp tuning as the Telegram bot: parallel fragment downloads, larger HTTP chunks, and long retry budgets. The first attempt presents a real Chrome TLS fingerprint through `curl-cffi` (installed with the backend requirements). If YouTube still answers with a bot check, the importer retries with the cookie-free player clients the bot uses and finally with yt-dlp's plain defaults, so no cookies are required for public videos. YouTube can still block the whole network, especially datacenter IPs; in that case enable the SOCKS5 proxy or export a Netscape-format `cookies.txt` and point `YTDLP_COOKIES_FILE` at it in `.env` before starting the application. Keep that file private and mount it read-only; it grants access to the account's YouTube session. The downloader does not read browser cookies automatically.

## Telegram

Exports use H.264 video with `yuv420p` pixels, AAC audio when present, and fast-start MP4 packaging. Each render is checked for compatibility. Muted clips are sent as playable videos rather than animated GIFs.

Choose a Telegram cover before rendering under **Advanced → Clip → Telegram cover**. Scrub to a frame and click **Use current frame**, or generate six evenly spaced candidates from the current clip. The chosen source frame is cropped to the output frame and saved from the original video, so burned-in captions never appear in the cover. The next render attaches that frame to the exported clip. If no frame is selected, the post-render cover still includes captions, crop, and watermark.

Open a rendered clip from **Rendered clips** or the editor's recent renders to make a last-minute cover change. Under **Telegram cover**, pause/scrub the video or enter **Preview frame (seconds)**, then click **Use current frame**. Choose **Automatic frame** to return to the default frame near the beginning. Cover changes do not require rendering the video again and apply to future sends. Existing exports receive automatic covers during startup. Wait for the cover job to finish before sending.

Playable videos include both Telegram's dedicated video cover and a small JPEG thumbnail for client compatibility. **Send as a file** attaches the thumbnail and retains document behavior. A cover changes the video's poster, not its playback starting position. Telegram clients control how covers are displayed.

Create a bot with [@BotFather](https://t.me/BotFather) and an API application at [my.telegram.org](https://my.telegram.org/apps). In **Settings → Telegram**, save the API ID, API hash, and bot token. The bot authenticates automatically, so no phone number, login code, or personal account is used. The API ID and hash let the bot upload over MTProto, which raises the 20 MB Bot API limit to 2 GB.

Add the bot to each target channel as an administrator with **Post messages** permission, then add the channel under **Channels** using its `@username`, `t.me` link, or numeric ID. The check confirms the bot is an administrator and can post; broken permissions are shown per channel and can be re-verified.

The bot token, API credentials, and cached bot session are encrypted with the installation's persistent key. Saved secrets are never returned to the browser. Posts are sent only from a rendered clip's **Post to Telegram** panel with a channel choice and video/file format. Telegram rate limits and upload failures are shown in Activity. Review Telegram before retrying an interrupted send: it may already have completed.

For a test delivery, turn off **Send to channel** on the publish step and enter a numeric chat ID. To get that ID, send `/chatid` to the bot in a private chat, or send it in a group where the bot is a member; the bot replies with the marked chat ID (`-100…` for supergroups and channels). Test deliveries skip channel configuration and go straight to that chat, so the bot only needs permission to message it.

The caption field uses the bundled Telegram HTML editor: bold, italic, underline, strike, spoiler, code, quotes, links, mentions, custom emoji, date/time, a live preview, and a 1,024-character counter. **Auto caption** sends the clip's English and Persian subtitle cues to the 9Router model using the system prompt saved in **Settings → Auto subtitles & captions**. The built-in prompt returns the title, release year, IMDb rating, and a Persian scene description; replace the prompt to control the exact caption format. The result opens in the caption editor for review before posting. Create auto subtitles or upload a subtitle track first if the clip has none.

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

Store backups securely outside the deployment volume. A backup contains account sessions and credentials. Preserve **both** `data/` and `.env`, especially `data/encryption.key`; losing the key makes encrypted settings, the Telegram bot session, and queued job payloads unreadable. Restore only trusted backups.

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
