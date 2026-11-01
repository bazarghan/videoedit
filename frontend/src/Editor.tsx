import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Play,
  Pause,
  Maximize,
  Minimize,
  Volume2,
  Repeat,
  Scissors,
  Type,
  Frame,
  Music,
  Stamp,
  Download,
  LoaderCircle,
  Check as CheckIcon,
  ChevronDown,
  ChevronLeft,
  Copy,
  X,
  Move,
  Upload,
  ArrowUpRight,
  Save,
  ZoomIn,
  ZoomOut,
  Scan,
  Sparkles,
  FileText,
  Languages,
  LayoutTemplate,
  Sliders,
  CornerUpLeft,
  CornerUpRight,
  CornerDownLeft,
  CornerDownRight,
  Crosshair,
} from "lucide-react";
import {
  api,
  json,
  clock,
  timecode,
  Project,
  Job,
  Clip,
  Edit,
  Cue,
  fonts,
} from "./types";
import WatermarkTemplateEditor from "./WatermarkTemplate";
import { templateFromLegacy, watermarkVisibleAt } from "./watermark";
import {
  cleanCoverFrame,
  coverCandidates as extractCoverCandidates,
  engineThreads,
  extractClipAudio,
  renderLocalClip,
  type LocalMetadata,
  type RenderPlan,
  type RenderProgress,
  terminateEngine,
} from "./lib/ffmpegEngine";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Slider as RangeSlider } from "./components/ui/slider";
import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";

const MIN_CLIP = 0.001;
const MAX_ZOOM = 1000;
const TICK_STEPS = [
  0.001, 0.002, 0.0025, 0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1,
  2, 2.5, 5, 10, 15, 25, 30, 45, 60, 90, 120, 180, 300, 600, 900, 1800, 3600,
];

const TOOL_TABS = [
  { id: "clip", icon: Scissors, label: "برش" },
  { id: "subtitles", icon: Type, label: "زیرنویس" },
  { id: "crop", icon: Frame, label: "قاب" },
  { id: "watermark", icon: Stamp, label: "واترمارک" },
  { id: "audio", icon: Music, label: "صدا" },
  { id: "export", icon: Download, label: "خروجی" },
] as const;

type ToolId = (typeof TOOL_TABS)[number]["id"];

function snapMs(value: number) {
  return Math.round(value * 1000) / 1000;
}

