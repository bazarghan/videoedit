# Security

VideoEdit handles private media and Telegram account sessions. Keep installations current, expose the application through HTTPS, use a unique administrator password, and restrict filesystem access to the persistent data directory. Do not share backups, encryption keys, `.env`, database files, or Telegram sessions.

Administrator authentication protects all media and application APIs except login and the minimal health endpoint. Cookies are HTTP-only and SameSite Strict, and secure by default. Mutation requests with an unrecognized browser origin are rejected. This is a single-administrator application, without tenant isolation or public uploads.

The downloader permits public HTTP/HTTPS media URLs and validates each redirect and DNS answer. Uploaded sources require recognized container signatures; FFmpeg and ffprobe are restricted to local file/pipe protocols. These controls reduce exposure but do not replace keeping FFmpeg, Python dependencies, and Docker updated. Treat imported media as untrusted and retain the container's unprivileged user, read-only application filesystem, resource limits, and dropped capabilities.

To report a suspected vulnerability, use the repository's private vulnerability reporting feature when available. Avoid disclosing secrets or publishing a working exploit in a public issue before maintainers can respond.
