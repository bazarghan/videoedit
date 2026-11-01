import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";
import classWorkerURL from "@ffmpeg/ffmpeg/worker?worker&url";
import type { Edit, Metadata } from "@/types";

const CORE_BASE = "/ffmpeg";
const CORE_URL = `${CORE_BASE}/ffmpeg-core.js`;
const CORE_WASM = `${CORE_BASE}/ffmpeg-core.wasm`;

/** Codecs the bundled ffmpeg.wasm core cannot decode. */
const UNSUPPORTED_CODECS = new Set(["av1", "vvc", "h266"]);

export function isBrowserCodecSupported(codec?: string | null) {
  return !codec || !UNSUPPORTED_CODECS.has(codec.toLowerCase());
}

export function browserCodecError(codec?: string | null) {
  const name = (codec || "").toUpperCase();
  return `${name ? `کدک ${name}` : "این فایل"} را موتور رندر مرورگر (ffmpeg.wasm) نمی‌تواند دیکد کند. برای این فایل از «بارگذاری فایل» استفاده کنید تا روی سرور رندر شود، یا ویدیو را به H.264 تبدیل کنید.`;
}

const TEXT_SUBS = new Set([
  "subrip",
  "ass",
  "ssa",
  "mov_text",
  "webvtt",
  "text",
]);
const INPUT_DIR = "/input";
const WORK_DIR = "/work";
const FONT_DIR = "/fonts";
const ASSET_DIR = "/assets";
const OUTPUT = "/output.mp4";

let instance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;
let queue: Promise<unknown> = Promise.resolve();

export type RenderPlan = {
  args: string[];
  input_placeholder: string;
  output: string;
  duration: number;
  width: number;
  height: number;
  files: { path: string; content: string }[];
  assets: { path: string; url: string }[];
  fonts: { path: string; url: string }[];
  signature: string;
  preview: boolean;
};

/**
 * The threaded core deadlocks during exec() in Chrome, so the browser always
 * uses the portable build. Keeping encoding single-threaded avoids a render
 * that never finishes; the ffmpeg args stay identical either way.
 */
export function engineThreads() {
  return 1;
}

let coreBlob: Promise<string> | null = null;

/**
 * Vite rewrites dynamic imports of public files and refuses to transform them.
 * Loading the core through a blob URL keeps it out of the bundler's graph.
 */
function coreModuleURL() {
  if (!coreBlob) {
    coreBlob = fetch(CORE_URL)
      .then((response) => {
        if (!response.ok) throw new Error("ffmpeg core could not be loaded.");
        return response.text();
      })
      .then((code) =>
        URL.createObjectURL(new Blob([code], { type: "text/javascript" })),
      )
      .catch((error) => {
        coreBlob = null;
        throw error;
      });
  }
  return coreBlob;
}

export function ffmpegEngine(): Promise<FFmpeg> {
  if (instance?.loaded) return Promise.resolve(instance);
  if (!loading) {
    loading = (async () => {
      const ff = new FFmpeg();
      await ff.load({
        coreURL: await coreModuleURL(),
        wasmURL: CORE_WASM,
        classWorkerURL,
      });
      instance = ff;
      return ff;
    })().catch((error) => {
      loading = null;
      throw error;
    });
  }
  return loading;
}

export function terminateEngine() {
  instance?.terminate();
  instance = null;
  loading = null;
}

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function ensureDir(ff: FFmpeg, path: string) {
  try {
    await ff.createDir(path);
  } catch {
    // Already present.
  }
}

async function mountInput(ff: FFmpeg, file: File) {
  // A cancelled render can leave the previous mount behind.
  await unmountInput(ff);
  return ff.mount(FFFSType.WORKERFS, { files: [file] }, INPUT_DIR);
}

async function unmountInput(ff: FFmpeg) {
  try {
    await ff.unmount(INPUT_DIR);
  } catch {
    // The mount may already be gone after a cancelled run.
  }
}

function inputPath(file: File) {
  return `${INPUT_DIR}/${file.name}`;
}

function parseRate(value?: string) {
  if (!value || value === "0/0") return 0;
  const [a, b] = value.split("/").map(Number);
  const rate = b ? a / b : Number(value);
  return Number.isFinite(rate) ? rate : 0;
}