function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableKey((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function padTime(value: number, size = 2) {
  return String(Math.max(0, value)).padStart(size, "0");
}

function srtTimestamp(value: number) {
  const total = Math.max(0, Math.round(value * 1000));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${padTime(hours)}:${padTime(minutes)}:${padTime(seconds)},${padTime(millis, 3)}`;
}

function cuesToSrt(cues: Cue[]) {
  return cues
    .map(
      (cue, index) =>
        `${index + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}\n${cue.text.trim()}\n`,
    )
    .join("\n");
}

const SRT_TIME_PATTERN = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/g;

function srtMatchToSeconds(match: RegExpMatchArray) {
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4].padEnd(3, "0").slice(0, 3));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function parseSrt(text: string): Cue[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const timed: { line: number; start: number; end: number }[] = [];

  lines.forEach((line, lineIndex) => {
    const times = [...line.matchAll(SRT_TIME_PATTERN)];
    if (times.length < 2) return;
    const start = srtMatchToSeconds(times[0]);
    const end = srtMatchToSeconds(times[1]);
    if (end > start) timed.push({ line: lineIndex, start, end });
  });

  return timed.flatMap((entry, timedIndex) => {
    const nextLine =
      timedIndex + 1 < timed.length ? timed[timedIndex + 1].line : lines.length;
    const body = lines.slice(entry.line + 1, nextLine);
    while (body.length && !body[0].trim()) body.shift();
    while (body.length && !body[body.length - 1].trim()) body.pop();
    // Tolerate SRT output without blank lines between cues: drop the numeric
    // cue index that belongs to the next timestamp line, not to this text.
    if (
      timedIndex + 1 < timed.length &&
      body.length &&
      /^\d+$/.test(body[body.length - 1].trim())
    )
      body.pop();
    const value = body.join("\n").trim();
    return value ? [{ start: entry.start, end: entry.end, text: value }] : [];
  });
}

function tickStepForSpan(span: number) {
  const raw = Math.max(0.001, span / 8);
  return TICK_STEPS.find((step) => step >= raw) ?? 3600;
}

function tickLabel(value: number, step: number) {
  const decimals =
    step >= 1 ? 0 : Math.min(3, Math.max(0, Math.ceil(-Math.log10(step))));
  const total = Math.max(0, value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = (total % 60)
    .toFixed(decimals)
    .padStart(decimals ? decimals + 3 : 2, "0");
  const label = `${String(minutes).padStart(2, "0")}:${seconds}`;
  return hours ? `${hours}:${label}` : label;
}

type CoverCandidate = { time: number; url: string };

type Props = {
  id: string;
  jobs: Job[];
  clips: Clip[];
  localFile?: File;
  onLocalFile: (file: File) => void;
  autoSubtitleLimitMinutes?: number;
  onError: (s: string) => void;
  toast: (s: string) => void;
  onClip: (c: Clip) => void;
  onQueue: () => void;
};
export default function Editor({
  id,
  jobs,
  clips,
  localFile,
  onLocalFile,
  autoSubtitleLimitMinutes = 6,
  onError,
  toast,
  onClip,
  onQueue,
}: Props) {
  const [project, setProject] = useState<Project | null>(null),
    [edit, setEdit] = useState<Edit | null>(null),
    [cuesByTrack, setCuesByTrack] = useState<Record<string, Cue[]>>({}),
    [editingCue, setEditingCue] = useState<{
      trackId: string;
      index: number;
    } | null>(null),
    [tab, setTab] = useState<ToolId>("clip"),
    [savedEditKey, setSavedEditKey] = useState(""),
    [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [fullscreen, setFullscreen] = useState(false),
    [loop, setLoop] = useState(false),
    [volume, setVolume] = useState(1),
    [speed, setSpeed] = useState(1),
    [saving, setSaving] = useState(false),
    [savingDefaults, setSavingDefaults] = useState(false),
    [saved, setSaved] = useState(false),
    [height, setHeight] = useState(450),
    [frameWidth, setFrameWidth] = useState(800),
    [cropDrag, setCropDrag] = useState(false),
    [busy, setBusy] = useState(false),
    [autoStarting, setAutoStarting] = useState(false),
    [coverCandidates, setCoverCandidates] = useState<CoverCandidate[]>([]),
    [coverBusy, setCoverBusy] = useState(false),
    [playbackFailed, setPlaybackFailed] = useState(false),
    [stageHeight, setStageHeight] = useState(450),
    [wmBox, setWmBox] = useState({ width: 100, height: 30 }),
    [zoom, setZoom] = useState(1),
    [timelineWidth, setTimelineWidth] = useState(0),
    [scrollLeft, setScrollLeft] = useState(0),
    [bulkRole, setBulkRole] = useState<"main" | "fa">("main"),
    [bulkText, setBulkText] = useState(""),
    [bulkSaving, setBulkSaving] = useState(false),
    [refine, setRefine] = useState<{ start: number; end: number } | null>(null);
  const video = useRef<HTMLVideoElement>(null),
    music = useRef<HTMLAudioElement>(null),
    frame = useRef<HTMLDivElement>(null),
    watermark = useRef<HTMLDivElement>(null),
    videoShell = useRef<HTMLDivElement>(null),
    stage = useRef<HTMLDivElement>(null),
    timeline = useRef<HTMLDivElement>(null),
    timelineScroll = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const zoomAnchor = useRef<{ time: number; x: number } | null>(null);
  const autoSubtitleRef = useRef("");
  const renderJobRef = useRef("");
  const cancelCueEditRef = useRef(false);
  const inlineEditorRef = useRef<HTMLSpanElement>(null);
  const duration = project?.metadata.duration || 0;
  const local = !!project?.metadata.local;
  const localReady = local && !!localFile;
  const canRender = local ? localReady : !!project?.has_source;
  const [localRender, setLocalRender] = useState<RenderProgress | null>(null);
  const localAbort = useRef<AbortController | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  useEffect(() => {
    if (!localFile) {
      setSourceUrl("");
      return;
    }
    const url = URL.createObjectURL(localFile);
    setSourceUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setSourceUrl("");
    };
  }, [localFile]);
  useEffect(() => {
    return () => {
      if (localAbort.current) {
        localAbort.current.abort();
        terminateEngine();
      }
    };
  }, [id]);
  const rangeStart = refine ? refine.start : 0;
  const rangeEnd = refine ? refine.end : duration;
  const rangeSpan = Math.max(MIN_CLIP, rangeEnd - rangeStart);
  const tickStep = tickStepForSpan(rangeSpan / zoom);
  const timelineTicks = useMemo(() => {
    if (!duration) return [] as number[];
    const visible = rangeSpan / zoom;
    const contentWidth = timelineWidth * zoom;
    const startTime =
      contentWidth > 0
        ? Math.min(
            rangeEnd,
            rangeStart + (scrollLeft / contentWidth) * rangeSpan,
          )
        : rangeStart;
    const endTime = Math.min(rangeEnd, startTime + visible);
    const first = Math.max(
      rangeStart,
      rangeStart + Math.floor((startTime - rangeStart) / tickStep) * tickStep,
    );
    const last = Math.min(rangeEnd, endTime + tickStep * 0.5);
    const ticks: number[] = [];
    for (
      let tick = first;
      tick <= last + 1e-9 && ticks.length < 40;
      tick += tickStep
    ) {
      ticks.push(tick);
    }
    return ticks;
  }, [
    duration,
    zoom,
    tickStep,
    scrollLeft,
    timelineWidth,
    rangeStart,
    rangeEnd,
    rangeSpan,
  ]);
  const active = jobs.filter(
    (j) => j.project_id === id && ["queued", "running"].includes(j.status),
  );
  const autoSubtitleJob = jobs.find(
    (j) =>
      j.project_id === id &&
      j.kind === "autosubtitle" &&
      ["queued", "running"].includes(j.status),
  );
  const lastAutoSubtitleJob = jobs.find(
    (j) => j.project_id === id && j.kind === "autosubtitle",
  );
  const autoSubtitlesReady =
    !!project?.subtitles?.some((track) => track.origin === "auto") &&
    (!lastAutoSubtitleJob ||
      !["failed", "cancelled"].includes(lastAutoSubtitleJob.status));
  const autoSubtitleSpan =
    local && edit ? Math.max(0, edit.end - edit.start) : duration;
  const autoSubtitleTooLong =
    autoSubtitleSpan > autoSubtitleLimitMinutes * 60 + 0.5;
  const activeRender = jobs.find(
    (j) =>
      j.project_id === id &&
      j.kind === "render" &&
      ["queued", "running"].includes(j.status),
  );
  const renderedCurrent =
    !!project?.rendered && !!edit && stableKey(edit) === savedEditKey;
  const coverFrame = project?.metadata.cover_frame;
  const coverOutsideClip =
    !!coverFrame &&
    !!edit &&
    (coverFrame.time < edit.start || coverFrame.time >= edit.end);
  const autoSubtitleBlocked =
    !canRender || autoSubtitlesReady || autoSubtitleTooLong;
  const autoSubtitleTitle = local
    ? "زیرنویس خودکار در مرورگر فقط صدای بازه انتخاب‌شده را (به‌صورت یک فایل MP3 کوچک) آپلود می‌کند."
    : autoSubtitlesReady
      ? "زیرنویس خودکار برای این ویدیو ساخته شده است. به‌جای مصرف توکن بیشتر، آن‌ها را ویرایش کنید."
      : autoSubtitleTooLong
        ? `زیرنویس خودکار تا ${autoSubtitleLimitMinutes} دقیقه محدود است. سقف را در تنظیمات → زیرنویس خودکار افزایش دهید.`
        : "پیاده‌سازی گفتار با ElevenLabs، ترجمه با 9Router و افزودن زیرنویس انگلیسی + فارسی";
  const complete = !!project?.metadata.duration;
  const playbackReady = canRender && complete;
  async function saveAsDefaults(section: "subtitles" | "watermark") {
    if (!edit) return;
    setSavingDefaults(true);
    try {
      const {
        track_id: _track,
        fa_track_id: _faTrack,
        ...subtitles
      } = edit.subtitles;
      await api(
        "/settings/project-defaults",
        json("PATCH", {
          [section]: section === "subtitles" ? subtitles : edit.watermark,
        }),
      );
      toast(
        `${section === "subtitles" ? "تنظیمات پیش‌فرض زیرنویس" : "تنظیمات پیش‌فرض واترمارک"} برای پروژه‌های جدید ذخیره شد.`,
      );
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSavingDefaults(false);
    }
  }
  useEffect(() => {
    setProject(null);
    setEdit(null);
    setPlaybackFailed(false);
    setCuesByTrack({});
    setEditingCue(null);
    setSaved(false);
    setTime(0);
    setRefine(null);
    setAutoStarting(false);
    setCoverCandidates([]);
    setCoverBusy(false);
    setBulkRole("main");
    setBulkText("");
    setBulkSaving(false);
    setSavedEditKey("");
    api<Project>(`/projects/${id}`)
      .then((p) => {
        setProject(p);
        if (p.metadata.duration) {
          setEdit(p.edit);
          setSavedEditKey(stableKey(p.edit));
          setTime(p.edit.start);
        }
      })
      .catch((e) => onError(e.message));
  }, [id]);
  useEffect(() => {
    if (!project || (playbackReady && active.length === 0)) return;
    const t = setInterval(
      () =>
        api<Project>(`/projects/${id}`)
          .then((p) => {
            setProject(p);
            setEdit((old) => old || (p.metadata.duration ? p.edit : null));
          })
          .catch(() => {}),
      2000,
    );
    return () => clearInterval(t);
  }, [id, playbackReady, active.length]);
  useEffect(() => {
    if (!edit || !complete) return;
    setSaved(false);
    const t = setTimeout(async () => {
      if (edit.end <= edit.start || edit.end > duration) return;
      setSaving(true);
      try {
        const result = await api<{ rendered?: boolean }>(
          `/projects/${id}/edit`,
          json("PUT", edit),
        );
        setSaved(true);
        setSavedEditKey(stableKey(edit));
        setProject((old) =>
          old ? { ...old, rendered: !!result.rendered } : old,
        );
      } catch (e) {
        onError((e as Error).message);
      } finally {
        setSaving(false);
      }
    }, 800);
    return () => clearTimeout(t);
  }, [edit, id, complete]);
  useEffect(() => {
    setEditingCue(null);
    const ids = [edit?.subtitles.track_id, edit?.subtitles.fa_track_id].filter(
      Boolean,
    ) as string[];
    if (!ids.length) {
      setCuesByTrack({});
      return;
    }
    let alive = true;
    Promise.all(
      ids.map((trackId) =>
        api(`/projects/${id}/subtitles/${trackId}`)
          .then((r) => [trackId, r.cues] as const)
          .catch((e) => {
            onError(e.message);
            return [trackId, []] as const;
          }),
      ),
    ).then((entries) => {
      if (alive) setCuesByTrack(Object.fromEntries(entries));
    });
    return () => {
      alive = false;
    };
  }, [edit?.subtitles.track_id, edit?.subtitles.fa_track_id]);
  useEffect(() => {
    if (autoSubtitleJob) setAutoStarting(false);
  }, [autoSubtitleJob]);
  useEffect(() => {
    const job = jobs.find(
      (item) => item.project_id === id && item.kind === "autosubtitle",
    );
    const key = job ? `${job.id}:${job.status}` : "";
    if (!key || key === autoSubtitleRef.current) return;
    autoSubtitleRef.current = key;
    if (job!.status === "completed") {
      api<Project>(`/projects/${id}`)
        .then(async (next) => {
          setProject(next);
          setEdit((old) =>
            old
              ? {
                  ...old,
                  subtitles: {
                    ...old.subtitles,
                    track_id: next.edit.subtitles.track_id,
                    fa_track_id: next.edit.subtitles.fa_track_id,
                    burn: true,
                    soft: false,
                  },
                }
              : next.edit,
          );
          toast("زیرنویس خودکار انگلیسی و فارسی آماده است.");
          const track = next.edit.subtitles.track_id;
          if (track)
            try {
              const data = await api(`/projects/${id}/subtitles/${track}`);
              const first = (data.cues || []).find(
                (cue: Cue) =>
                  cue.end > next.edit.start && cue.start < next.edit.end,
              );
              if (first) seek(Math.max(first.start, next.edit.start));
            } catch {
              // The cues panel will report the error if the track is unreadable.
            }
        })
        .catch((e) => onError(e.message));
    } else if (job!.status === "failed" && job!.error) {
      onError(job!.error);
    }
  }, [jobs, id]);
  useEffect(() => {
    const job = jobs.find(
      (item) => item.project_id === id && item.kind === "render",
    );
    if (!job) return;
    const key = `${job.id}:${job.status}`;
    if (key === renderJobRef.current) return;
    renderJobRef.current = key;
    if (job.status !== "completed") return;
    // Refresh only the saved project state; the local edit may already contain
    // unsaved changes and must not be overwritten by an older render snapshot.
    api<Project>(`/projects/${id}`)
      .then(setProject)
      .catch(() => {});
  }, [jobs, id]);

  useEffect(() => {
    if (!frame.current) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setHeight(rect.height);
      setFrameWidth(rect.width);
    });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [complete, edit?.crop.ratio]);
  useEffect(() => {
    if (video.current && edit) {
      video.current.volume = Math.min(1, volume * edit.audio.volume);
      video.current.muted = edit.audio.mute;
      video.current.playbackRate = speed;
    }
  }, [volume, edit?.audio.volume, edit?.audio.mute, speed]);
  useEffect(() => {
    applySoftSubtitles();
  }, [edit?.subtitles.soft, playbackReady]);
  function applySoftSubtitles() {
    const player = video.current;
    if (!player) return;
    let shown = false;
    for (let index = 0; index < player.textTracks.length; index++) {
      const track = player.textTracks[index];
      const usable = track.kind === "subtitles" || track.kind === "captions";
      if (edit?.subtitles.soft && usable && !shown) {
        track.mode = "showing";
        shown = true;
      } else {
        track.mode = "disabled";
      }
    }
  }
  function syncMusic(current: number, isPlaying: boolean) {
    if (!music.current || !edit) return;
    const relative = current - edit.start;
    const len = edit.end - edit.start;
    const audio = music.current;
    if (audio.duration && relative >= 0 && relative < len) {
      const target = relative % audio.duration;
      if (Math.abs(audio.currentTime - target) > 0.2)
        audio.currentTime = target;
      const fade = Math.min(
        1,
        edit.audio.fade_in ? relative / edit.audio.fade_in : 1,
        edit.audio.fade_out ? (len - relative) / edit.audio.fade_out : 1,
      );
      audio.volume = Math.max(
        0,
        Math.min(1, edit.audio.music_volume * volume * fade),
      );
      audio.playbackRate = speed;
      if (isPlaying) audio.play().catch(() => {});
      else audio.pause();
    } else audio.pause();
  }
  useEffect(() => {
    syncMusic(time, playing);
  }, [
    time,
    playing,
    edit?.audio.music_id,
    edit?.audio.music_volume,
    edit?.audio.fade_in,
    edit?.audio.fade_out,
    volume,
    speed,
  ]);
  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver((entries) =>
      setStageHeight(entries[0].contentRect.height - 20),
    );
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, [complete]);
  useEffect(() => {
    if (!watermark.current) return;
    const observer = new ResizeObserver((entries) => {
      setWmBox({
        width: entries[0].contentRect.width,
        height: entries[0].contentRect.height,
      });
    });
    observer.observe(watermark.current);
    return () => observer.disconnect();
  }, [
    edit?.watermark.kind,
    edit?.watermark.asset_id,
    time >= (edit?.start || 0) + (edit?.watermark.start || 0),
  ]);
  useEffect(() => {
    const onChange = () =>
      setFullscreen(document.fullscreenElement === videoShell.current);
    document.addEventListener("fullscreenchange", onChange);
    onChange();
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  function update(group: keyof Edit, key: string, value: unknown) {
    setEdit((old) =>
      old
        ? {
            ...old,
            [group]:
              typeof old[group] === "object"
                ? { ...(old[group] as object), [key]: value }
                : value,
          }
        : null,
    );
  }
  function root(key: keyof Edit, value: unknown) {
    setEdit((old) => (old ? { ...old, [key]: value } : null));
  }
  function seek(value: number) {
    const target = snapMs(Math.max(0, Math.min(duration, value)));
    if (video.current) video.current.currentTime = target;
    setTime(target);
  }
  function timeAtFraction(fraction: number) {
    const ratio = Math.max(0, Math.min(1, fraction));
    return snapMs(rangeStart + ratio * rangeSpan);
  }
  function percentAtTime(value: number) {
    return ((value - rangeStart) / rangeSpan) * 100;
  }
  function resetTimelineView() {
    zoomRef.current = 1;
    zoomAnchor.current = null;
    setZoom(1);
    setScrollLeft(0);
    if (timelineScroll.current) timelineScroll.current.scrollLeft = 0;
  }
  function startRefine() {
    if (!edit || edit.end <= edit.start) return;
    setRefine({ start: edit.start, end: edit.end });
    resetTimelineView();
    seek(edit.start);
  }
  function endRefine() {
    setRefine(null);
    resetTimelineView();
    if (edit && (time < edit.start || time >= edit.end)) seek(edit.start);
  }
  function zoomTo(next: number, anchorX?: number) {
    const scroller = timelineScroll.current;
    const clamped = Math.min(MAX_ZOOM, Math.max(1, next));
    if (!scroller || !duration || clamped === zoomRef.current) {
      zoomRef.current = clamped;
      setZoom(clamped);
      return;
    }
    const x = anchorX ?? scroller.clientWidth / 2;
    const contentWidth = scroller.scrollWidth || 1;
    zoomAnchor.current = {
      time: rangeStart + ((scroller.scrollLeft + x) / contentWidth) * rangeSpan,
      x,
    };
    zoomRef.current = clamped;
    setZoom(clamped);
  }
  function nudgeZoom(factor: number) {
    zoomTo(zoomRef.current * factor);
  }
  useEffect(() => {
    const scroller = timelineScroll.current;
    if (!scroller || !duration) return;
    const observer = new ResizeObserver((entries) => {
      setTimelineWidth(entries[0].contentRect.width);
    });
    observer.observe(scroller);
    setTimelineWidth(scroller.clientWidth);
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setScrollLeft(scroller.scrollLeft);
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [duration]);
  useEffect(() => {
    const scroller = timelineScroll.current;
    if (!scroller || !duration) return;
    const onWheel = (event: WheelEvent) => {
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))
        return;
      event.preventDefault();
      const rect = scroller.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const factor = Math.exp(-delta * 0.003);
      zoomTo(zoomRef.current * factor, cursorX);
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [duration, rangeStart, rangeSpan]);
  useLayoutEffect(() => {
    const scroller = timelineScroll.current;
    zoomRef.current = zoom;
    if (!scroller || !duration) return;
    const anchor = zoomAnchor.current;
    if (anchor) {
      const contentWidth = scroller.scrollWidth;
      scroller.scrollLeft = Math.max(
        0,
        ((anchor.time - rangeStart) / rangeSpan) * contentWidth - anchor.x,
      );
      zoomAnchor.current = null;
    } else if (zoom === 1) {
      scroller.scrollLeft = 0;
    }
    setScrollLeft(scroller.scrollLeft);
  }, [zoom, duration, rangeStart, rangeSpan]);
  useEffect(() => {
    const scroller = timelineScroll.current;
    const content = timeline.current;
    if (!scroller || !content || !duration) return;
    if (time < rangeStart || time > rangeEnd) return;
    const x = ((time - rangeStart) / rangeSpan) * content.clientWidth;
    const left = scroller.scrollLeft;
    const right = left + scroller.clientWidth;
    if (x < left || x > right - 2) {
      scroller.scrollLeft = Math.max(0, x - scroller.clientWidth / 2);
    }
  }, [time, duration, rangeStart, rangeEnd, rangeSpan]);
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await videoShell.current?.requestFullscreen();
    } catch {
      onError("تغییر حالت تمام‌صفحه در این مرورگر ممکن نیست.");
    }
  }

  async function toggle() {
    if (!video.current) return;
    if (playing) video.current.pause();
    else {
      if (edit && (time < edit.start || time >= edit.end)) seek(edit.start);
      await video.current
        .play()
        .catch(() =>
          onError(
            "این ویدیو در این مرورگر پخش نمی‌شود. همچنان می‌توانید آن را رندر کنید.",
          ),
        );
    }
  }
  async function upload(kind: string, file: File, role?: "main" | "fa") {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      if (kind === "subtitles" && role) form.append("role", role);
      const result = await api(
        `/projects/${id}/${kind === "subtitles" ? "subtitles" : "assets/" + kind}`,
        { method: "POST", body: form },
      );
      setProject(await api(`/projects/${id}`));
      if (kind === "subtitles")
        update(
          "subtitles",
          role === "fa" ? "fa_track_id" : "track_id",
          result.track_id,
        );
      if (kind === "watermark") {
        update("watermark", "asset_id", result.asset_id);
        update("watermark", "kind", "image");
      }
      if (kind === "music") update("audio", "music_id", result.asset_id);
      toast("فایل به پروژه شما اضافه شد.");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function autoSubtitles() {
    if (!edit) return;
    if (local) {
      if (!localFile) {
        onError("برای زیرنویس خودکار، فایل محلی را دوباره وصل کنید.");
        return;
      }
      setBusy(true);
      setAutoStarting(true);
      try {
        const audio = await extractClipAudio(
          localFile,
          edit.start,
          edit.end - edit.start,
        );
        const form = new FormData();
        form.append(
          "file",
          new Blob([audio as unknown as BlobPart], { type: "audio/mpeg" }),
          "audio.mp3",
        );
        form.append("edit", JSON.stringify(edit));
        form.append("language", "en");
        form.append("translate", "true");
        await api(`/projects/${id}/autosubtitle-local`, {
          method: "POST",
          body: form,
        });
        toast(
          "زیرنویس خودکار در صف قرار گرفت. فقط صدای بازه انتخاب‌شده آپلود شد؛ ElevenLabs آن را پیاده‌سازی و 9Router ترجمه می‌کند.",
        );
      } catch (e) {
        setAutoStarting(false);
        onError((e as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    setAutoStarting(true);
    try {
      await api(
        `/projects/${id}/autosubtitle`,
        json("POST", { language: "en", translate: true }),
      );
      toast(
        "زیرنویس خودکار در صف قرار گرفت. ElevenLabs گفتار را پیاده‌سازی می‌کند، سپس 9Router آن را به فارسی ترجمه می‌کند.",
      );
    } catch (e) {
      setAutoStarting(false);
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function render(preview: boolean) {
    if (!edit) return;
    if (local) {
      if (!localFile || !project) return;
      setBusy(true);
      setLocalRender({ phase: "preparing", progress: 0 });
      const controller = new AbortController();
      localAbort.current = controller;
      try {
        const plan = await api<RenderPlan>(
          `/projects/${id}/render-plan?preview=${preview}&threads=${engineThreads()}`,
          json("POST", edit),
        );
        const clip = await renderLocalClip({
          projectId: id,
          file: localFile,
          plan,
          edit,
          onProgress: setLocalRender,
          signal: controller.signal,
        });
        setProject(await api<Project>(`/projects/${id}`));
        setSavedEditKey(stableKey(edit));
        setSaved(true);
        toast(
          preview
            ? "پیش‌نمایش شش‌ثانیه‌ای در مرورگر رندر و ذخیره شد."
            : "کلیپ در مرورگر رندر و روی سرور ذخیره شد.",
        );
        if (clip) onClip(clip);
      } catch (e) {
        if (controller.signal.aborted) toast("رندر مرورگر لغو شد.");
        else onError((e as Error).message);
      } finally {
        localAbort.current = null;
        setBusy(false);
        setLocalRender(null);
      }
      return;
    }
    setBusy(true);
    try {
      await api(
        `/projects/${id}/render?preview=${preview}`,
        json("POST", edit),
      );
      toast(
        preview
          ? "پیش‌نمایش شش‌ثانیه‌ای رندر در صف قرار گرفت. پس از آماده شدن، آن را در پایین باز کنید."
          : "کلیپ شما در صف رندر قرار گرفت.",
      );
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function cancelLocalRender() {
    localAbort.current?.abort();
    terminateEngine();
    setLocalRender(null);
  }
  async function generateCoverFrames() {
    if (!edit) return;
    if (local) {
      if (!localFile) {
        onError("برای ساخت کاور، فایل محلی را دوباره وصل کنید.");
        return;
      }
      setCoverBusy(true);
      try {
        const span = edit.end - edit.start;
        const times = Array.from(
          { length: 6 },
          (_, index) => edit.start + (span * (index + 1)) / 7,
        );
        setCoverCandidates(
          await extractCoverCandidates(
            localFile,
            times,
            project.metadata as LocalMetadata,
            edit,
          ),
        );
        toast("شش فریم تمیز کاور تلگرام در مرورگر ساخته شد.");
      } catch (e) {
        onError((e as Error).message);
      } finally {
        setCoverBusy(false);
      }
      return;
    }
    setCoverBusy(true);
    try {
      const result = await api<{ frames: CoverCandidate[] }>(
        `/projects/${id}/cover-frames`,
        json("POST", {
          count: 6,
          start: edit.start,
          end: edit.end,
          edit,
        }),
      );
      setCoverCandidates(result.frames);
      toast("شش فریم تمیز کاور تلگرام بدون زیرنویس ساخته شد.");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setCoverBusy(false);
    }
  }
  async function chooseCoverFrame(value: number) {
    if (!edit) return;
    setCoverBusy(true);
    try {
      let image: string | undefined;
      if (local) {
        if (!localFile) {
          onError("برای انتخاب کاور، فایل محلی را دوباره وصل کنید.");
          return;
        }
        image = await cleanCoverFrame(
          localFile,
          value,
          project.metadata as LocalMetadata,
          edit,
        );
      }
      await api(
        `/projects/${id}/cover-frame`,
        json("PUT", {
          time: value,
          start: edit.start,
          end: edit.end,
          edit,
          ...(image ? { image } : {}),
        }),
      );
      setProject(await api<Project>(`/projects/${id}`));
      toast(
        `کاور تلگرام در ${timecode(value)} ذخیره شد. رندر بعدی از این فریم تمیز استفاده می‌کند.`,
      );
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setCoverBusy(false);
    }
  }
  async function clearCoverFrame() {
    if (!edit) return;
    setCoverBusy(true);
    try {
      await api(`/projects/${id}/cover-frame`, json("PUT", { time: null }));
      setProject(await api<Project>(`/projects/${id}`));
      toast("انتخاب کاور تلگرام پاک شد.");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setCoverBusy(false);
    }
  }
  function dragPlayhead(e: React.PointerEvent<HTMLElement>) {
    if (!timeline.current) return;
    e.preventDefault();
    e.stopPropagation();
    const element = e.currentTarget;
    element.focus();
    element.setPointerCapture(e.pointerId);
    if (video.current && !video.current.paused) video.current.pause();
    const move = (ev: PointerEvent) => {
      if (!timeline.current) return;
      const rect = timeline.current.getBoundingClientRect();
      seek(timeAtFraction((ev.clientX - rect.left) / rect.width));
    };
    const end = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
  }
  function nudgePlayhead(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.shiftKey ? 1 : e.altKey ? 0.001 : 0.01;
    seek(time + (e.key === "ArrowRight" ? step : -step));
  }
  function dragHandle(e: React.PointerEvent, kind: "start" | "end") {
    e.preventDefault();
    const element = e.currentTarget as HTMLElement;
    element.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (!timeline.current || !edit) return;
      const rect = timeline.current.getBoundingClientRect();
      const t = timeAtFraction((ev.clientX - rect.left) / rect.width);
      setEdit((old) =>
        old
          ? {
              ...old,
              [kind]:
                kind === "start"
                  ? Math.min(t, old.end - MIN_CLIP)
                  : Math.max(t, old.start + MIN_CLIP),
            }
          : null,
      );
    };
    const end = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
  }
  function dragFrame(e: React.PointerEvent, type: "crop" | "watermark") {
    if (!edit || !frame.current) return;
    if (type === "crop" && !cropDrag) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const initialX = e.clientX,
      initialY = e.clientY;
    const rect = frame.current.getBoundingClientRect();
    const initial = { ...(type === "crop" ? edit.crop : edit.watermark) };
    const wmRect = watermark.current?.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      let x, y;
      if (type === "crop") {
        const factor = Math.max(
          rect.width / project!.metadata.width,
          rect.height / project!.metadata.height,
        );
        const overflowX = project!.metadata.width * factor - rect.width,
          overflowY = project!.metadata.height * factor - rect.height;
        x =
          initial.x -
          (ev.clientX - initialX) / Math.max(overflowX, rect.width * 0.25);
        y =
          initial.y -
          (ev.clientY - initialY) / Math.max(overflowY, rect.height * 0.25);
      } else if (edit.watermark.template) {
        x =
          initial.x +
          (ev.clientX - initialX) /
            Math.max(
              1,
              rect.width - (2 * edit.watermark.margin * height) / 1080,
            );
        y =
          initial.y +
          (ev.clientY - initialY) /
            Math.max(
              1,
              rect.height - (2 * edit.watermark.margin * height) / 1080,
            );
      } else {
        x =
          initial.x +
          (ev.clientX - initialX) /
            Math.max(
              1,
              rect.width -
                (wmRect?.width || 0) -
                (2 * edit.watermark.margin * height) / 1080,
            );
        y =
          initial.y +
          (ev.clientY - initialY) /
            Math.max(
              1,
              rect.height -
                (wmRect?.height || 0) -
                (2 * edit.watermark.margin * height) / 1080,
            );
      }
      setEdit((old) =>
        old
          ? {
              ...old,
              [type]: {
                ...(type === "crop" ? old.crop : old.watermark),
                x: Math.max(0, Math.min(1, x)),
                y: Math.max(0, Math.min(1, y)),
              },
            }
          : null,
      );
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }
  if (!project)
    return (
      <div className="page loading">
        <LoaderCircle className="spin" /> در حال باز کردن ویرایشگر…
      </div>
    );
  if (!edit || !complete)
    return (
      <div className="page">
        <div className="page-heading compact">
          <div>
            <span className="eyebrow">آماده‌سازی</span>
            <h1>{project.name}</h1>
            <p>ویدیوی شما در حال دانلود و بررسی است.</p>
          </div>
          <button className="secondary" onClick={onQueue}>
            مشاهده فعالیت <ArrowUpRight size={16} />
          </button>
        </div>
        <div className="empty">
          <LoaderCircle className="spin" size={36} />
          <h3>
            {project.status === "failed"
              ? "این ورود به بررسی نیاز دارد"
              : project.status === "cancelled"
                ? "ورود لغو شد"
                : "آماده‌سازی ویدیوی شما"}
          </h3>
          {jobs
            .filter((j) => j.project_id === id && j.error)
            .slice(0, 1)
            .map((j) => (
              <p key={j.id} className="inline-error">
                {j.error}
              </p>
            ))}
          {active.map((j) => (
            <div className="processing-job" key={j.id}>
              <span>
                {j.kind === "download" || j.kind === "youtube"
                  ? "در حال دانلود"
                  : j.kind === "autosubtitle"
                    ? "ساخت زیرنویس انگلیسی + فارسی"
                    : "بررسی ویدیو"}{" "}
                · {j.progress.toFixed(0)}%
              </span>
              <div className="meter">
                <i style={{ width: `${j.progress}%` }} />
              </div>
            </div>
          ))}
          <button className="secondary" onClick={onQueue}>
            مدیریت در فعالیت
          </button>
        </div>
      </div>
    );
  const outputRatio =
    edit.crop.ratio === "original"
      ? project.metadata.width / project.metadata.height
      : Number(edit.crop.ratio.split(":")[0]) /
        Number(edit.crop.ratio.split(":")[1]);
  const style = edit.subtitles,
    wm = edit.watermark;
  const mainTrackCues = style.track_id ? cuesByTrack[style.track_id] || [] : [];
  const faTrackCues = style.fa_track_id
    ? cuesByTrack[style.fa_track_id] || []
    : [];
  const visibleAt = (cue: Cue) =>
    time >= cue.start + style.offset && time < cue.end + style.offset;
  const mainVisible = mainTrackCues
    .map((cue, index) => ({ cue, index }))
    .filter(({ cue }) => visibleAt(cue));
  const faVisible = faTrackCues
    .map((cue, index) => ({ cue, index }))
    .filter(({ cue }) => visibleAt(cue));
  async function saveTrackCues(trackId: string, next: Cue[], message: string) {
    try {
      const result = await api<{ rendered?: boolean }>(
        `/projects/${id}/subtitles/${trackId}`,
        json("PUT", next),
      );
      setCuesByTrack((old) => ({ ...old, [trackId]: next }));
      setProject((old) =>
        old ? { ...old, rendered: !!result.rendered } : old,
      );
      toast(message);
    } catch (e) {
      onError((e as Error).message);
    }
  }
  const bulkTrackId = bulkRole === "fa" ? style.fa_track_id : style.track_id;
  const bulkCueCount = bulkTrackId
    ? (cuesByTrack[bulkTrackId] || []).length
    : 0;
  function prepareBulkEditor(role?: "main" | "fa") {
    const nextRole =
      role ?? (style.track_id ? "main" : style.fa_track_id ? "fa" : "main");
    const trackId = nextRole === "fa" ? style.fa_track_id : style.track_id;
    if (!trackId) {
      onError("ابتدا یک مسیر زیرنویس انتخاب کنید.");
      return false;
    }
    setBulkRole(nextRole);
    setBulkText(cuesToSrt(cuesByTrack[trackId] || []));
    return true;
  }
  async function copyBulkText() {
    try {
      await navigator.clipboard.writeText(bulkText);
      toast("متن کامل زیرنویس کپی شد.");
    } catch {
      onError("کپی انجام نشد. متن را انتخاب و دستی کپی کنید.");
    }
  }
  async function saveBulkText() {
    const trackId = bulkRole === "fa" ? style.fa_track_id : style.track_id;
    if (!trackId) {
      onError("ابتدا یک مسیر زیرنویس انتخاب کنید.");
      return;
    }
    const next = parseSrt(bulkText);
    if (!next.length) {
      onError(
        "هیچ زیرنویس معتبری پیدا نشد. قالب زمان‌بندی (SRT) را بررسی کنید.",
      );
      return;
    }
    setBulkSaving(true);
    try {
      await saveTrackCues(trackId, next, "متن کامل زیرنویس ذخیره شد.");
    } finally {
      setBulkSaving(false);
    }
  }
  function beginCueEdit(trackId: string, index: number, _cue: Cue) {
    if (playing || tab !== "subtitles") return;
    if (
      editingCue &&
      (editingCue.trackId !== trackId || editingCue.index !== index)
    )
      void commitCueEdit();
    setEditingCue({ trackId, index });
  }
  async function commitCueEdit() {
    const editor = inlineEditorRef.current;
    const rawText = editor?.innerText;
    if (rawText == null) return;
    if (cancelCueEditRef.current) {
      cancelCueEditRef.current = false;
      setEditingCue(null);
      return;
    }
    if (!editingCue) return;
    const { trackId, index } = editingCue;
    const current = cuesByTrack[trackId] || [];
    const text = rawText.replace(/\r\n/g, "\n").trim();
    const next = current.map((cue, cueIndex) =>
      cueIndex === index ? { ...cue, text } : cue,
    );
    setEditingCue(null);
    await saveTrackCues(trackId, next, "متن زیرنویس ذخیره شد.");
  }
  const captionLine = (fa: boolean) => {
    const scale = height / 1080;
    return {
      fontFamily: fa ? style.fa_font : style.font,
      fontSize: (fa ? style.fa_size : style.size) * scale,
      fontWeight: (fa ? style.fa_bold : style.bold) ? 700 : 400,
      color: fa ? style.fa_color : style.color,
      WebkitTextStroke: `${(fa ? style.fa_outline : style.outline) * scale}px ${
        fa ? style.fa_outline_color : style.outline_color
      }`,
      textShadow: (fa ? style.fa_shadow : style.shadow)
        ? `${(fa ? style.fa_shadow : style.shadow) * scale}px ${
            (fa ? style.fa_shadow : style.shadow) * scale
          }px ${(fa ? style.fa_shadow : style.shadow) * scale}px #0009`
        : "none",
      direction: fa ? ("rtl" as const) : ("ltr" as const),
      unicodeBidi: fa ? ("isolate" as const) : ("normal" as const),
      alignSelf:
        style.align === "left"
          ? ("flex-start" as const)
          : style.align === "right"
            ? ("flex-end" as const)
            : ("center" as const),
      background: style.box ? `rgba(0,0,0,${style.box_opacity})` : undefined,
      padding: style.box ? "2px 5px" : undefined,
    };
  };
  function renderCaptionLine(
    trackId: string,
    index: number,
    cue: Cue,
    fa: boolean,
  ) {
    const isEditing =
      editingCue?.trackId === trackId && editingCue.index === index;
    if (isEditing)
      return (
        <span
          key={`${trackId}-${index}`}
          ref={(node) => {
            inlineEditorRef.current = node;
            if (!node || node.dataset.ready === "1") return;
            node.dataset.ready = "1";
            node.focus();
            const range = document.createRange();
            range.selectNodeContents(node);
            range.collapse(false);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          }}
          className="caption-line caption-inline-editor"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="ویرایش متن زیرنویس روی ویدیو"
          spellCheck={false}
          style={{
            ...captionLine(fa),
            pointerEvents: "auto",
            cursor: "text",
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text/plain");
            const selection = window.getSelection();
            if (!selection?.rangeCount) return;
            const range = selection.getRangeAt(0);
            range.deleteContents();
            const node = document.createTextNode(text);
            range.insertNode(node);
            range.setStartAfter(node);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
          }}
          onBlur={() => void commitCueEdit()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancelCueEditRef.current = true;
              event.currentTarget.blur();
              setEditingCue(null);
            } else if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey)
            ) {
              event.preventDefault();
              void commitCueEdit();
            }
          }}
        >
          {cue.text}
        </span>
      );
    return (
      <span
        key={`${trackId}-${index}`}
        className="caption-line"
        style={{
          ...captionLine(fa),
          pointerEvents: playing || tab !== "subtitles" ? "none" : "auto",
          cursor: playing || tab !== "subtitles" ? "inherit" : "text",
        }}
        title={
          playing || tab !== "subtitles"
            ? undefined
            : "پخش را متوقف کنید و برای ویرایش این زیرنویس کلیک کنید"
        }
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          beginCueEdit(trackId, index, cue);
        }}
      >
        {cue.text}
      </span>
    );
  }
  const wmWidth = wmBox.width,
    wmHeight = wmBox.height;
  const m = (wm.margin * height) / 1080;
  const wmTemplate = wm.kind === "text" ? wm.template : null;
  const watermarkVisible =
    time <= edit.end &&
    watermarkVisibleAt(
      wm,
      wmTemplate,
      time - edit.start,
      edit.end - edit.start,
    );

  const rendered = clips.filter((c) => c.project_id === id).slice(0, 4);
  const clipDuration = Math.max(0, edit.end - edit.start);
  const totalCuesCount = mainTrackCues.length + faTrackCues.length;

  function tabHasIndicator(toolId: ToolId): boolean {
    if (toolId === "subtitles")
      return Boolean(style.track_id || style.fa_track_id);
    if (toolId === "crop")
      return (
        edit!.crop.ratio !== "original" ||
        edit!.crop.x !== 0.5 ||
        edit!.crop.y !== 0.5
      );
    if (toolId === "watermark") return wm.kind !== "none";
    if (toolId === "audio")
      return Boolean(
        edit!.audio.mute || edit!.audio.volume !== 1 || edit!.audio.music_id,
      );
    if (toolId === "export") return Boolean(coverFrame);
    return false;
  }

  return (
    <div className="editor">
      {/* Top Studio Header */}
      <div className="editor-heading">
        <div className="editor-title-block">
          <div className="editor-eyebrow-row">
            <span className="eyebrow">استودیو ویرایش ویدیو</span>
            <span
              className={
                "save-status" +
                (saving ? " is-saving" : saved ? " is-saved" : "")
              }
            >
              {saving ? (
                <>
                  <LoaderCircle className="spin" size={12} /> در حال ذخیره
                </>
              ) : saved ? (
                <>
                  <CheckIcon size={12} /> تغییرات ذخیره شد
                </>
              ) : (
                "در حال ویرایش"
              )}
            </span>
          </div>
          <Input
            className="project-name-input"
            aria-label="نام پروژه"
            value={project.name}
            onChange={(e) => setProject({ ...project, name: e.target.value })}
            onBlur={() =>
              api(
                `/projects/${id}`,
                json("PATCH", { name: project.name }),
              ).catch((e) => onError(e.message))
            }
          />
        </div>
        <div className="form-actions editor-header-actions">
          <button
            className="secondary"
            disabled={
              busy || autoSubtitleBlocked || !!autoSubtitleJob || autoStarting
            }
            onClick={() => autoSubtitles()}
            title={autoSubtitleTitle}
          >
            {autoSubtitleJob || autoStarting ? (
              <LoaderCircle className="spin" size={15} />
            ) : autoSubtitlesReady ? (
              <CheckIcon size={15} />
            ) : (
              <Sparkles size={15} />
            )}{" "}
            {autoSubtitleJob
              ? `زیرنویس خودکار ${autoSubtitleJob.progress.toFixed(0)}%`
              : autoStarting
                ? "در حال شروع…"
                : autoSubtitlesReady
                  ? "زیرنویس آماده است"
                  : "زیرنویس خودکار"}
          </button>
          <button
            className="secondary"
            disabled={busy || !canRender || !!activeRender || !!localRender}
            onClick={() => render(true)}
            title={
              activeRender
                ? "رندر این پروژه در حال انجام است."
                : "رندر پیش‌نمایش شش‌ثانیه‌ای"
            }
          >
            <Play size={15} /> پیش‌نمایش رندر
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              edit.end <= edit.start ||
              !canRender ||
              !!activeRender ||
              !!localRender ||
              renderedCurrent
            }
            onClick={() => render(false)}
            title={
              renderedCurrent
                ? "این برش دقیق قبلاً رندر شده است. آن را از خروجی‌های اخیر باز کنید یا ابتدا کلیپ را تغییر دهید."
                : activeRender
                  ? "رندر این پروژه در حال انجام است."
                  : undefined
            }
          >
            {renderedCurrent ? <CheckIcon size={16} /> : <Download size={16} />}{" "}
            {renderedCurrent ? "قبلاً رندر شده" : "رندر کلیپ"}
          </button>
          {localRender && (
            <div className="local-render-status" role="status">
              <LoaderCircle className="spin" size={15} />
              <span>
                {localRender.phase === "preparing"
                  ? "آماده‌سازی موتور رندر"
                  : localRender.phase === "rendering"
                    ? "رندر در مرورگر"
                    : "آپلود کلیپ"}{" "}
                · {(localRender.progress * 100).toFixed(0)}%
              </span>
              <div className="meter">
                <i style={{ width: `${localRender.progress * 100}%` }} />
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="لغو رندر مرورگر"
                onClick={cancelLocalRender}
              >
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="editor-layout">
        <div className="editor-workspace">
          {/* 1. Video Preview Stage + Attached Player Controls */}
          <div className="video-shell" ref={videoShell}>
            <div className="preview-stage" ref={stage}>
              <div
                className={"output-frame " + (cropDrag ? "crop-drag" : "")}
                ref={frame}
                style={{
                  aspectRatio: outputRatio,
                  maxWidth: `${stageHeight * outputRatio}px`,
                  maxHeight: stageHeight,
                }}
                onPointerDown={(e) => dragFrame(e, "crop")}
              >
                {playbackReady ? (
                  <video
                    ref={video}
                    key={project.id}
                    src={local ? sourceUrl : `/api/media/project/${id}/source`}
                    style={{
                      objectFit: edit.crop.mode === "fit" ? "contain" : "cover",
                      objectPosition: `${edit.crop.x * 100}% ${edit.crop.y * 100}%`,
                    }}
                    playsInline
                    onClick={() => {
                      if (!cropDrag) void toggle();
                    }}
                    onLoadedMetadata={(e) => {
                      const player = e.currentTarget;
                      player.volume = Math.min(1, volume * edit.audio.volume);
                      player.muted = edit.audio.mute;
                      player.playbackRate = speed;
                      player.currentTime = Math.min(time, player.duration);
                      applySoftSubtitles();
                    }}
                    onError={() => {
                      setPlaying(false);
                      setPlaybackFailed(true);
                      onError(
                        "این مرورگر نمی‌تواند این فرمت ویدیو را پخش کند. همچنان می‌توانید آن را برش دهید و رندر کنید.",
                      );
                    }}
                    onTimeUpdate={(e) => {
                      const player = e.currentTarget;
                      const t = player.currentTime;
                      if (edit && t >= edit.end) {
                        if (loop) seek(edit.start);
                        else {
                          player.pause();
                          player.currentTime = edit.end;
                          setTime(edit.end);
                        }
                      } else if (edit && t < edit.start) {
                        player.currentTime = edit.start;
                        setTime(edit.start);
                      } else setTime(t);
                    }}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => setPlaying(false)}
                  />
                ) : local && !localFile ? (
                  <div className="preview-pending">
                    <Upload size={30} />
                    <strong>فایل محلی را دوباره وصل کنید</strong>
                    <span>
                      برای حفظ حریم خصوصی، فایل اصلی روی سرور ذخیره نمی‌شود.
                      همان فایل را انتخاب کنید تا پخش و رندر ادامه پیدا کند.
                    </span>
                    <label className="secondary local-file-button">
                      انتخاب فایل
                      <input
                        type="file"
                        accept="video/*,.mkv"
                        onChange={(e) => {
                          const chosen = e.target.files?.[0];
                          if (!chosen) return;
                          if (
                            project.metadata.size &&
                            chosen.size !== project.metadata.size
                          ) {
                            onError(
                              "این فایل با اندازه فایل اصلی این پروژه مطابقت ندارد.",
                            );
                            return;
                          }
                          onLocalFile(chosen);
                        }}
                      />
                    </label>
                  </div>
                ) : (
                  <div className="preview-pending">
                    {active.length > 0 && (
                      <LoaderCircle className="spin" size={30} />
                    )}
                    <strong>
                      {active.length > 0
                        ? "آماده‌سازی ویدیو"
                        : "ویدیو در دسترس نیست"}
                    </strong>
                    <span>
                      {active.length > 0
                        ? "بررسی هنوز در حال انجام است."
                        : "فایل منبع اصلی موجود نیست یا حذف شده است."}
                    </span>
                  </div>
                )}
                {playbackFailed && playbackReady && (
                  <div className="preview-pending preview-failed">
                    <strong>این مرورگر نمی‌تواند این ویدیو را پخش کند</strong>
                    <span>همچنان می‌توانید آن را برش دهید و رندر کنید.</span>
                  </div>
                )}
                {!style.soft &&
                  (mainVisible.length > 0 || faVisible.length > 0) && (
                    <div
                      className="caption-preview caption-dual"
                      style={{
                        textAlign: style.align as "left" | "center" | "right",
                        gap: (style.gap * height) / 1080,
                        bottom:
                          style.position === "bottom"
                            ? (style.margin * height) / 1080
                            : undefined,
                        top:
                          style.position === "top"
                            ? (style.margin * height) / 1080
                            : style.position === "middle"
                              ? "50%"
                              : undefined,
                        transform:
                          style.position === "middle"
                            ? "translateY(-50%)"
                            : undefined,
                        left: (style.margin * height) / 1080,
                        right: (style.margin * height) / 1080,
                      }}
                    >
                      {mainVisible.map(({ cue, index }) =>
                        renderCaptionLine(style.track_id, index, cue, false),
                      )}
                      {faVisible.map(({ cue, index }) =>
                        renderCaptionLine(style.fa_track_id, index, cue, true),
                      )}
                    </div>
                  )}
                {watermarkVisible &&
                  (wm.kind === "image" ? (
                    <div
                      className="watermark-preview"
                      ref={watermark}
                      onPointerDown={(e) => dragFrame(e, "watermark")}
                      style={{
                        left: m + (frameWidth - wmWidth - 2 * m) * wm.x,
                        top: m + (height - wmHeight - 2 * m) * wm.y,
                        opacity: wm.opacity,
                        width: `${wm.width * 100}%`,
                      }}
                    >
                      {wm.asset_id ? (
                        <img
                          src={`/api/media/asset/${wm.asset_id}`}
                          alt="واترمارک"
                          onLoad={() =>
                            setFrameWidth(frame.current?.clientWidth || 800)
                          }
                        />
                      ) : null}
                    </div>
                  ) : wmTemplate ? (
                    <div
                      className="watermark-preview watermark-template-preview"
                      ref={watermark}
                      onPointerDown={(e) => dragFrame(e, "watermark")}
                      style={{
                        left: m + (frameWidth - 2 * m) * wm.x,
                        top: m + (height - 2 * m) * wm.y,
                        transform: "translate(-50%, -50%)",
                        gap: (wmTemplate.gap_vertical * height) / 1080,
                      }}
                    >
                      {wmTemplate.rows.map((row, rowIndex) => (
                        <div
                          className="watermark-template-row"
                          key={rowIndex}
                          style={{
                            gap: (wmTemplate.gap_horizontal * height) / 1080,
                          }}
                        >
                          {row
                            .filter((element) => element.text)
                            .map((element, elementIndex) => (
                              <span
                                key={elementIndex}
                                style={{
                                  fontFamily: element.font_family,
                                  fontSize: (element.font_size * height) / 1080,
                                  fontWeight: element.bold ? 700 : 400,
                                  color: element.color,
                                  opacity: element.opacity,
                                  WebkitTextStroke: wmTemplate.border_thickness
                                    ? `${(wmTemplate.border_thickness * height) / 1080}px ${wmTemplate.border_color}`
                                    : undefined,
                                }}
                              >
                                {element.text}
                              </span>
                            ))}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div
                      className="watermark-preview"
                      ref={watermark}
                      onPointerDown={(e) => dragFrame(e, "watermark")}
                      style={{
                        left: m + (frameWidth - wmWidth - 2 * m) * wm.x,
                        top: m + (height - wmHeight - 2 * m) * wm.y,
                        opacity: wm.opacity,
                        color: wm.color,
                        fontFamily: wm.font,
                        fontSize: (wm.size * height) / 1080,
                      }}
                    >
                      {wm.text}
                    </div>
                  ))}
              </div>
              {cropDrag && (
                <span className="stage-hint">
                  <Move size={14} /> برای کادربندی مجدد، ویدیو را بکشید
                </span>
              )}
              {tab === "subtitles" &&
                !playing &&
                (mainVisible.length > 0 || faVisible.length > 0) && (
                  <span className="stage-hint subtle">
                    <Type size={13} /> برای ویرایش مستقیم، روی متن زیرنویس کلیک
                    کنید
                  </span>
                )}
            </div>

            {/* Attached Playback Controls */}
            <div
              className="player-controls"
              role="group"
              aria-label="کنترل پخش ویدیو"
            >
              <div className="video-progress">
                <span className="video-time current">{timecode(time)}</span>
                <RangeSlider
                  className="video-seek"
                  aria-label="نوار پیشرفت پخش"
                  dir="ltr"
                  min={0}
                  max={duration || 1}
                  step={0.01}
                  disabled={!playbackReady}
                  value={[Math.min(time, duration || 0)]}
                  onValueChange={([value]) => seek(value)}
                />
                <span className="video-time">{clock(duration)}</span>
              </div>
              <div className="player-control-row">
                <button
                  className="icon-button play-toggle"
                  aria-label={playing ? "توقف" : "پخش"}
                  disabled={!playbackReady}
                  onClick={toggle}
                >
                  {playing ? <Pause size={18} /> : <Play size={18} />}
                </button>
                <div className="player-clip-pill">
                  <span>بازه انتخابی:</span>
                  <strong>
                    {clock(edit.start)} تا {clock(edit.end)}
                  </strong>
                  <em>({clock(clipDuration)})</em>
                </div>
                <div className="player-spacer" />
                <div className="player-audio-group">
                  <Volume2 size={16} className="muted-icon" />
                  <RangeSlider
                    className="volume-slider"
                    aria-label="صدای پخش"
                    dir="ltr"
                    min={0}
                    max={1}
                    step={0.01}
                    value={[volume]}
                    onValueChange={([value]) => setVolume(value)}
                  />
                </div>
                <Select
                  className="speed-select"
                  aria-label="سرعت پخش"
                  container={fullscreen ? videoShell.current : undefined}
                  value={String(speed)}
                  onChange={(v) => setSpeed(Number(v))}
                  options={[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => [
                    String(v),
                    `${v}×`,
                  ])}
                />
                <button
                  className={"icon-button " + (loop ? "selected" : "")}
                  aria-label="پخش تکراری کلیپ انتخاب‌شده"
                  title="پخش تکراری کلیپ انتخاب‌شده"
                  onClick={() => setLoop(!loop)}
                >
                  <Repeat size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={fullscreen ? "خروج از تمام‌صفحه" : "تمام‌صفحه"}
                  title={fullscreen ? "خروج از تمام‌صفحه" : "تمام‌صفحه"}
                  onClick={() => void toggleFullscreen()}
                >
                  {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
                </button>
              </div>
            </div>
          </div>

          {/* 2. Unified Bottom Studio Dock (Tabs + Active Tool Deck) */}
          <div className="studio-dock">
            <div className="studio-dock-header">
              <div
                className="editor-tools"
                role="tablist"
                aria-label="ابزارهای ویرایش"
              >
                {TOOL_TABS.map((t) => {
                  const hasDot = tabHasIndicator(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      id={`tool-tab-${t.id}`}
                      aria-selected={tab === t.id}
                      aria-controls="editor-tool-panel"
                      className={
                        "editor-tool" +
                        (tab === t.id ? " active" : "") +
                        (hasDot ? " has-indicator" : "")
                      }
                      onClick={() => setTab(t.id)}
                    >
                      <t.icon size={15} />
                      <span>{t.label}</span>
                      {hasDot && <i className="tool-dot" />}
                    </button>
                  );
                })}
              </div>

              <div className="studio-dock-meta">
                <span>
                  نسبت قاب:{" "}
                  <strong>
                    {edit.crop.ratio === "original" ? "اصلی" : edit.crop.ratio}
                  </strong>
                </span>
                <span className="meta-sep">·</span>
                <span>
                  کیفیت خروجی: <strong>{edit.resolution}p</strong>
                </span>
              </div>
            </div>

            {/* TAB 1: TRIM / CUT TIMELINE */}
            {tab === "clip" && (
              <div
                className={"timeline-panel" + (refine ? " refining" : "")}
                id="editor-tool-panel"
                role="tabpanel"
                aria-labelledby="tool-tab-clip"
              >
                <div className="trim-Control-bar">
                  <div className="trim-readouts">
                    <div className="trim-stat-box">
                      <span className="trim-stat-label">شروع برش</span>
                      <div className="trim-stat-row">
                        <strong className="trim-timecode">
                          {timecode(edit.start)}
                        </strong>
                        <button
                          type="button"
                          className="trim-set-btn"
                          title="قرار دادن شروع برش در موقعیت فعلی نشانگر پخش"
                          onClick={() =>
                            root("start", Math.min(time, edit.end - MIN_CLIP))
                          }
                        >
                          شروع از اینجا
                        </button>
                      </div>
                    </div>

                    <div className="trim-stat-box highlight">
                      <span className="trim-stat-label">مدت کلیپ انتخابی</span>
                      <div className="trim-stat-row">
                        <strong className="trim-timecode accent-text">
                          {timecode(clipDuration)}
                        </strong>
                        <span className="trim-badge">
                          {refine ? "حالت دقیق‌سازی" : "کل ویدیو"}
                        </span>
                      </div>
                    </div>

                    <div className="trim-stat-box">
                      <span className="trim-stat-label">پایان برش</span>
                      <div className="trim-stat-row">
                        <strong className="trim-timecode">
                          {timecode(edit.end)}
                        </strong>
                        <button
                          type="button"
                          className="trim-set-btn"
                          title="قرار دادن پایان برش در موقعیت فعلی نشانگر پخش"
                          onClick={() =>
                            root("end", Math.max(time, edit.start + MIN_CLIP))
                          }
                        >
                          پایان در اینجا
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="timeline-bottom">
                    <Button
                      type="button"
                      variant={refine ? "default" : "secondary"}
                      size="sm"
                      className="timeline-refine"
                      aria-pressed={!!refine}
                      title={
                        refine
                          ? "پایان دقیق‌سازی این انتخاب"
                          : "برش دوباره درون انتخاب فعلی"
                      }
                      onClick={refine ? endRefine : startRefine}
                    >
                      <Scissors />
                      {refine ? "پایان دقیق‌سازی" : "دقیق‌سازی بازه"}
                    </Button>
                    <div className="timeline-zoom-controls">
                      <Button
                        type="button"
                        variant="secondary"
                        size="icon"
                        className="zoom-button"
                        aria-label="کوچک‌نمایی"
                        title="کوچک‌نمایی"
                        disabled={zoom <= 1}
                        onClick={() => nudgeZoom(1 / 1.6)}
                      >
                        <ZoomOut />
                      </Button>
                      <span
                        className="zoom-readout"
                        aria-live="polite"
                        title="برای بزرگ‌نمایی، روی خط زمان اسکرول کنید"
                      >
                        {zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×
                      </span>
                      <Button
                        type="button"
                        variant="secondary"
                        size="icon"
                        className="zoom-button"
                        aria-label="بزرگ‌نمایی"
                        title="بزرگ‌نمایی"
                        disabled={zoom >= MAX_ZOOM}
                        onClick={() => nudgeZoom(1.6)}
                      >
                        <ZoomIn />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="zoom-fit"
                        disabled={zoom === 1}
                        onClick={() => zoomTo(1)}
                      >
                        <Scan /> تناسب
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="timeline-scroll" ref={timelineScroll}>
                  <div
                    className="timeline-content"
                    style={{ width: `${zoom * 100}%` }}
                  >
                    <div className="timeline-ruler dynamic">
                      {timelineTicks.map((tick) => (
                        <span
                          className="timeline-tick"
                          key={tick.toFixed(3)}
                          style={{
                            left: `${percentAtTime(tick)}%`,
                            transform:
                              tick <= rangeStart
                                ? "none"
                                : tick >= rangeEnd - tickStep * 0.5
                                  ? "translateX(-100%)"
                                  : "translateX(-50%)",
                          }}
                        >
                          <i />
                          <em>{tickLabel(tick, tickStep)}</em>
                        </span>
                      ))}
                    </div>
                    <div
                      className="timeline"
                      ref={timeline}
                      onPointerDown={(e) => {
                        if (e.target !== e.currentTarget || !timeline.current)
                          return;
                        const r = timeline.current.getBoundingClientRect();
                        seek(timeAtFraction((e.clientX - r.left) / r.width));
                      }}
                      onDoubleClick={() => zoomTo(1)}
                    >
                      <div className="timeline-texture" />
                      <div
                        className="clip-selection"
                        style={{
                          left: `${percentAtTime(edit.start)}%`,
                          width: `${((edit.end - edit.start) / rangeSpan) * 100}%`,
                        }}
                      >
                        <button
                          className="trim-handle start"
                          aria-label="کشیدن شروع کلیپ"
                          onPointerDown={(e) => dragHandle(e, "start")}
                        >
                          Ⅱ
                        </button>
                        <span>کلیپ انتخاب‌شده · {clock(clipDuration)}</span>
                        <button
                          className="trim-handle end"
                          aria-label="کشیدن پایان کلیپ"
                          onPointerDown={(e) => dragHandle(e, "end")}
                        >
                          Ⅱ
                        </button>
                      </div>
                      <div
                        className="playhead"
                        role="slider"
                        tabIndex={0}
                        aria-label="موقعیت نشانگر پخش"
                        aria-valuemin={0}
                        aria-valuemax={duration}
                        aria-valuenow={Number(time.toFixed(3))}
                        aria-valuetext={timecode(time)}
                        onPointerDown={dragPlayhead}
                        onKeyDown={nudgePlayhead}
                        style={{ left: `${percentAtTime(time)}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TABS 2–6: OTHER STUDIO TOOLS */}
            {tab !== "clip" && (
              <div
                className="tool-panel"
                id="editor-tool-panel"
                role="tabpanel"
                aria-labelledby={`tool-tab-${tab}`}
              >
                {/* TAB 2: SUBTITLES (Bento Launcher Grid + Modals) */}
                {tab === "subtitles" && (
                  <div className="subtitles-deck">
                    <div className="subtitles-quick-bar">
                      <div className="subtitles-quick-info">
                        <span className="quick-badge">
                          <Type size={13} />
                          {style.track_id || style.fa_track_id
                            ? `${mainTrackCues.length} خط انگلیسی · ${faTrackCues.length} خط فارسی`
                            : "هیچ زیرنویسی انتخاب نشده است"}
                        </span>
                        <span className="quick-tip">
                          برای ویرایش سریع هر خط، ویدیو را متوقف کرده و مستقیم
                          روی متن زیرنویس داخل ویدیو کلیک کنید.
                        </span>
                      </div>
                      <div className="subtitles-quick-actions">
                        <Check
                          checked={style.burn}
                          onChange={(v) => update("subtitles", "burn", v)}
                        >
                          چسباندن به خروجی
                        </Check>
                        <Check
                          checked={style.soft}
                          onChange={(v) => update("subtitles", "soft", v)}
                        >
                          زیرنویس نرم
                        </Check>
                      </div>
                    </div>

                    <div className="subtitles-bento-grid">
                      <ToolSection
                        title="منبع زیرنویس"
                        description="مسیر انگلیسی و فارسی را انتخاب کنید یا زیرنویس خودکار بسازید."
                        icon={<Languages size={18} />}
                        badge={
                          style.track_id || style.fa_track_id
                            ? "مسیر فعال"
                            : "انتخاب نشده"
                        }
                        modal
                        action={
                          <button
                            className="secondary tool-action"
                            disabled={
                              busy ||
                              autoSubtitleBlocked ||
                              !!autoSubtitleJob ||
                              autoStarting
                            }
                            onClick={() => autoSubtitles()}
                            title={autoSubtitleTitle}
                          >
                            {autoSubtitleJob || autoStarting ? (
                              <LoaderCircle className="spin" size={15} />
                            ) : autoSubtitlesReady ? (
                              <CheckIcon size={15} />
                            ) : (
                              <Sparkles size={15} />
                            )}
                            {autoSubtitleJob
                              ? `زیرنویس خودکار ${autoSubtitleJob.progress.toFixed(0)}%`
                              : autoStarting
                                ? "در حال شروع…"
                                : autoSubtitlesReady
                                  ? "زیرنویس آماده است"
                                  : "زیرنویس خودکار"}
                          </button>
                        }
                      >
                        <div className="tool-grid two">
                          <label className="tool-field">
                            مسیر اصلی
                            <Select
                              value={style.track_id}
                              onChange={(v) =>
                                update("subtitles", "track_id", v)
                              }
                              options={[
                                ["", "بدون زیرنویس اصلی"],
                                ...(project.subtitles || []).map((t) => [
                                  t.id,
                                  `${t.title}${!t.editable ? " (تصویری — پشتیبانی نمی‌شود)" : ""}`,
                                ]),
                              ]}
                            />
                          </label>
                          <label className="tool-field">
                            مسیر فارسی
                            <Select
                              value={style.fa_track_id}
                              onChange={(v) =>
                                update("subtitles", "fa_track_id", v)
                              }
                              options={[
                                ["", "بدون زیرنویس فارسی"],
                                ...(project.subtitles || []).map((t) => [
                                  t.id,
                                  `${t.title}${!t.editable ? " (تصویری — پشتیبانی نمی‌شود)" : ""}`,
                                ]),
                              ]}
                            />
                          </label>
                        </div>
                        <div className="tool-inline">
                          <Check
                            checked={style.burn}
                            onChange={(v) => update("subtitles", "burn", v)}
                          >
                            چسباندن به خروجی
                          </Check>
                          <Check
                            checked={style.soft}
                            onChange={(v) => update("subtitles", "soft", v)}
                          >
                            استفاده از زیرنویس نرم ویدیو
                          </Check>
                        </div>
                        <p className="tool-hint">
                          برای ویرایش متن، روی زیرنویس خود ویدیو کلیک کنید؛ این
                          امکان فقط در بخش زیرنویس فعال است.
                        </p>
                        {autoSubtitleTooLong && (
                          <p className="inline-error">
                            {local ? "این بازه" : "این ویدیو"}{" "}
                            {clock(autoSubtitleSpan)} است. زیرنویس خودکار تا{" "}
                            {autoSubtitleLimitMinutes} دقیقه محدود است؛ سقف را
                            در تنظیمات → زیرنویس خودکار افزایش دهید.
                          </p>
                        )}
                      </ToolSection>

                      <ToolSection
                        title="متن کامل زیرنویس"
                        description="همه دیالوگ‌ها همراه با زمان؛ برای کپی یکجا یا ویرایش سریع"
                        icon={<FileText size={18} />}
                        badge={
                          totalCuesCount > 0
                            ? `${totalCuesCount} دیالوگ SRT`
                            : "خالی"
                        }
                        modal
                        onOpen={() => prepareBulkEditor()}
                      >
                        <div className="bulk-toolbar">
                          <div
                            className="bulk-tabs"
                            role="group"
                            aria-label="انتخاب زبان زیرنویس"
                          >
                            <button
                              type="button"
                              className={
                                "bulk-tab" +
                                (bulkRole === "main" ? " active" : "")
                              }
                              aria-pressed={bulkRole === "main"}
                              disabled={!style.track_id}
                              onClick={() => prepareBulkEditor("main")}
                            >
                              انگلیسی
                            </button>
                            <button
                              type="button"
                              className={
                                "bulk-tab" +
                                (bulkRole === "fa" ? " active" : "")
                              }
                              aria-pressed={bulkRole === "fa"}
                              disabled={!style.fa_track_id}
                              onClick={() => prepareBulkEditor("fa")}
                            >
                              فارسی
                            </button>
                          </div>
                          <span className="bulk-count">
                            {bulkCueCount} زیرنویس
                          </span>
                          <div className="player-spacer" />
                          <span className="bulk-format">قالب SRT</span>
                        </div>
                        <p className="hint">
                          متن کامل را یکجا کپی کنید، به AI بدهید یا همین‌جا سریع
                          ویرایش کنید. ساختار زمان‌بندی SRT را حفظ کنید تا ذخیره
                          درست انجام شود.
                        </p>
                        <textarea
                          className="bulk-editor"
                          value={bulkText}
                          onChange={(event) => setBulkText(event.target.value)}
                          spellCheck={false}
                          dir="ltr"
                          aria-label="متن کامل زیرنویس با زمان‌بندی SRT"
                        />
                        <div className="tool-inline bulk-actions">
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => void copyBulkText()}
                          >
                            <Copy size={14} /> کپی همه
                          </button>
                          <button
                            type="button"
                            className="primary"
                            disabled={bulkSaving}
                            onClick={() => void saveBulkText()}
                          >
                            {bulkSaving ? (
                              <LoaderCircle className="spin" size={14} />
                            ) : (
                              <Save size={14} />
                            )}{" "}
                            ذخیره تغییرات
                          </button>
                          <span className="tool-hint">
                            هر زیرنویس شامل شماره، زمان شروع و پایان، و متن است.
                          </span>
                        </div>
                      </ToolSection>

                      <ToolSection
                        title="استایل انگلیسی"
                        description="فونت، اندازه و رنگ زیرنویس اصلی"
                        icon={<Type size={18} />}
                        badge={
                          <span className="style-badge-pill">
                            <i style={{ background: style.color }} />
                            {style.font} · {style.size}px
                          </span>
                        }
                        modal
                        action={
                          <Check
                            checked={style.bold}
                            onChange={(v) => update("subtitles", "bold", v)}
                          >
                            ضخیم
                          </Check>
                        }
                      >
                        <div className="tool-grid style-grid">
                          <label className="tool-field">
                            فونت
                            <Select
                              value={style.font}
                              options={fonts}
                              onChange={(v) => update("subtitles", "font", v)}
                            />
                          </label>
                          <label className="tool-field">
                            اندازه
                            <Num
                              value={style.size}
                              min={12}
                              max={160}
                              step={1}
                              onChange={(v) => update("subtitles", "size", v)}
                            />
                          </label>
                          <label className="tool-field color">
                            رنگ
                            <Color
                              value={style.color}
                              name="رنگ متن"
                              onChange={(v) => update("subtitles", "color", v)}
                            />
                          </label>
                        </div>
                        <div className="tool-grid style-grid secondary">
                          <label className="tool-field color">
                            رنگ حاشیه
                            <Color
                              value={style.outline_color}
                              name="رنگ حاشیه"
                              onChange={(v) =>
                                update("subtitles", "outline_color", v)
                              }
                            />
                          </label>
                          <label className="tool-field">
                            ضخامت حاشیه
                            <Num
                              value={style.outline}
                              min={0}
                              max={12}
                              onChange={(v) =>
                                update("subtitles", "outline", v)
                              }
                            />
                          </label>
                          <label className="tool-field">
                            سایه
                            <Num
                              value={style.shadow}
                              min={0}
                              max={12}
                              onChange={(v) => update("subtitles", "shadow", v)}
                            />
                          </label>
                        </div>
                      </ToolSection>

                      <ToolSection
                        title="استایل فارسی"
                        description="فونت، اندازه و رنگ زیرنویس فارسی"
                        icon={<Sparkles size={18} />}
                        badge={
                          <span className="style-badge-pill">
                            <i style={{ background: style.fa_color }} />
                            {style.fa_font} · {style.fa_size}px
                          </span>
                        }
                        modal
                        action={
                          <Check
                            checked={style.fa_bold}
                            onChange={(v) => update("subtitles", "fa_bold", v)}
                          >
                            ضخیم
                          </Check>
                        }
                      >
                        <div className="tool-grid style-grid">
                          <label className="tool-field">
                            فونت فارسی
                            <Select
                              value={style.fa_font}
                              options={fonts}
                              onChange={(v) =>
                                update("subtitles", "fa_font", v)
                              }
                            />
                          </label>
                          <label className="tool-field">
                            اندازه فارسی
                            <Num
                              value={style.fa_size}
                              min={12}
                              max={160}
                              step={1}
                              onChange={(v) =>
                                update("subtitles", "fa_size", v)
                              }
                            />
                          </label>
                          <label className="tool-field color">
                            رنگ فارسی
                            <Color
                              value={style.fa_color}
                              name="رنگ متن فارسی"
                              onChange={(v) =>
                                update("subtitles", "fa_color", v)
                              }
                            />
                          </label>
                        </div>
                        <div className="tool-grid style-grid secondary">
                          <label className="tool-field color">
                            رنگ حاشیه فارسی
                            <Color
                              value={style.fa_outline_color}
                              name="رنگ حاشیه فارسی"
                              onChange={(v) =>
                                update("subtitles", "fa_outline_color", v)
                              }
                            />
                          </label>
                          <label className="tool-field">
                            ضخامت حاشیه فارسی
                            <Num
                              value={style.fa_outline}
                              min={0}
                              max={12}
                              onChange={(v) =>
                                update("subtitles", "fa_outline", v)
                              }
                            />
                          </label>
                          <label className="tool-field">
                            سایه فارسی
                            <Num
                              value={style.fa_shadow}
                              min={0}
                              max={12}
                              onChange={(v) =>
                                update("subtitles", "fa_shadow", v)
                              }
                            />
                          </label>
                        </div>
                      </ToolSection>

                      <ToolSection
                        title="چیدمان و کادر"
                        description="جای متن، فاصله‌ها و پس‌زمینه"
                        icon={<LayoutTemplate size={18} />}
                        badge={`${
                          style.position === "bottom"
                            ? "پایین"
                            : style.position === "middle"
                              ? "میانه"
                              : "بالا"
                        } · حاشیه ${style.margin}`}
                        modal
                      >
                        <div className="tool-grid layout-grid">
                          <label className="tool-field">
                            موقعیت
                            <Select
                              value={style.position}
                              options={[
                                ["bottom", "پایین"],
                                ["middle", "میانه"],
                                ["top", "بالا"],
                              ]}
                              onChange={(v) =>
                                update("subtitles", "position", v)
                              }
                            />
                          </label>
                          <label className="tool-field">
                            تراز
                            <Select
                              value={style.align}
                              options={[
                                ["left", "چپ"],
                                ["center", "وسط"],
                                ["right", "راست"],
                              ]}
                              onChange={(v) => update("subtitles", "align", v)}
                            />
                          </label>
                          <label className="tool-field">
                            فاصله بالای فارسی
                            <Num
                              value={style.gap}
                              min={0}
                              max={200}
                              onChange={(v) => update("subtitles", "gap", v)}
                            />
                          </label>
                          <label className="tool-field">
                            حاشیه
                            <Num
                              value={style.margin}
                              min={0}
                              max={400}
                              step={1}
                              onChange={(v) => update("subtitles", "margin", v)}
                            />
                          </label>
                          <label className="tool-field">
                            انحراف زمان
                            <Num
                              value={style.offset}
                              min={-600}
                              max={600}
                              step={0.1}
                              onChange={(v) => update("subtitles", "offset", v)}
                            />
                          </label>
                        </div>
                        <div className="tool-inline">
                          <Check
                            checked={style.box}
                            onChange={(v) => update("subtitles", "box", v)}
                          >
                            کادر پس‌زمینه
                          </Check>
                          {style.box && (
                            <label className="tool-field">
                              شفافیت کادر
                              <Num
                                value={style.box_opacity}
                                min={0}
                                max={1}
                                step={0.01}
                                onChange={(v) =>
                                  update("subtitles", "box_opacity", v)
                                }
                              />
                            </label>
                          )}
                        </div>
                      </ToolSection>

                      <ToolSection
                        title="بارگذاری و پیش‌فرض‌ها"
                        description="افزودن فایل زیرنویس و ذخیره استایل فعلی برای پروژه‌های جدید"
                        icon={<Upload size={18} />}
                        badge="فایل SRT / ASS"
                        modal
                      >
                        <div className="tool-inline">
                          <FileButton
                            label="بارگذاری زیرنویس انگلیسی"
                            accept=".srt,.ass,.ssa,.vtt"
                            disabled={busy}
                            onFile={(f) => upload("subtitles", f, "main")}
                          />
                          <FileButton
                            label="بارگذاری زیرنویس فارسی"
                            accept=".srt,.ass,.ssa,.vtt"
                            disabled={busy}
                            onFile={(f) => upload("subtitles", f, "fa")}
                          />
                          {project.subtitles
                            ?.find((t) => t.id === style.track_id)
                            ?.codec.match(/ass|ssa/) && (
                            <Check
                              checked={style.preserve_ass}
                              onChange={(v) =>
                                update("subtitles", "preserve_ass", v)
                              }
                            >
                              حفظ استایل اصلی ASS
                            </Check>
                          )}
                          <button
                            type="button"
                            className="adv-save-default"
                            disabled={savingDefaults}
                            onClick={() => saveAsDefaults("subtitles")}
                          >
                            <Save size={13} /> ذخیره به‌عنوان پیش‌فرض
                          </button>
                        </div>
                      </ToolSection>
                    </div>
                  </div>
                )}

                {/* TAB 3: CROP & FRAMING (2-Column Studio Deck) */}
                {tab === "crop" && (
                  <div className="studio-two-col">
                    <ToolSection
                      title="قاب و نسبت تصویر خروجی"
                      description="نسبت ابعاد ویدیو و نحوه پر شدن کادر را انتخاب کنید"
                      icon={<Frame size={18} />}
                      defaultOpen
                    >
                      <div className="tool-field full">
                        <span className="field-caption">نسبت تصویر</span>
                        <div className="aspect-options compact">
                          {["original", "16:9", "9:16", "1:1", "4:5"].map(
                            (v) => (
                              <button
                                key={v}
                                type="button"
                                className={
                                  edit.crop.ratio === v ? "active" : ""
                                }
                                onClick={() => update("crop", "ratio", v)}
                              >
                                <span
                                  style={{
                                    aspectRatio:
                                      v === "original"
                                        ? 16 / 9
                                        : Number(v.split(":")[0]) /
                                          Number(v.split(":")[1]),
                                  }}
                                />
                                <strong>{v === "original" ? "اصلی" : v}</strong>
                              </button>
                            ),
                          )}
                        </div>
                      </div>

                      <div className="tool-grid two" style={{ marginTop: 14 }}>
                        <label className="tool-field">
                          حالت قرارگیری در قاب
                          <Select
                            value={edit.crop.mode}
                            options={[
                              ["fill", "پر کردن قاب (برش لبه‌ها)"],
                              ["fit", "همراه با حاشیه (کامل)"],
                            ]}
                            onChange={(v) => update("crop", "mode", v)}
                          />
                        </label>
                      </div>
                    </ToolSection>

                    <ToolSection
                      title="تنظیم دقیق کادربندی و مرکز تصویر"
                      description="ویدیو را با ماوس روی صحنه بکشید یا با اسلایدرها تنظیم کنید"
                      icon={<Move size={18} />}
                      defaultOpen
                    >
                      <div
                        className="tool-inline"
                        style={{ marginTop: 0, marginBottom: 16 }}
                      >
                        <button
                          type="button"
                          className={
                            "secondary tool-action " +
                            (cropDrag ? "selected" : "")
                          }
                          onClick={() => setCropDrag(!cropDrag)}
                        >
                          <Move size={15} />
                          {cropDrag ? "پایان جابه‌جایی" : "جابه‌جایی با کشیدن"}
                        </button>
                        <button
                          type="button"
                          className="secondary tool-action"
                          onClick={() => {
                            update("crop", "x", 0.5);
                            update("crop", "y", 0.5);
                          }}
                        >
                          <Crosshair size={15} />
                          وسط‌چین کردن قاب
                        </button>
                      </div>
                      <div className="tool-grid two">
                        <div className="tool-field full">
                          <Slider
                            label="موقعیت افقی (X)"
                            value={edit.crop.x}
                            min={0}
                            max={1}
                            step={0.01}
                            onChange={(v) => update("crop", "x", v)}
                          />
                        </div>
                        <div className="tool-field full">
                          <Slider
                            label="موقعیت عمودی (Y)"
                            value={edit.crop.y}
                            min={0}
                            max={1}
                            step={0.01}
                            onChange={(v) => update("crop", "y", v)}
                          />
                        </div>
                      </div>
                    </ToolSection>
                  </div>
                )}

                {/* TAB 4: WATERMARK STUDIO */}
                {tab === "watermark" && (
                  <div className="watermark-deck">
                    <div className="watermark-top-bar">
                      <div className="wm-kind-switcher">
                        <span className="wm-kind-label">نوع واترمارک:</span>
                        {[
                          ["none", "بدون واترمارک"],
                          ["text", "متن"],
                          ["image", "تصویر"],
                        ].map(([val, label]) => (
                          <button
                            key={val}
                            type="button"
                            className={
                              "wm-kind-btn" + (wm.kind === val ? " active" : "")
                            }
                            onClick={() => update("watermark", "kind", val)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="adv-save-default"
                        disabled={savingDefaults}
                        onClick={() => saveAsDefaults("watermark")}
                      >
                        <Save size={14} /> ذخیره به‌عنوان پیش‌فرض
                      </button>
                    </div>

                    {wm.kind === "none" ? (
                      <div className="studio-empty-state">
                        <Stamp size={24} />
                        <p>
                          واترمارک غیرفعال است. برای افزودن شناسه کانال یا لوگو،
                          گزینه «متن» یا «تصویر» را از بالا انتخاب کنید.
                        </p>
                      </div>
                    ) : (
                      <div className="studio-two-col">
                        <ToolSection
                          title={
                            wm.kind === "text"
                              ? "محتوا و استایل واترمارک متنی"
                              : "تصویر و ابعاد لوگو"
                          }
                          description={
                            wm.kind === "text"
                              ? "متن، فونت، رنگ و شفافیت نشان"
                              : "انتخاب یا بارگذاری فایل PNG/JPG و تنظیم اندازه"
                          }
                          icon={<Stamp size={18} />}
                          defaultOpen
                        >
                          {wm.kind === "text" && !wm.template && (
                            <div className="tool-grid two">
                              <label className="tool-field full">
                                متن واترمارک
                                <Input
                                  className="h-9 text-xs"
                                  value={wm.text}
                                  maxLength={300}
                                  onChange={(e) =>
                                    update("watermark", "text", e.target.value)
                                  }
                                  placeholder="@نامشما"
                                />
                              </label>
                              <label className="tool-field">
                                فونت
                                <Select
                                  value={wm.font}
                                  options={fonts}
                                  onChange={(v) =>
                                    update("watermark", "font", v)
                                  }
                                />
                              </label>
                              <label className="tool-field">
                                اندازه
                                <Num
                                  value={wm.size}
                                  min={12}
                                  max={200}
                                  step={1}
                                  onChange={(v) =>
                                    update("watermark", "size", v)
                                  }
                                />
                              </label>
                              <label className="tool-field color">
                                رنگ
                                <Color
                                  value={wm.color}
                                  name="رنگ واترمارک"
                                  onChange={(v) =>
                                    update("watermark", "color", v)
                                  }
                                />
                              </label>
                              <label className="tool-field">
                                شفافیت
                                <Num
                                  value={wm.opacity}
                                  min={0}
                                  max={1}
                                  step={0.01}
                                  onChange={(v) =>
                                    update("watermark", "opacity", v)
                                  }
                                />
                              </label>
                              <label className="tool-field">
                                حاشیه از لبه
                                <Num
                                  value={wm.margin}
                                  min={0}
                                  max={400}
                                  step={1}
                                  onChange={(v) =>
                                    update("watermark", "margin", v)
                                  }
                                />
                              </label>
                            </div>
                          )}

                          {wm.kind === "text" && wm.template && (
                            <p className="tool-hint" style={{ marginTop: 0 }}>
                              قالب چندعنصری فعال است. از بخش زیر عناصر و سطرها
                              را ویرایش کنید.
                            </p>
                          )}

                          {wm.kind === "image" && (
                            <>
                              <div className="tool-grid two">
                                <label className="tool-field">
                                  تصویر
                                  <Select
                                    value={wm.asset_id}
                                    options={[
                                      ["", "انتخاب تصویر"],
                                      ...(project.assets || [])
                                        .filter((a) => a.kind === "watermark")
                                        .map((a) => [a.id, a.name]),
                                    ]}
                                    onChange={(v) =>
                                      update("watermark", "asset_id", v)
                                    }
                                  />
                                </label>
                                <label className="tool-field">
                                  شفافیت
                                  <Num
                                    value={wm.opacity}
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    onChange={(v) =>
                                      update("watermark", "opacity", v)
                                    }
                                  />
                                </label>
                                <div className="tool-field full">
                                  <Slider
                                    label="عرض تصویر نسبت به قاب"
                                    value={wm.width}
                                    min={0.02}
                                    max={0.8}
                                    step={0.01}
                                    onChange={(v) =>
                                      update("watermark", "width", v)
                                    }
                                  />
                                </div>
                              </div>
                              <div className="tool-inline">
                                <FileButton
                                  label="بارگذاری تصویر"
                                  accept=".png,.jpg,.jpeg"
                                  disabled={busy}
                                  onFile={(f) => upload("watermark", f)}
                                />
                              </div>
                            </>
                          )}

                          {wm.kind === "text" && (
                            <details
                              className="tool-more"
                              style={{ marginTop: 14 }}
                            >
                              <summary>
                                {wm.template
                                  ? "ویرایش قالب چندعنصری"
                                  : "قالب چندعنصری پیشرفته"}
                              </summary>
                              {wm.template ? (
                                <WatermarkTemplateEditor
                                  template={wm.template}
                                  onChange={(template) =>
                                    update("watermark", "template", template)
                                  }
                                />
                              ) : (
                                <button
                                  className="secondary"
                                  type="button"
                                  onClick={() =>
                                    update(
                                      "watermark",
                                      "template",
                                      templateFromLegacy(wm),
                                    )
                                  }
                                >
                                  <Stamp size={15} /> تبدیل به قالب چندعنصری
                                </button>
                              )}
                            </details>
                          )}
                        </ToolSection>

                        <ToolSection
                          title="موقعیت مکانی و زمان‌بندی نمایش"
                          description="گوشه دلخواه را انتخاب کنید یا نشان را مستقیم روی ویدیو بکشید"
                          icon={<Move size={18} />}
                          defaultOpen
                        >
                          <div className="corner-snap-bar">
                            <span className="field-caption">
                              چسباندن سریع به گوشه:
                            </span>
                            <div className="corner-buttons">
                              {[
                                {
                                  id: "tr",
                                  label: "بالا راست",
                                  icon: CornerUpRight,
                                },
                                {
                                  id: "tl",
                                  label: "بالا چپ",
                                  icon: CornerUpLeft,
                                },
                                {
                                  id: "br",
                                  label: "پایین راست",
                                  icon: CornerDownRight,
                                },
                                {
                                  id: "bl",
                                  label: "پایین چپ",
                                  icon: CornerDownLeft,
                                },
                              ].map((c) => (
                                <button
                                  key={c.id}
                                  type="button"
                                  className="corner-btn"
                                  onClick={() => {
                                    const edge = wm.template ? 0.12 : 0;
                                    update(
                                      "watermark",
                                      "x",
                                      c.id.endsWith("l") ? edge : 1 - edge,
                                    );
                                    update(
                                      "watermark",
                                      "y",
                                      c.id.startsWith("t") ? edge : 1 - edge,
                                    );
                                  }}
                                >
                                  <c.icon size={13} />
                                  {c.label}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="tool-grid two">
                            <div className="tool-field full">
                              <Slider
                                label="موقعیت افقی"
                                value={wm.x}
                                min={0}
                                max={1}
                                step={0.01}
                                onChange={(v) => update("watermark", "x", v)}
                              />
                            </div>
                            <div className="tool-field full">
                              <Slider
                                label="موقعیت عمودی"
                                value={wm.y}
                                min={0}
                                max={1}
                                step={0.01}
                                onChange={(v) => update("watermark", "y", v)}
                              />
                            </div>
                            <label className="tool-field">
                              نمایش از (ثانیه)
                              <Num
                                value={wm.start}
                                min={0}
                                max={edit.end - edit.start}
                                onChange={(v) =>
                                  update("watermark", "start", v)
                                }
                              />
                            </label>
                            <label className="tool-field">
                              تا (ثانیه)
                              <Input
                                className="h-9 text-xs"
                                type="number"
                                min={0}
                                step={0.1}
                                value={wm.end ?? ""}
                                placeholder="پایان کلیپ"
                                onChange={(e) =>
                                  update(
                                    "watermark",
                                    "end",
                                    e.target.value === ""
                                      ? null
                                      : Number(e.target.value),
                                  )
                                }
                              />
                            </label>
                          </div>
                          <p className="hint">
                            زمان‌ها نسبت به شروع کلیپ محاسبه می‌شوند.
                          </p>
                        </ToolSection>
                      </div>
                    )}
                  </div>
                )}

                {/* TAB 5: AUDIO MIXER (2-Channel Studio Mixer) */}
                {tab === "audio" && (
                  <div className="studio-two-col">
                    <ToolSection
                      title="کانال ۱: صدای اصلی ویدیو"
                      description="انتخاب مسیر صوتی، تقویت صدا یا بی‌صدا کردن کامل"
                      icon={<Volume2 size={18} />}
                      defaultOpen
                      action={
                        <Check
                          checked={edit.audio.mute}
                          onChange={(v) => update("audio", "mute", v)}
                        >
                          بی‌صدا کردن صدای اصلی
                        </Check>
                      }
                    >
                      <div className="tool-grid two">
                        <label className="tool-field full">
                          مسیر صدای اصلی
                          <Select
                            value={String(edit.audio.track)}
                            options={project.metadata.audio.map((a, i) => [
                              String(i),
                              a.title ||
                                `مسیر ${i + 1} · ${a.language || a.codec}`,
                            ])}
                            onChange={(v) =>
                              update("audio", "track", Number(v))
                            }
                          />
                        </label>
                        <div className="tool-field full">
                          <Slider
                            label="بلندی صدای اصلی"
                            value={edit.audio.volume}
                            min={0}
                            max={3}
                            step={0.05}
                            suffix="×"
                            onChange={(v) => update("audio", "volume", v)}
                          />
                        </div>
                      </div>
                    </ToolSection>

                    <ToolSection
                      title="کانال ۲: موسیقی پس‌زمینه"
                      description="افزودن ترک صوتی، تنظیم بلندی و محو تدریجی ابتدا و انتها"
                      icon={<Music size={18} />}
                      defaultOpen
                      action={
                        <FileButton
                          label="بارگذاری موسیقی"
                          accept="audio/*,.m4a,.flac"
                          disabled={busy}
                          onFile={(f) => upload("music", f)}
                        />
                      }
                    >
                      <div className="tool-grid two">
                        <label className="tool-field full">
                          موسیقی پس‌زمینه
                          <Select
                            value={edit.audio.music_id}
                            options={[
                              ["", "بدون موسیقی"],
                              ...(project.assets || [])
                                .filter((a) => a.kind === "music")
                                .map((a) => [a.id, a.name]),
                            ]}
                            onChange={(v) => update("audio", "music_id", v)}
                          />
                        </label>
                        <div className="tool-field full">
                          <Slider
                            label="صدای موسیقی"
                            value={edit.audio.music_volume}
                            min={0}
                            max={3}
                            step={0.05}
                            suffix="×"
                            onChange={(v) => update("audio", "music_volume", v)}
                          />
                        </div>
                        <label className="tool-field">
                          محو ورود (ثانیه)
                          <Num
                            value={edit.audio.fade_in}
                            min={0}
                            max={30}
                            onChange={(v) => update("audio", "fade_in", v)}
                          />
                        </label>
                        <label className="tool-field">
                          محو خروج (ثانیه)
                          <Num
                            value={edit.audio.fade_out}
                            min={0}
                            max={30}
                            onChange={(v) => update("audio", "fade_out", v)}
                          />
                        </label>
                      </div>
                      <p className="hint">
                        موسیقی از ابتدای کلیپ شروع می‌شود و در صورت نیاز تکرار
                        می‌شود.
                      </p>
                    </ToolSection>
                  </div>
                )}

                {/* TAB 6: EXPORT & TELEGRAM COVER STUDIO */}
                {tab === "export" && (
                  <div className="studio-two-col">
                    <ToolSection
                      title="تنظیمات خروجی و کیفیت رندر"
                      description="نام فایل، کیفیت کدگذاری، رزولوشن و نرخ فریم"
                      icon={<Sliders size={18} />}
                      defaultOpen
                    >
                      <div className="tool-grid two">
                        <label className="tool-field full">
                          نام فایل
                          <Input
                            className="h-9 text-xs"
                            value={edit.filename}
                            onChange={(e) => root("filename", e.target.value)}
                            maxLength={100}
                          />
                        </label>
                        <label className="tool-field">
                          کیفیت
                          <Select
                            value={edit.quality}
                            onChange={(v) => root("quality", v)}
                            options={[
                              ["fast", "سریع"],
                              ["balanced", "متعادل"],
                              ["high", "کیفیت بالا"],
                            ]}
                          />
                        </label>
                        <label className="tool-field">
                          رزولوشن
                          <Select
                            value={String(edit.resolution)}
                            onChange={(v) => root("resolution", Number(v))}
                            options={[
                              ["720", "720px"],
                              ["1080", "1080px"],
                              ["1920", "Full HD"],
                            ]}
                          />
                        </label>
                        <label className="tool-field">
                          نرخ فریم
                          <Select
                            value={String(edit.fps)}
                            onChange={(v) => root("fps", Number(v))}
                            options={[24, 25, 30, 50, 60].map((v) => [
                              String(v),
                              `${v} fps`,
                            ])}
                          />
                        </label>
                      </div>
                      <p className="adv-footnote">
                        مشخصات منبع: {project.metadata.width}×
                        {project.metadata.height} ·{" "}
                        {project.metadata.video_codec?.toUpperCase()} ·{" "}
                        {project.metadata.audio.length} صدا ·{" "}
                        {project.subtitles?.length || 0} زیرنویس
                      </p>
                    </ToolSection>

                    <ToolSection
                      title="کاور تلگرام (فریم تمیز بدون زیرنویس)"
                      description={
                        coverFrame
                          ? `فریم انتخاب‌شده در ${timecode(coverFrame.time)}`
                          : "انتخاب فریم کاور از داخل کلیپ برای ارسال به تلگرام"
                      }
                      icon={<Scan size={18} />}
                      defaultOpen
                    >
                      <div className="tool-grid cover-grid">
                        <div className="tool-field cover-preview-field">
                          <div className="cover-frame-preview">
                            {coverFrame ? (
                              <img
                                src={`/api/media/project/${id}/cover-frame?v=${coverFrame.revision}`}
                                alt={`کاور انتخاب‌شده تلگرام در ${timecode(coverFrame.time)}`}
                              />
                            ) : (
                              <span>
                                <Scan size={22} />
                                کاور خودکار
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="tool-field cover-copy">
                          <strong>
                            {coverFrame
                              ? `فریم منبع ${timecode(coverFrame.time)}`
                              : "فریمی انتخاب نشده است"}
                          </strong>
                          <small>
                            {coverFrame
                              ? "بدون زیرنویس چسبیده"
                              : "پس از رندر، فریم رندر‌شده استفاده می‌شود"}
                          </small>
                          <div className="tool-inline">
                            <button
                              type="button"
                              className="secondary"
                              disabled={
                                coverBusy ||
                                !edit ||
                                time < edit.start ||
                                time >= edit.end
                              }
                              onClick={() => chooseCoverFrame(time)}
                              title={
                                !edit || time < edit.start || time >= edit.end
                                  ? "ابتدا نشانگر پخش را داخل کلیپ فعلی ببرید"
                                  : "ذخیره فریم در موقعیت فعلی نشانگر پخش"
                              }
                            >
                              {coverBusy ? (
                                <LoaderCircle className="spin" size={14} />
                              ) : (
                                <Frame size={14} />
                              )}{" "}
                              استفاده از فریم فعلی
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              disabled={coverBusy}
                              onClick={generateCoverFrames}
                            >
                              ساخت ۶ فریم
                            </button>
                            {coverFrame && (
                              <button
                                type="button"
                                className="text-link"
                                disabled={coverBusy}
                                onClick={clearCoverFrame}
                              >
                                پاک کردن انتخاب
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                      {coverOutsideClip && (
                        <p className="inline-error">
                          این کاور خارج از برش فعلی است و نادیده گرفته می‌شود.
                          فریمی از محدوده کلیپ انتخاب کنید.
                        </p>
                      )}
                      {coverCandidates.length > 0 && (
                        <div className="cover-frame-strip">
                          {coverCandidates.map((candidate) => (
                            <button
                              key={`${candidate.url}-${candidate.time}`}
                              type="button"
                              className={
                                "cover-frame-option " +
                                (coverFrame &&
                                Math.abs(coverFrame.time - candidate.time) <
                                  0.002
                                  ? "selected"
                                  : "")
                              }
                              disabled={coverBusy}
                              onClick={() => chooseCoverFrame(candidate.time)}
                              title={`استفاده از فریم ${timecode(candidate.time)}`}
                            >
                              <img
                                src={candidate.url}
                                alt={`گزینه کاور در ${timecode(candidate.time)}`}
                              />
                              <span>{timecode(candidate.time)}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </ToolSection>
                  </div>
                )}
              </div>
            )}
          </div>

          {edit.audio.music_id && (
            <audio
              ref={music}
              src={`/api/media/asset/${edit.audio.music_id}`}
              preload="auto"
              loop
            />
          )}

          {active.length > 0 && (
            <button className="activity-strip" onClick={onQueue}>
              <LoaderCircle className="spin" size={16} />
              <span>
                {active
                  .map(
                    (j) =>
                      `${j.kind === "render" ? "در حال رندر" : j.kind === "cover" ? "کاور" : "در حال پردازش"} · ${j.progress.toFixed(0)}%`,
                  )
                  .join("  /  ")}
              </span>
              <ArrowUpRight size={16} />
            </button>
          )}

          {rendered.length > 0 && (
            <div className="recent-renders">
              <span className="eyebrow">خروجی‌های اخیر این پروژه</span>
              <div className="recent-renders-grid">
                {rendered.map((c) => (
                  <button key={c.id} onClick={() => onClip(c)}>
                    <div className="render-play-icon">
                      <Play size={14} />
                    </div>
                    <span>
                      <strong>{c.name}</strong>
                      <small>
                        {c.preview ? "پیش‌نمایش رندر‌شده" : "کلیپ آماده"} ·{" "}
                        {clock(c.metadata.duration)}
                      </small>
                    </span>
                    <ArrowUpRight size={15} />
                  </button>
                ))}
              </div>
            </div>
          )}

          <p className="editor-hint">
            تغییرات روی فریم نهایی خروجی اعمال می‌شوند. برای بررسی دقیق
            زیرنویس‌ها، برش، واترمارک و صدا از پیش‌نمایش رندر استفاده کنید.
          </p>
        </div>
      </div>
    </div>
  );
}

function ToolSection({
  title,
  description,
  icon,
  badge,
  action,
  children,
  defaultOpen = true,
  modal = false,
  onOpen,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  modal?: boolean;
  onOpen?: () => boolean | void;
}) {
  const [open, setOpen] = useState(modal ? false : defaultOpen);

  useEffect(() => {
    if (!modal || !open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [modal, open]);

  useEffect(() => {
    if (!modal || !open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [modal, open]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    if (onOpen && onOpen() === false) return;
    setOpen(true);
  }

  const body = (
    <>
      {action && <div className="tool-section-action-row">{action}</div>}
      {children}
    </>
  );

  return (
    <section
      className={
        "tool-section" + (open ? " open" : "") + (modal ? " is-modal" : "")
      }
    >
      <button
        type="button"
        className="tool-section-head"
        aria-expanded={open}
        aria-haspopup={modal ? "dialog" : undefined}
        onClick={toggle}
      >
        {icon && <span className="tool-section-icon">{icon}</span>}
        <span className="tool-section-heading">
          <span className="tool-section-title-row">
            <h3>{title}</h3>
            {badge && <span className="tool-section-badge">{badge}</span>}
          </span>
          {description && <span>{description}</span>}
        </span>
        {modal ? (
          <ChevronLeft
            className="section-chevron modal-chevron"
            size={16}
            aria-hidden="true"
          />
        ) : (
          <ChevronDown
            className="section-chevron"
            size={16}
            aria-hidden="true"
          />
        )}
      </button>
      {open && modal
        ? createPortal(
            <div
              className="tool-modal-shade"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setOpen(false);
              }}
            >
              <div
                className="tool-modal"
                role="dialog"
                aria-modal="true"
                aria-label={title}
              >
                <div className="tool-modal-head">
                  <div className="tool-modal-title-group">
                    {icon && <span className="tool-section-icon">{icon}</span>}
                    <div>
                      <h2>{title}</h2>
                      {description && <p>{description}</p>}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="بستن پنجره"
                    onClick={() => setOpen(false)}
                  >
                    <X size={18} />
                  </button>
                </div>
                <div className="tool-modal-body">{body}</div>
              </div>
            </div>,
            document.body,
          )
        : open && <div className="tool-section-body">{body}</div>}
    </section>
  );
}

function Num({
  value,
  onChange,
  min,
  max,
  step = 0.1,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <Input
      className="h-9 text-xs"
      type="number"
      value={Number(value.toFixed(3))}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        if (e.target.value !== "") onChange(Number(e.target.value));
      }}
    />
  );
}

const EMPTY_VALUE = "__empty__";

function Select({
  value,
  onChange,
  options,
  className,
  container,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[][];
  className?: string;
  container?: HTMLElement | null;
  "aria-label"?: string;
}) {
  return (
    <SelectRoot
      value={value === "" ? EMPTY_VALUE : value}
      onValueChange={(next) => onChange(next === EMPTY_VALUE ? "" : next)}
    >
      <SelectTrigger
        className={"h-9 text-xs " + (className || "")}
        aria-label={ariaLabel}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent container={container}>
        {options.map(([id, label]) => (
          <SelectItem key={id || EMPTY_VALUE} value={id || EMPTY_VALUE}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  suffix = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="slider-label">
      <span>
        {label}
        <strong>
          {Number(value.toFixed(2))}
          {suffix}
        </strong>
      </span>
      <RangeSlider
        className="my-2"
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => onChange(next)}
      />
    </div>
  );
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Label className="check text-xs font-normal text-[#d4d8e2]">
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <span>{children}</span>
    </Label>
  );
}

function FileButton({
  label,
  accept,
  onFile,
  disabled,
}: {
  label: string;
  accept: string;
  onFile: (f: File) => void;
  disabled: boolean;
}) {
  return (
    <label className={"file-button secondary " + (disabled ? "disabled" : "")}>
      <Upload size={14} />
      {disabled ? "در حال بارگذاری…" : label}
      <input
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.files?.[0]) onFile(e.target.files[0]);
          e.target.value = "";
        }}
      />
    </label>
  );
}

function Color({
  value,
  onChange,
  name,
}: {
  value: string;
  onChange: (v: string) => void;
  name: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="color-field">
      <input
        type="color"
        aria-label={`انتخابگر ${name}`}
        value={value}
        onInput={(e) => onChange(e.currentTarget.value)}
        onChange={(e) => onChange(e.target.value)}
      />
      <Input
        className="h-9 px-2 text-xs font-mono"
        type="text"
        aria-label={name}
        value={draft}
        maxLength={7}
        onChange={(e) => {
          setDraft(e.target.value);
          if (/^#[0-9a-fA-F]{6}$/.test(e.target.value))
            onChange(e.target.value);
        }}
        onBlur={() => setDraft(value)}
      />
    </div>
  );
}
