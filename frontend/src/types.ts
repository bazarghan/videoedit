export type Cue = { start: number; end: number; text: string };
export type WatermarkText = {
  text: string;
  font_family: string;
  font_size: number;
  bold: boolean;
  color: string;
  opacity: number;
  alignment: "left" | "center" | "right";
};
export type WatermarkTemplate = {
  rows: WatermarkText[][];
  gap_horizontal: number;
  gap_vertical: number;
  border_color: string;
  border_thickness: number;
  decay_time: number;
  replication_count: number;
  repeat: boolean;
};
export type Edit = {
  start: number;
  end: number;
  subtitles: {
    track_id: string;
    fa_track_id: string;
    burn: boolean;
    preserve_ass: boolean;
    soft: boolean;
    font: string;
    size: number;
    bold: boolean;
    color: string;
    outline_color: string;
    outline: number;
    shadow: number;
    fa_font: string;
    fa_size: number;
    fa_bold: boolean;
    fa_color: string;
    fa_outline_color: string;
    fa_outline: number;
    fa_shadow: number;
    gap: number;
    box: boolean;
    box_opacity: number;
    position: string;
    align: string;
    margin: number;
    offset: number;
  };
  crop: { ratio: string; mode: string; x: number; y: number };
  watermark: {
    kind: string;
    template: WatermarkTemplate | null;
    text: string;
    asset_id: string;
    x: number;
    y: number;
    size: number;
    width: number;
    opacity: number;
    margin: number;
    color: string;
    font: string;
    start: number;
    end: number | null;
  };
  audio: {
    track: number;
    mute: boolean;
    volume: number;
    music_id: string;
    music_volume: number;
    fade_in: number;
    fade_out: number;
  };
  resolution: number;
  fps: number;
  quality: string;
  filename: string;
};
export type Metadata = {
  duration: number;
  width: number;
  height: number;
  size: number;
  video_codec: string;
  telegram_compatible?: boolean;
  cover?: {
    time: number;
    mode: "auto" | "manual";
    revision: string;
    origin?: "render" | "prerender";
    source_time?: number;
  };
  cover_frame?: { time: number; revision: string };
  caption_context?: {
    start: number;
    end: number;
    track_id?: string;
    fa_track_id?: string;
  };
  audio: { index: number; codec: string; language: string; title: string }[];
  subtitles: unknown[];
};
export type ProjectDefaults = {
  subtitles: Omit<Edit["subtitles"], "track_id" | "fa_track_id">;
  watermark: Edit["watermark"];
};
export type Project = {
  id: string;
  name: string;
  status: string;
  created: number;
  metadata: Metadata;
  edit: Edit;
  has_source: boolean;
  has_thumbnail: boolean;
  rendered?: boolean;
  subtitles?: {
    id: string;
    title: string;
    language: string;
    codec: string;
    editable: number;
    role?: string;
    origin?: string;
  }[];
  assets?: { id: string; kind: string; name: string }[];
};
export type Job = {
  id: string;
  kind: string;
  project_id: string;
  status: string;
  progress: number;
  bytes: number;
  speed: number;
  error: string | null;
  created: number;
  elapsed: number;
  eta: number | null;
  result_id: string | null;
};
export type Clip = {
  id: string;
  project_id: string;
  name: string;
  metadata: Metadata;
  created: number;
  preview: boolean;
  has_cover: boolean;
};
export type TelegramChannel = {
  id: string;
  name: string;
  username: string;
  verified: number;
  error: string;
};
export type Settings = {
  project_defaults: ProjectDefaults;
  telegram: {
    api_id: number | string;
    api_hash_saved: boolean;
    bot_token_saved: boolean;
    default_channel: string;
    channels: TelegramChannel[];
  };
  telegram_status: {
    connected: boolean;
    configured?: boolean;
    name?: string;
    username?: string;
    error?: string;
  };
  storage: {
    used: number;
    free: number;
    limit_gb: number;
    categories: Record<string, number>;
  };
  ai: {
    base_url: string;
    model: string;
    caption_prompt: string;
    api_key_saved: boolean;
  };
  elevenlabs: {
    model: string;
    max_duration_minutes: number;
    api_key_saved: boolean;
  };
};
export type DownloadProxy = {
  host: string;
  port: number;
  username: string;
  password_saved: boolean;
};
export type DownloadProxyDraft = DownloadProxy & {
  password: string;
  clear_password: boolean;
};
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch("/api" + path, {
    ...options,
    headers:
      options.body instanceof FormData
        ? options.headers
        : { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "درخواست انجام نشد. دوباره تلاش کنید." }));
    throw new Error(
      typeof error.detail === "string"
        ? error.detail
        : "ورودی‌ها را بررسی کنید و دوباره تلاش کنید.",
    );
  }
  return response.json();
}
export const json = (method: string, body?: unknown) => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});
export function size(bytes: number = 0) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
export function clock(seconds: number = 0) {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ":" : ""}${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}
export function timecode(seconds: number = 0) {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const secs = total % 60;
  const base = `${String(minutes).padStart(2, "0")}:${secs.toFixed(3).padStart(6, "0")}`;
  return hours ? `${hours}:${base}` : base;
}
export const fonts: [string, string][] = [
  ["Arial", "Arial"],
  ["Vazirmatn", "Vazirmatn"],
  ["Shabnam", "Shabnam"],
  ["Sahel", "Sahel"],
  ["IRANYekanWeb", "IRAN Yekan"],
  ["IRANYekanWeb ExtraBold", "IRAN Yekan ExtraBold"],
  ["DejaVu Sans", "DejaVu Sans"],
  ["DejaVu Serif", "DejaVu Serif"],
  ["Liberation Sans", "Liberation Sans"],
  ["Liberation Serif", "Liberation Serif"],
  ["Noto Sans Arabic", "Noto Sans Arabic"],
];