async function containerInfo(file: File, formatName: string, brand: string) {
  const header = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  const ebml =
    header[0] === 0x1a &&
    header[1] === 0x45 &&
    header[2] === 0xdf &&
    header[3] === 0xa3;
  const webm =
    ebml &&
    header.some(
      (_, index) =>
        header[index] === 0x42 &&
        header[index + 1] === 0x82 &&
        header[index + 2] === 0x84 &&
        header[index + 3] === 0x77 &&
        header[index + 4] === 0x65 &&
        header[index + 5] === 0x62 &&
        header[index + 6] === 0x6d,
    );
  if (webm) return "webm";
  if (formatName.split(",").includes("mp4") && brand.trim() !== "qt")
    return "mp4";
  return null;
}

function shapeMetadata(
  data: any,
  file: File,
  container: string | null,
): LocalMetadata {
  const streams: any[] = data.streams || [];
  const video = streams.find(
    (stream) =>
      stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  let width = Number(video?.width || 0);
  let height = Number(video?.height || 0);
  const rotation = Number(
    video?.side_data_list?.find((item: any) => "rotation" in item)?.rotation ||
      0,
  );
  if (Math.round(Math.abs(rotation)) % 180 === 90) {
    [width, height] = [height, width];
  }
  const duration = Number(data.format?.duration || 0) || 0;
  const audio = streams
    .filter((stream) => stream.codec_type === "audio")
    .map((stream) => ({
      index: Number(stream.index),
      codec: (stream.codec_name || "unknown").slice(0, 40),
      language: (stream.tags?.language || "").slice(0, 80),
      title: (stream.tags?.title || "").slice(0, 200),
    }));
  const subtitles = streams
    .filter((stream) => stream.codec_type === "subtitle")
    .map((stream) => ({
      index: Number(stream.index),
      codec: (stream.codec_name || "unknown").slice(0, 40),
      language: (stream.tags?.language || "").slice(0, 80),
      title: (stream.tags?.title || "").slice(0, 200),
      editable: TEXT_SUBS.has(stream.codec_name || ""),
    }));
  return {
    duration,
    size: file.size,
    width,
    height,
    video_codec: (video?.codec_name || "").slice(0, 40),
    pixel_format: (video?.pix_fmt || "").slice(0, 40) || null,
    browser_container: container,
    video_codec_tag: (video?.codec_tag_string || "").slice(0, 20) || null,
    video_duration: Number(video?.duration || duration) || duration,
    fps: parseRate(video?.avg_frame_rate),
    format: (data.format?.format_name || "").slice(0, 200),
    audio,
    subtitles,
  };
}

export type LocalMetadata = Metadata & {
  format: string;
  fps: number;
  video_duration: number;
  subtitles: {
    index: number;
    codec: string;
    language: string;
    title: string;
    editable: boolean;
  }[];
};

/** Read the same source metadata the server would collect with ffprobe. */
export function probeLocalFile(file: File): Promise<LocalMetadata> {
  return exclusive(async () => {
    const ff = await ffmpegEngine();
    await ensureDir(ff, INPUT_DIR);
    await mountInput(ff, file);
    const coverLogs: string[] = [];
    const logger = ({ message }: { message: string }) => {
      coverLogs.push(message);
      if (coverLogs.length > 400) coverLogs.shift();
    };
    ff.on("log", logger);
    try {
      const result = "/probe.json";
      await ff.deleteFile(result).catch(() => {});
      await ff.ffprobe(
        [
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          inputPath(file),
          "-o",
          result,
        ],
        -1,
      );
      const raw = await ff.readFile(result, "utf8");
      const data = JSON.parse(typeof raw === "string" ? raw : "{}");
      await ff.deleteFile(result).catch(() => {});
      const brand = data.format?.tags?.major_brand || "";
      return shapeMetadata(
        data,
        file,
        await containerInfo(file, data.format?.format_name || "", brand),
      );
    } catch (error) {
      throw new Error(
        `این فایل با موتور ffmpeg خوانده نشد. ${lastMeaningfulLog(coverLogs) || ""}`.trim(),
      );
    } finally {
      ff.off("log", logger);
      await unmountInput(ff);
    }
  });
}

function lastMeaningfulLog(logs: string[]) {
  return logs
    .filter(
      (entry) =>
        entry &&
        !entry.startsWith("frame=") &&
        !entry.startsWith("fps=") &&
        !entry.startsWith("bitrate=") &&
        !entry.startsWith("total_size=") &&
        !entry.startsWith("out_time") &&
        !entry.startsWith("dup_frames") &&
        !entry.startsWith("drop_frames") &&
        !entry.startsWith("speed=") &&
        !entry.startsWith("progress=") &&
        !entry.includes("Press [q]"),
    )
    .slice(-3)
    .join(" ")
    .trim();
}

async function writePlanFiles(ff: FFmpeg, plan: RenderPlan) {
  await ensureDir(ff, WORK_DIR);
  await ensureDir(ff, FONT_DIR);
  await ensureDir(ff, ASSET_DIR);
  for (const file of plan.files) {
    await ff.writeFile(file.path, new TextEncoder().encode(file.content));
  }
  for (const asset of [...plan.assets, ...plan.fonts]) {
    const response = await fetch(asset.url, { credentials: "same-origin" });
    if (!response.ok) {
      throw new Error("یکی از فایل‌های کمکی رندر دانلود نشد.");
    }
    await ff.writeFile(
      asset.path,
      new Uint8Array(await response.arrayBuffer()),
    );
  }
}

async function readImage(ff: FFmpeg, path: string) {
  const data = await ff.readFile(path);
  await ff.deleteFile(path).catch(() => {});
  const bytes = data instanceof Uint8Array ? data : new Uint8Array();
  const blob = new Blob([bytes as unknown as BlobPart], { type: "image/jpeg" });
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("فریم استخراج‌شده خوانده نشد."));
    reader.readAsDataURL(blob);
  });
}

function dimensions(metadata: LocalMetadata, edit: Edit) {
  const ratio =
    edit.crop.ratio === "original"
      ? metadata.width / metadata.height
      : Number(edit.crop.ratio.split(":")[0]) /
        Number(edit.crop.ratio.split(":")[1]);
  const longest = edit.resolution;
  const [w, h] =
    ratio >= 1
      ? [longest, Math.round(longest / ratio / 2) * 2]
      : [Math.round((longest * ratio) / 2) * 2, longest];
  return [Math.max(2, w), Math.max(2, h)] as const;
}

function frameFilter(metadata: LocalMetadata, edit: Edit) {
  const [w, h] = dimensions(metadata, edit);
  const crop = edit.crop;
  const vf =
    crop.mode === "fill"
      ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-ow)*${crop.x}:(ih-oh)*${crop.y},setsar=1`
      : `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${w}:${h}:(ow-iw)*${crop.x}:(oh-ih)*${crop.y}:black,setsar=1`;
  return { w, h, vf };
}

async function extractFrame(
  file: File,
  time: number,
  filter: string,
  quality: number,
) {
  const ff = await ffmpegEngine();
  await ensureDir(ff, INPUT_DIR);
  await mountInput(ff, file);
  const output = "/frame.jpg";
  try {
    await ff.deleteFile(output).catch(() => {});
    const code = await ff.exec(
      [
        "-hide_banner",
        "-v",
        "error",
        "-y",
        "-ss",
        String(Math.max(0, time)),
        "-i",
        inputPath(file),
        "-frames:v",
        "1",
        "-vf",
        filter,
        "-q:v",
        String(quality),
        "-threads",
        "1",
        output,
      ],
      -1,
    );
    if (code !== 0) throw new Error("فریم انتخاب‌شده خوانده نشد.");
    return await readImage(ff, output);
  } finally {
    await unmountInput(ff);
  }
}

export function projectThumbnail(file: File, metadata: LocalMetadata) {
  return exclusive(() =>
    extractFrame(file, Math.min(1, metadata.duration / 2), "scale=640:-2", 5),
  );
}

export function cleanCoverFrame(
  file: File,
  time: number,
  metadata: LocalMetadata,
  edit: Edit,
) {
  const { vf } = frameFilter(metadata, edit);
  return exclusive(() =>
    extractFrame(
      file,
      time,
      `${vf},scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,setsar=1`,
      6,
    ),
  );
}

export function coverCandidates(
  file: File,
  times: number[],
  metadata: LocalMetadata,
  edit: Edit,
) {
  const { vf } = frameFilter(metadata, edit);
  return exclusive(async () => {
    const result: { time: number; url: string }[] = [];
    for (const time of times) {
      result.push({
        time: Math.round(time * 1000) / 1000,
        url: await extractFrame(
          file,
          time,
          `${vf},scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease,setsar=1`,
          5,
        ),
      });
    }
    return result;
  });
}

/** Extract only the selected range as a small mono MP3 for transcription. */
export function extractClipAudio(file: File, start: number, duration: number) {
  return exclusive(async () => {
    const ff = await ffmpegEngine();
    await ensureDir(ff, INPUT_DIR);
    await mountInput(ff, file);
    const output = "/audio.mp3";
    try {
      await ff.deleteFile(output).catch(() => {});
      const code = await ff.exec(
        [
          "-hide_banner",
          "-v",
          "error",
          "-y",
          "-ss",
          String(Math.max(0, start)),
          "-i",
          inputPath(file),
          "-t",
          String(Math.max(0.1, duration)),
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "libmp3lame",
          "-b:a",
          "64k",
          output,
        ],
        -1,
      );
      if (code !== 0) throw new Error("صدای این بازه استخراج نشد.");
      const data = await ff.readFile(output);
      return data instanceof Uint8Array ? data : new Uint8Array();
    } finally {
      await ff.deleteFile(output).catch(() => {});
      await unmountInput(ff);
    }
  });
}

export type RenderProgress = {
  phase: "preparing" | "rendering" | "uploading";
  progress: number;
};

export async function renderLocalClip({
  projectId,
  file,
  plan,
  edit,
  onProgress,
  signal,
}: {
  projectId: string;
  file: File;
  plan: RenderPlan;
  edit: Edit;
  onProgress: (state: RenderProgress) => void;
  signal?: AbortSignal;
}) {
  return exclusive(async () => {
    onProgress({ phase: "preparing", progress: 0 });
    const ff = await ffmpegEngine();
    await ensureDir(ff, INPUT_DIR);
    await writePlanFiles(ff, plan);
    await mountInput(ff, file);
    const logs: string[] = [];
    const logger = ({ message }: { message: string }) => {
      logs.push(message);
      if (logs.length > 300) logs.shift();
    };
    const progress = ({ progress: value }: { progress: number }) => {
      onProgress({
        phase: "rendering",
        progress: Math.max(0, Math.min(1, Number(value) || 0)),
      });
    };
    ff.on("log", logger);
    ff.on("progress", progress);
    const args = plan.args.map((arg) =>
      arg === plan.input_placeholder ? inputPath(file) : arg,
    );
    try {
      await ff.deleteFile(OUTPUT).catch(() => {});
      const code = await ff.exec(args, -1, { signal });
      if (code !== 0) {
        throw new Error(
          `رندر در مرورگر متوقف شد. ${lastMeaningfulLog(logs) || ""}`.trim(),
        );
      }
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const data = await ff.readFile(plan.output);
      const bytes = data instanceof Uint8Array ? data : new Uint8Array();
      await ff.deleteFile(plan.output).catch(() => {});
      onProgress({ phase: "uploading", progress: 0 });
      const clip = await uploadClip(
        projectId,
        bytes,
        edit,
        plan.preview,
        (value) => onProgress({ phase: "uploading", progress: value }),
        signal,
      );
      return clip;
    } finally {
      ff.off("log", logger);
      ff.off("progress", progress);
      await unmountInput(ff);
      for (const file of plan.files) {
        await ff.deleteFile(file.path).catch(() => {});
      }
      for (const item of [...plan.assets, ...plan.fonts]) {
        await ff.deleteFile(item.path).catch(() => {});
      }
    }
  });
}

function uploadClip(
  projectId: string,
  bytes: Uint8Array,
  edit: Edit,
  preview: boolean,
  onProgress: (value: number) => void,
  signal?: AbortSignal,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes as unknown as BlobPart], { type: "video/mp4" }),
      "clip.mp4",
    );
    form.append("edit", JSON.stringify(edit));
    form.append("preview", String(preview));
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal?.addEventListener("abort", abort, { once: true });
    xhr.open("POST", `/api/projects/${projectId}/clips`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onabort = () => {
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    xhr.onerror = () => {
      signal?.removeEventListener("abort", abort);
      reject(new Error("آپلود کلیپ رندرشده قطع شد. دوباره تلاش کنید."));
    };
    xhr.onload = () => {
      signal?.removeEventListener("abort", abort);
      let data: any = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = {};
      }
      if (xhr.status >= 400) {
        reject(
          new Error(
            typeof data.detail === "string"
              ? data.detail
              : "کلیپ رندرشده ذخیره نشد.",
          ),
        );
        return;
      }
      resolve(data);
    };
    xhr.send(form);
  });
}
