import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Play,
  Pause,
  Maximize,
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
  Move,
  Upload,
  Plus,
  Trash2,
  ArrowUpRight,
  Save,
  ZoomIn,
  ZoomOut,
  Scan,
  Sparkles,
  Languages,
  SlidersHorizontal,
  X,
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
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Slider as RangeSlider } from "./components/ui/slider";
import { Textarea } from "./components/ui/textarea";
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
  autoSubtitleLimitMinutes = 6,
  onError,
  toast,
  onClip,
  onQueue,
}: Props) {
  const [project, setProject] = useState<Project | null>(null),
    [edit, setEdit] = useState<Edit | null>(null),
    [cuesByTrack, setCuesByTrack] = useState<Record<string, Cue[]>>({}),
    [cueRole, setCueRole] = useState<"main" | "fa">("main"),
    [editingCue, setEditingCue] = useState<{
      trackId: string;
      index: number;
    } | null>(null),
    [cueDraft, setCueDraft] = useState(""),
    [tab, setTab] = useState("clip"),
    [panelOpen, setPanelOpen] = useState(false),
    [savedEditKey, setSavedEditKey] = useState(""),
    [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
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
    [cuePage, setCuePage] = useState(0),
    [zoom, setZoom] = useState(1),
    [timelineWidth, setTimelineWidth] = useState(0),
    [scrollLeft, setScrollLeft] = useState(0),
    [refine, setRefine] = useState<{ start: number; end: number } | null>(null);
  const video = useRef<HTMLVideoElement>(null),
    music = useRef<HTMLAudioElement>(null),
    frame = useRef<HTMLDivElement>(null),
    watermark = useRef<HTMLDivElement>(null),
    stage = useRef<HTMLDivElement>(null),
    timeline = useRef<HTMLDivElement>(null),
    timelineScroll = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const zoomAnchor = useRef<{ time: number; x: number } | null>(null);
  const autoSubtitleRef = useRef("");
  const renderJobRef = useRef("");
  const cancelCueEditRef = useRef(false);
  const duration = project?.metadata.duration || 0;
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
  const autoSubtitleTooLong = duration > autoSubtitleLimitMinutes * 60 + 0.5;
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
    !project?.has_source || autoSubtitlesReady || autoSubtitleTooLong;
  const autoSubtitleTitle = autoSubtitlesReady
    ? "زیرنویس خودکار برای این ویدیو ساخته شده است. به‌جای مصرف توکن بیشتر، آن‌ها را ویرایش کنید."
    : autoSubtitleTooLong
      ? `زیرنویس خودکار تا ${autoSubtitleLimitMinutes} دقیقه محدود است. سقف را در تنظیمات → زیرنویس خودکار افزایش دهید.`
      : "پیاده‌سازی گفتار با ElevenLabs، ترجمه با 9Router و افزودن زیرنویس انگلیسی + فارسی";
  const complete = !!project?.metadata.duration;
  const playbackReady = !!project?.has_source && complete;
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
    setCueRole("main");
    setEditingCue(null);
    setSaved(false);
    setTime(0);
    setCuePage(0);
    setRefine(null);
    setAutoStarting(false);
    setCoverCandidates([]);
    setCoverBusy(false);
    setPanelOpen(false);
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
    setCuePage(0);
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
    if (!panelOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [panelOpen]);
  useEffect(() => {
    if (!edit) return;
    if (!edit.subtitles.track_id && edit.subtitles.fa_track_id)
      setCueRole("fa");
    else if (cueRole === "fa" && !edit.subtitles.fa_track_id)
      setCueRole("main");
  }, [cueRole, edit?.subtitles.track_id, edit?.subtitles.fa_track_id]);
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
  async function generateCoverFrames() {
    if (!edit) return;
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
      await api(
        `/projects/${id}/cover-frame`,
        json("PUT", {
          time: value,
          start: edit.start,
          end: edit.end,
          edit,
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
                {j.kind === "download"
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
  const listTrackId = cueRole === "fa" ? style.fa_track_id : style.track_id;
  const cues = listTrackId ? cuesByTrack[listTrackId] || [] : [];
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
  function setCues(updater: Cue[] | ((current: Cue[]) => Cue[])) {
    if (!listTrackId) return;
    setCuesByTrack((old) => {
      const current = old[listTrackId] || [];
      return {
        ...old,
        [listTrackId]:
          typeof updater === "function" ? updater(current) : updater,
      };
    });
  }
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
  function beginCueEdit(trackId: string, index: number, cue: Cue) {
    if (playing) return;
    setEditingCue({ trackId, index });
    setCueDraft(cue.text);
  }
  async function commitCueEdit() {
    if (cancelCueEditRef.current) {
      cancelCueEditRef.current = false;
      setEditingCue(null);
      return;
    }
    if (!editingCue) return;
    const { trackId, index } = editingCue;
    const current = cuesByTrack[trackId] || [];
    const next = current.map((cue, cueIndex) =>
      cueIndex === index ? { ...cue, text: cueDraft.trim() } : cue,
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
      // The burned-in ASS uses an explicit RTL embedding for Persian lines.
      // Keep the preview in the same base direction so punctuation (commas,
      // periods, question marks) sits on the same side in both.
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
        <Textarea
          key={`${trackId}-${index}`}
          autoFocus
          className="caption-inline-input"
          aria-label="ویرایش متن زیرنویس روی ویدیو"
          value={cueDraft}
          style={captionLine(fa)}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setCueDraft(event.target.value)}
          onBlur={() => commitCueEdit()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              cancelCueEditRef.current = true;
              event.currentTarget.blur();
              setEditingCue(null);
            } else if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey)
            ) {
              event.preventDefault();
              commitCueEdit();
            }
          }}
        />
      );
    return (
      <span
        key={`${trackId}-${index}`}
        className="caption-line"
        style={{
          ...captionLine(fa),
          pointerEvents: playing ? "none" : "auto",
          cursor: playing ? "inherit" : "text",
        }}
        title={
          playing
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
  return (
    <div className="editor">
      <div className="editor-heading">
        <div>
          <span className="eyebrow">ویرایشگر ویدیو</span>
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
          <span className="save-status">
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
        <div className="form-actions">
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
            className={"secondary " + (panelOpen ? "selected" : "")}
            type="button"
            aria-pressed={panelOpen}
            aria-expanded={panelOpen}
            aria-controls="advanced-editor-panel"
            onClick={() => setPanelOpen((open) => !open)}
            title="باز کردن کنترل‌های ویرایش پیشرفته"
          >
            <SlidersHorizontal size={15} /> پیشرفته
          </button>
          <button
            className="secondary"
            disabled={busy || !project.has_source || !!activeRender}
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
              !project.has_source ||
              !!activeRender ||
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
        </div>
      </div>
      <div className="editor-layout">
        <div className="editor-workspace">
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
                  src={`/api/media/project/${id}/source`}
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
          </div>
          <div className={"timeline-panel" + (refine ? " refining" : "")}>
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
                    <span>کلیپ انتخاب‌شده</span>
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
                {refine ? "پایان" : "دقیق‌سازی"}
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
              <div className="timeline-bottom-actions">
                <button
                  className="text-link"
                  onClick={() =>
                    root("start", Math.min(time, edit.end - MIN_CLIP))
                  }
                >
                  شروع از اینجا
                </button>
                <button
                  className="text-link"
                  onClick={() =>
                    root("end", Math.max(time, edit.start + MIN_CLIP))
                  }
                >
                  پایان در اینجا
                </button>
              </div>
            </div>
          </div>
          <div className="player-controls">
            <button
              className="icon-button"
              aria-label={playing ? "توقف" : "پخش"}
              disabled={!playbackReady}
              onClick={toggle}
            >
              {playing ? <Pause size={21} /> : <Play size={21} />}
            </button>
            <span className="player-time">
              {timecode(time)} <span>/ {clock(duration)}</span>
            </span>
            <div className="player-spacer" />
            <Volume2 size={16} />
            <RangeSlider
              className="volume-slider"
              aria-label="صدای پخش"
              min={0}
              max={1}
              step={0.01}
              value={[volume]}
              onValueChange={([value]) => setVolume(value)}
            />
            <Select
              className="speed-select"
              aria-label="سرعت پخش"
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
              <Repeat size={17} />
            </button>
            <button
              className="icon-button"
              aria-label="تمام‌صفحه"
              onClick={() => stage.current?.requestFullscreen()}
            >
              <Maximize size={17} />
            </button>
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
              <span className="eyebrow">خروجی‌های اخیر</span>
              {rendered.map((c) => (
                <button key={c.id} onClick={() => onClip(c)}>
                  <Play size={15} />
                  <span>
                    {c.name}
                    <small>
                      {c.preview ? "پیش‌نمایش رندر‌شده" : "کلیپ آماده"} ·{" "}
                      {clock(c.metadata.duration)}
                    </small>
                  </span>
                  <ArrowUpRight size={15} />
                </button>
              ))}
            </div>
          )}
          <p className="editor-hint">
            تغییرات روی فریم نهایی خروجی اعمال می‌شوند. برای بررسی دقیق
            زیرنویس‌ها، برش، واترمارک و صدا از پیش‌نمایش رندر استفاده کنید.
          </p>
        </div>
        {panelOpen && (
          <button
            className="edit-sidebar-backdrop"
            type="button"
            aria-label="بستن کنترل‌های ویرایش پیشرفته"
            onClick={() => setPanelOpen(false)}
          />
        )}
        <aside
          id="advanced-editor-panel"
          className={"edit-sidebar" + (panelOpen ? " open" : "")}
          aria-label="کنترل‌های ویرایش پیشرفته"
          aria-hidden={!panelOpen}
        >
          <div className="edit-sidebar-head">
            <span className="eyebrow">ویرایش پیشرفته</span>
            <button
              className="icon-button"
              type="button"
              aria-label="بستن کنترل‌های ویرایش پیشرفته"
              onClick={() => setPanelOpen(false)}
            >
              <X size={16} />
            </button>
          </div>
          <div className="edit-tabs">
            {[
              { id: "clip", icon: Scissors, label: "برش" },
              { id: "subtitles", icon: Type, label: "زیرنویس" },
              { id: "crop", icon: Frame, label: "قاب" },
              { id: "watermark", icon: Stamp, label: "نشان" },
              { id: "audio", icon: Music, label: "صدا" },
            ].map((t) => (
              <button
                key={t.id}
                className={tab === t.id ? "active" : ""}
                onClick={() => setTab(t.id)}
              >
                <t.icon size={19} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
          <div className="edit-controls">
            {tab === "clip" && (
              <>
                <div className="adv-intro">
                  <div>
                    <span className="adv-eyebrow">مدت کلیپ</span>
                    <strong>{timecode(edit.end - edit.start)}</strong>
                  </div>
                  <button
                    type="button"
                    className="adv-text-button"
                    aria-pressed={!!refine}
                    onClick={refine ? endRefine : startRefine}
                  >
                    <Scissors size={13} />
                    {refine ? "پایان دقیق‌سازی" : "برش دقیق‌تر"}
                  </button>
                </div>
                <div className="form-row">
                  <label>
                    شروع (ثانیه)
                    <Num
                      value={edit.start}
                      min={0}
                      max={duration}
                      step={0.001}
                      onChange={(v) => root("start", v)}
                    />
                  </label>
                  <label>
                    پایان (ثانیه)
                    <Num
                      value={edit.end}
                      min={0}
                      max={duration}
                      step={0.001}
                      onChange={(v) => root("end", v)}
                    />
                  </label>
                </div>
                {edit.end <= edit.start && (
                  <p className="inline-error">پایان باید بعد از شروع باشد.</p>
                )}
                {refine && (
                  <p className="hint">
                    خط زمان روی {timecode(refine.start)} –{" "}
                    {timecode(refine.end)} متمرکز شده است. برای برش بیشتر،
                    دستگیره‌ها یا نشانگر پخش را بکشید.
                  </p>
                )}
                <PanelSection
                  icon={Download}
                  title="تنظیمات خروجی"
                  summary={`${edit.resolution}px · ${edit.fps} fps`}
                >
                  <label>
                    نام فایل خروجی
                    <Input
                      className="h-8 text-xs"
                      value={edit.filename}
                      onChange={(e) => root("filename", e.target.value)}
                      maxLength={100}
                    />
                  </label>
                  <label>
                    کیفیت
                    <Select
                      value={edit.quality}
                      onChange={(v) => root("quality", v)}
                      options={[
                        ["fast", "سریع · پیشنهادی"],
                        ["balanced", "متعادل"],
                        ["high", "کیفیت بالا"],
                      ]}
                    />
                  </label>
                  <div className="form-row">
                    <label>
                      رزولوشن
                      <Select
                        value={String(edit.resolution)}
                        onChange={(v) => root("resolution", Number(v))}
                        options={[
                          ["720", "720px · فشرده"],
                          ["1080", "1080px · استاندارد"],
                          ["1920", "1920px · Full HD"],
                        ]}
                      />
                    </label>
                    <label>
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
                </PanelSection>
                <PanelSection
                  icon={Scan}
                  title="کاور تلگرام"
                  summary={
                    coverFrame
                      ? `فریم ${timecode(coverFrame.time)}`
                      : "کاور خودکار"
                  }
                >
                  <p className="hint">
                    فریم تمیز از منبع، بدون زیرنویس‌های چسبیده.
                  </p>
                  <div className="cover-frame-picker">
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
                    <div className="cover-frame-copy">
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
                      <div className="cover-frame-buttons">
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
                          className="text-link"
                          disabled={coverBusy}
                          onClick={generateCoverFrames}
                        >
                          ساخت ۶ فریم
                        </button>
                      </div>
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
                  {coverOutsideClip && (
                    <p className="inline-error">
                      این کاور خارج از برش فعلی است و نادیده گرفته می‌شود. فریمی
                      از محدوده کلیپ انتخاب کنید.
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
                            Math.abs(coverFrame.time - candidate.time) < 0.002
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
                </PanelSection>
                <p className="adv-footnote">
                  {project.metadata.width}×{project.metadata.height} ·{" "}
                  {project.metadata.video_codec?.toUpperCase()} ·{" "}
                  {project.metadata.audio.length} صدا ·{" "}
                  {project.subtitles?.length || 0} زیرنویس
                </p>
              </>
            )}
            {tab === "subtitles" && (
              <>
                <button
                  className="secondary wide"
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
                    <LoaderCircle className="spin" size={16} />
                  ) : autoSubtitlesReady ? (
                    <CheckIcon size={16} />
                  ) : (
                    <Sparkles size={16} />
                  )}{" "}
                  {autoSubtitleJob
                    ? `پیاده‌سازی و ترجمه ${autoSubtitleJob.progress.toFixed(0)}%`
                    : autoStarting
                      ? "در حال شروع زیرنویس خودکار…"
                      : autoSubtitlesReady
                        ? "زیرنویس خودکار آماده است"
                        : "زیرنویس خودکار (انگلیسی + فارسی)"}
                </button>
                {autoSubtitlesReady && (
                  <p className="hint">
                    زیرنویس خودکار آماده است؛ مسیرها را ویرایش کنید.
                  </p>
                )}
                {autoSubtitleTooLong && (
                  <p className="inline-error">
                    این ویدیو {clock(duration)} است. زیرنویس خودکار تا{" "}
                    {autoSubtitleLimitMinutes} دقیقه محدود است؛ سقف را در
                    تنظیمات → زیرنویس خودکار افزایش دهید یا ویدیوی کوتاه‌تری
                    وارد کنید.
                  </p>
                )}
                <PanelSection
                  icon={Type}
                  title="مسیرهای زیرنویس"
                  summary={`${(project.subtitles || []).length} مسیر`}
                  defaultOpen
                >
                  <label>
                    مسیر زیرنویس انگلیسی / اصلی
                    <Select
                      value={style.track_id}
                      onChange={(v) => update("subtitles", "track_id", v)}
                      options={[
                        ["", "بدون زیرنویس اصلی"],
                        ...(project.subtitles || []).map((t) => [
                          t.id,
                          `${t.title}${!t.editable ? " (تصویری — پشتیبانی نمی‌شود)" : ""}`,
                        ]),
                      ]}
                    />
                  </label>
                  <label>
                    مسیر زیرنویس فارسی
                    <Select
                      value={style.fa_track_id}
                      onChange={(v) => update("subtitles", "fa_track_id", v)}
                      options={[
                        ["", "بدون زیرنویس فارسی"],
                        ...(project.subtitles || []).map((t) => [
                          t.id,
                          `${t.title}${!t.editable ? " (تصویری — پشتیبانی نمی‌شود)" : ""}`,
                        ]),
                      ]}
                    />
                  </label>
                  <div className="form-row">
                    <FileButton
                      label="بارگذاری انگلیسی"
                      accept=".srt,.ass,.ssa,.vtt"
                      disabled={busy}
                      onFile={(f) => upload("subtitles", f, "main")}
                    />
                    <FileButton
                      label="بارگذاری فارسی"
                      accept=".srt,.ass,.ssa,.vtt"
                      disabled={busy}
                      onFile={(f) => upload("subtitles", f, "fa")}
                    />
                  </div>
                  <Check
                    checked={style.burn}
                    onChange={(v) => update("subtitles", "burn", v)}
                  >
                    افزودن دائمی هر دو زیرنویس به خروجی
                  </Check>
                  <Check
                    checked={style.soft}
                    onChange={(v) => update("subtitles", "soft", v)}
                  >
                    استفاده از زیرنویس‌های نرم اصلی ویدیو
                  </Check>
                  <p className="hint">
                    برای استفاده از زیرنویس نرم خود ویدیو به‌جای مسیرهای بالا،
                    این گزینه را روشن کنید.
                  </p>
                  {project.subtitles
                    ?.find((t) => t.id === style.track_id)
                    ?.codec.match(/ass|ssa/) && (
                    <>
                      <Check
                        checked={style.preserve_ass}
                        onChange={(v) => update("subtitles", "preserve_ass", v)}
                      >
                        حفظ استایل اصلی ASS
                      </Check>
                      <p className="hint">
                        استایل اصلی ASS حفظ می‌شود؛ ویرایش استایل سفارشی فقط با
                        خاموش بودن این گزینه اعمال می‌شود.
                      </p>
                    </>
                  )}
                </PanelSection>
                <PanelSection
                  icon={Type}
                  title="استایل انگلیسی"
                  summary={`${style.font} · ${style.size}px`}
                >
                  <label>
                    خانواده فونت
                    <Select
                      value={style.font}
                      options={fonts}
                      onChange={(v) => update("subtitles", "font", v)}
                    />
                  </label>
                  <Check
                    checked={style.bold}
                    onChange={(v) => update("subtitles", "bold", v)}
                  >
                    ضخیم
                  </Check>
                  <Slider
                    label="اندازه فونت"
                    value={style.size}
                    min={12}
                    max={160}
                    step={1}
                    suffix="px"
                    onChange={(v) => update("subtitles", "size", v)}
                  />
                  <div className="form-row">
                    <label>
                      رنگ متن
                      <Color
                        value={style.color}
                        name="رنگ متن"
                        onChange={(v) => update("subtitles", "color", v)}
                      />
                    </label>
                    <label>
                      رنگ حاشیه
                      <Color
                        value={style.outline_color}
                        name="رنگ حاشیه"
                        onChange={(v) =>
                          update("subtitles", "outline_color", v)
                        }
                      />
                    </label>
                  </div>
                  <div className="form-row">
                    <label>
                      حاشیه
                      <Num
                        value={style.outline}
                        min={0}
                        max={12}
                        onChange={(v) => update("subtitles", "outline", v)}
                      />
                    </label>
                    <label>
                      سایه
                      <Num
                        value={style.shadow}
                        min={0}
                        max={12}
                        onChange={(v) => update("subtitles", "shadow", v)}
                      />
                    </label>
                  </div>
                  <Check
                    checked={style.box}
                    onChange={(v) => update("subtitles", "box", v)}
                  >
                    کادر پس‌زمینه
                  </Check>
                  {style.box && (
                    <Slider
                      label="شفافیت کادر"
                      value={style.box_opacity}
                      min={0}
                      max={1}
                      step={0.01}
                      suffix=""
                      onChange={(v) => update("subtitles", "box_opacity", v)}
                    />
                  )}
                </PanelSection>
                <PanelSection
                  icon={Frame}
                  title="چیدمان"
                  summary={`${style.position === "bottom" ? "پایین" : style.position === "middle" ? "میانه" : "بالا"} · ${style.align === "left" ? "چپ" : style.align === "center" ? "وسط" : "راست"}`}
                >
                  <div className="form-row">
                    <label>
                      موقعیت
                      <Select
                        value={style.position}
                        options={[
                          ["bottom", "پایین"],
                          ["middle", "میانه"],
                          ["top", "بالا"],
                        ]}
                        onChange={(v) => update("subtitles", "position", v)}
                      />
                    </label>
                    <label>
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
                  </div>
                  <div className="form-row">
                    <label>
                      حاشیه (px)
                      <Num
                        value={style.margin}
                        min={0}
                        max={400}
                        step={1}
                        onChange={(v) => update("subtitles", "margin", v)}
                      />
                    </label>
                    <label>
                      انحراف زمان (ثانیه)
                      <Num
                        value={style.offset}
                        min={-600}
                        max={600}
                        step={0.1}
                        onChange={(v) => update("subtitles", "offset", v)}
                      />
                    </label>
                  </div>
                </PanelSection>
                <PanelSection
                  icon={Languages}
                  title="استایل فارسی"
                  summary={`${style.fa_font} · ${style.fa_size}px`}
                >
                  <label>
                    فونت فارسی
                    <Select
                      value={style.fa_font}
                      options={fonts}
                      onChange={(v) => update("subtitles", "fa_font", v)}
                    />
                  </label>
                  <Check
                    checked={style.fa_bold}
                    onChange={(v) => update("subtitles", "fa_bold", v)}
                  >
                    متن فارسی ضخیم
                  </Check>
                  <Slider
                    label="اندازه فونت فارسی"
                    value={style.fa_size}
                    min={12}
                    max={160}
                    step={1}
                    suffix="px"
                    onChange={(v) => update("subtitles", "fa_size", v)}
                  />
                  <div className="form-row">
                    <label>
                      رنگ فارسی
                      <Color
                        value={style.fa_color}
                        name="رنگ متن فارسی"
                        onChange={(v) => update("subtitles", "fa_color", v)}
                      />
                    </label>
                    <label>
                      حاشیه فارسی
                      <Color
                        value={style.fa_outline_color}
                        name="رنگ حاشیه فارسی"
                        onChange={(v) =>
                          update("subtitles", "fa_outline_color", v)
                        }
                      />
                    </label>
                  </div>
                  <div className="form-row">
                    <label>
                      ضخامت حاشیه فارسی
                      <Num
                        value={style.fa_outline}
                        min={0}
                        max={12}
                        onChange={(v) => update("subtitles", "fa_outline", v)}
                      />
                    </label>
                    <label>
                      فاصله بالای فارسی (px)
                      <Num
                        value={style.gap}
                        min={0}
                        max={200}
                        onChange={(v) => update("subtitles", "gap", v)}
                      />
                    </label>
                  </div>
                </PanelSection>
                {(style.track_id || style.fa_track_id) && (
                  <PanelSection
                    icon={Type}
                    title="ویرایش متن"
                    summary={`${cues.length} خط`}
                  >
                    {style.track_id && style.fa_track_id && (
                      <div className="form-actions">
                        <button
                          className={
                            cueRole === "main" ? "primary" : "secondary"
                          }
                          onClick={() => {
                            setCueRole("main");
                            setCuePage(0);
                          }}
                        >
                          مسیر انگلیسی
                        </button>
                        <button
                          className={cueRole === "fa" ? "primary" : "secondary"}
                          onClick={() => {
                            setCueRole("fa");
                            setCuePage(0);
                          }}
                        >
                          مسیر فارسی
                        </button>
                      </div>
                    )}
                    <div className="cue-list">
                      {cues
                        .slice(cuePage * 20, cuePage * 20 + 20)
                        .map((cue, index) => {
                          const i = cuePage * 20 + index;
                          return (
                            <div className="cue" key={i}>
                              <div className="cue-times">
                                <Input
                                  className="h-7 px-1.5 text-[10px]"
                                  aria-label={`شروع زیرنویس ${i + 1}`}
                                  type="number"
                                  step={0.001}
                                  min={0}
                                  value={cue.start}
                                  onChange={(e) =>
                                    setCues((old) =>
                                      old.map((c, n) =>
                                        n === i
                                          ? {
                                              ...c,
                                              start: Number(e.target.value),
                                            }
                                          : c,
                                      ),
                                    )
                                  }
                                />
                                <span>→</span>
                                <Input
                                  className="h-7 px-1.5 text-[10px]"
                                  aria-label={`پایان زیرنویس ${i + 1}`}
                                  type="number"
                                  step={0.001}
                                  min={0}
                                  value={cue.end}
                                  onChange={(e) =>
                                    setCues((old) =>
                                      old.map((c, n) =>
                                        n === i
                                          ? {
                                              ...c,
                                              end: Number(e.target.value),
                                            }
                                          : c,
                                      ),
                                    )
                                  }
                                />
                                <button
                                  className="icon-button"
                                  aria-label="حذف زیرنویس"
                                  onClick={() =>
                                    setCues((old) =>
                                      old.filter((_, n) => n !== i),
                                    )
                                  }
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                              <Textarea
                                className="min-h-14 text-[11px]"
                                aria-label={`متن زیرنویس ${i + 1}`}
                                value={cue.text}
                                onFocus={() => seek(cue.start + style.offset)}
                                onChange={(e) =>
                                  setCues((old) =>
                                    old.map((c, n) =>
                                      n === i
                                        ? { ...c, text: e.target.value }
                                        : c,
                                    ),
                                  )
                                }
                              />
                            </div>
                          );
                        })}
                    </div>
                    {cues.length > 20 && (
                      <div className="cue-pagination">
                        <button
                          className="secondary"
                          disabled={cuePage === 0}
                          onClick={() => setCuePage(cuePage - 1)}
                        >
                          قبلی
                        </button>
                        <small>
                          {cuePage + 1} / {Math.ceil(cues.length / 20)}
                        </small>
                        <button
                          className="secondary"
                          disabled={(cuePage + 1) * 20 >= cues.length}
                          onClick={() => setCuePage(cuePage + 1)}
                        >
                          بعدی
                        </button>
                      </div>
                    )}
                    <div className="form-actions">
                      <button
                        className="secondary"
                        onClick={() =>
                          setCues([
                            ...cues,
                            {
                              start: time,
                              end: Math.min(duration, time + 2),
                              text: "زیرنویس جدید",
                            },
                          ])
                        }
                      >
                        <Plus size={14} /> افزودن زیرنویس
                      </button>
                      <button
                        className="primary"
                        disabled={!listTrackId}
                        onClick={() =>
                          listTrackId &&
                          saveTrackCues(
                            listTrackId,
                            cues,
                            "متن زیرنویس ذخیره شد.",
                          )
                        }
                      >
                        <Save size={14} /> ذخیره زیرنویس‌ها
                      </button>
                    </div>
                    <p className="hint">
                      برای ویرایش روی ویدیو، پخش را متوقف کنید و روی خط زیرنویس
                      کلیک کنید.
                    </p>
                  </PanelSection>
                )}
                <button
                  type="button"
                  className="adv-save-default"
                  disabled={savingDefaults}
                  onClick={() => saveAsDefaults("subtitles")}
                >
                  <Save size={13} /> ذخیره استایل فعلی به‌عنوان پیش‌فرض
                </button>
              </>
            )}
            {tab === "crop" && (
              <>
                <div className="aspect-options">
                  {["original", "16:9", "9:16", "1:1", "4:5"].map((v) => (
                    <button
                      key={v}
                      className={edit.crop.ratio === v ? "active" : ""}
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
                      {v === "original" ? "اصلی" : v}
                    </button>
                  ))}
                </div>
                <label>
                  کادربندی
                  <Select
                    value={edit.crop.mode}
                    options={[
                      ["fill", "پر کردن قاب · برش لبه‌ها"],
                      ["fit", "جای‌گذاری کامل ویدیو · حاشیه سیاه"],
                    ]}
                    onChange={(v) => update("crop", "mode", v)}
                  />
                </label>
                <PanelSection
                  icon={Move}
                  title="تنظیم دستی"
                  summary={`${Math.round(edit.crop.x * 100)}% · ${Math.round(edit.crop.y * 100)}%`}
                >
                  <button
                    className={"secondary wide " + (cropDrag ? "selected" : "")}
                    onClick={() => setCropDrag(!cropDrag)}
                  >
                    <Move size={16} />
                    {cropDrag ? "پایان جابه‌جایی" : "جابه‌جایی با کشیدن"}
                  </button>
                  <Slider
                    label="موقعیت افقی"
                    value={edit.crop.x}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(v) => update("crop", "x", v)}
                  />
                  <Slider
                    label="موقعیت عمودی"
                    value={edit.crop.y}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(v) => update("crop", "y", v)}
                  />
                  <button
                    className="text-link"
                    onClick={() => {
                      update("crop", "x", 0.5);
                      update("crop", "y", 0.5);
                    }}
                  >
                    وسط‌چین کردن قاب
                  </button>
                </PanelSection>
                <p className="adv-footnote">
                  زیرنویس و واترمارک نسبت به همین قاب خروجی می‌مانند.
                </p>
              </>
            )}
            {tab === "watermark" && (
              <>
                <label>
                  نوع واترمارک
                  <Select
                    value={wm.kind}
                    options={[
                      ["none", "بدون واترمارک"],
                      ["text", "متن"],
                      ["image", "تصویر"],
                    ]}
                    onChange={(v) => update("watermark", "kind", v)}
                  />
                </label>
                {wm.kind === "text" && (
                  <PanelSection
                    icon={Stamp}
                    title="محتوا"
                    summary={
                      wm.template ? "قالب چندعنصری" : wm.text || "متن خالی"
                    }
                    defaultOpen={!wm.template}
                  >
                    {wm.template ? (
                      <WatermarkTemplateEditor
                        template={wm.template}
                        onChange={(template) =>
                          update("watermark", "template", template)
                        }
                      />
                    ) : (
                      <>
                        <label>
                          متن واترمارک
                          <Input
                            className="h-8 text-xs"
                            value={wm.text}
                            maxLength={300}
                            onChange={(e) =>
                              update("watermark", "text", e.target.value)
                            }
                            placeholder="@نامشما"
                          />
                        </label>
                        <label>
                          فونت
                          <Select
                            value={wm.font}
                            options={fonts}
                            onChange={(v) => update("watermark", "font", v)}
                          />
                        </label>
                        <Slider
                          label="اندازه متن"
                          value={wm.size}
                          min={12}
                          max={200}
                          step={1}
                          suffix="px"
                          onChange={(v) => update("watermark", "size", v)}
                        />
                        <label>
                          رنگ
                          <Color
                            value={wm.color}
                            name="رنگ واترمارک"
                            onChange={(v) => update("watermark", "color", v)}
                          />
                        </label>
                        <button
                          className="secondary wide"
                          type="button"
                          onClick={() =>
                            update(
                              "watermark",
                              "template",
                              templateFromLegacy(wm),
                            )
                          }
                        >
                          <Stamp size={16} /> استفاده از قالب چندعنصری
                        </button>
                      </>
                    )}
                  </PanelSection>
                )}
                {wm.kind === "image" && (
                  <PanelSection
                    icon={Stamp}
                    title="تصویر"
                    summary={
                      wm.asset_id ? "تصویر انتخاب شده" : "تصویری انتخاب نشده"
                    }
                    defaultOpen
                  >
                    <FileButton
                      label="بارگذاری PNG یا JPEG"
                      accept=".png,.jpg,.jpeg"
                      disabled={busy}
                      onFile={(f) => upload("watermark", f)}
                    />
                    <label>
                      تصویر
                      <Select
                        value={wm.asset_id}
                        options={[
                          ["", "انتخاب تصویر"],
                          ...(project.assets || [])
                            .filter((a) => a.kind === "watermark")
                            .map((a) => [a.id, a.name]),
                        ]}
                        onChange={(v) => update("watermark", "asset_id", v)}
                      />
                    </label>
                    <Slider
                      label="عرض تصویر"
                      value={wm.width}
                      min={0.02}
                      max={0.8}
                      step={0.01}
                      onChange={(v) => update("watermark", "width", v)}
                    />
                  </PanelSection>
                )}
                {wm.kind !== "none" && (
                  <PanelSection
                    icon={Move}
                    title="موقعیت و نمایش"
                    summary={`${Math.round(wm.x * 100)}% · ${Math.round(wm.y * 100)}%`}
                  >
                    {(!wm.template || wm.kind === "image") && (
                      <Slider
                        label="شفافیت"
                        value={wm.opacity}
                        min={0}
                        max={1}
                        step={0.01}
                        onChange={(v) => update("watermark", "opacity", v)}
                      />
                    )}
                    <label>
                      پیش‌تنظیم گوشه
                      <Select
                        value=""
                        options={[
                          ["", "در پیش‌نمایش بکشید یا انتخاب کنید…"],
                          ["tl", "بالا چپ"],
                          ["tr", "بالا راست"],
                          ["bl", "پایین چپ"],
                          ["br", "پایین راست"],
                        ]}
                        onChange={(v) => {
                          const edge = wm.template ? 0.12 : 0;
                          update(
                            "watermark",
                            "x",
                            v.endsWith("l") ? edge : 1 - edge,
                          );
                          update(
                            "watermark",
                            "y",
                            v.startsWith("t") ? edge : 1 - edge,
                          );
                        }}
                      />
                    </label>
                    <Slider
                      label="موقعیت افقی"
                      value={wm.x}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(v) => update("watermark", "x", v)}
                    />
                    <Slider
                      label="موقعیت عمودی"
                      value={wm.y}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(v) => update("watermark", "y", v)}
                    />
                    <label>
                      حاشیه (px)
                      <Num
                        value={wm.margin}
                        min={0}
                        max={400}
                        step={1}
                        onChange={(v) => update("watermark", "margin", v)}
                      />
                    </label>
                    <div className="form-row">
                      <label>
                        نمایش از (ثانیه)
                        <Num
                          value={wm.start}
                          min={0}
                          max={edit.end - edit.start}
                          onChange={(v) => update("watermark", "start", v)}
                        />
                      </label>
                      <label>
                        تا (ثانیه)
                        <Input
                          className="h-8 text-xs"
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
                      زمان‌ها نسبت به کلیپ هستند. برای جابه‌جایی، نشان را در
                      پیش‌نمایش بکشید.
                    </p>
                  </PanelSection>
                )}
                <button
                  type="button"
                  className="adv-save-default"
                  disabled={savingDefaults}
                  onClick={() => saveAsDefaults("watermark")}
                >
                  <Save size={13} /> ذخیره استایل فعلی به‌عنوان پیش‌فرض
                </button>
              </>
            )}
            {tab === "audio" && (
              <>
                <label>
                  مسیر صدای اصلی
                  <Select
                    value={String(edit.audio.track)}
                    options={project.metadata.audio.map((a, i) => [
                      String(i),
                      a.title || `مسیر ${i + 1} · ${a.language || a.codec}`,
                    ])}
                    onChange={(v) => {
                      update("audio", "track", Number(v));
                    }}
                  />
                </label>
                <Check
                  checked={edit.audio.mute}
                  onChange={(v) => update("audio", "mute", v)}
                >
                  بی‌صدا کردن صدای اصلی
                </Check>
                <Slider
                  label="صدای اصلی"
                  value={edit.audio.volume}
                  min={0}
                  max={3}
                  step={0.05}
                  suffix="×"
                  onChange={(v) => update("audio", "volume", v)}
                />
                <PanelSection
                  icon={Music}
                  title="موسیقی پس‌زمینه"
                  summary={edit.audio.music_id ? "فعال" : "بدون موسیقی"}
                  defaultOpen={!!edit.audio.music_id}
                >
                  <FileButton
                    label="بارگذاری موسیقی"
                    accept="audio/*,.m4a,.flac"
                    disabled={busy}
                    onFile={(f) => upload("music", f)}
                  />
                  <label>
                    مسیر موسیقی
                    <Select
                      value={edit.audio.music_id}
                      options={[
                        ["", "بدون موسیقی پس‌زمینه"],
                        ...(project.assets || [])
                          .filter((a) => a.kind === "music")
                          .map((a) => [a.id, a.name]),
                      ]}
                      onChange={(v) => update("audio", "music_id", v)}
                    />
                  </label>
                  <Slider
                    label="صدای موسیقی"
                    value={edit.audio.music_volume}
                    min={0}
                    max={3}
                    step={0.05}
                    suffix="×"
                    onChange={(v) => update("audio", "music_volume", v)}
                  />
                  <div className="form-row">
                    <label>
                      محو تدریجی ورود (ثانیه)
                      <Num
                        value={edit.audio.fade_in}
                        min={0}
                        max={30}
                        onChange={(v) => update("audio", "fade_in", v)}
                      />
                    </label>
                    <label>
                      محو تدریجی خروج (ثانیه)
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
                </PanelSection>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
function PanelSection({
  icon: Icon,
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  icon: React.ComponentType<{ size?: number }>;
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={"adv-section" + (open ? " open" : "")}>
      <button
        type="button"
        className="adv-section-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="adv-section-icon" aria-hidden="true">
          <Icon size={15} />
        </span>
        <span className="adv-section-copy">
          <strong>{title}</strong>
          {summary && <small>{summary}</small>}
        </span>
        <ChevronDown size={15} className="adv-chevron" aria-hidden="true" />
      </button>
      {open && <div className="adv-section-body">{children}</div>}
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
      className="h-8 text-xs"
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
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[][];
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <SelectRoot
      value={value === "" ? EMPTY_VALUE : value}
      onValueChange={(next) => onChange(next === EMPTY_VALUE ? "" : next)}
    >
      <SelectTrigger
        className={"h-8 text-xs " + (className || "")}
        aria-label={ariaLabel}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
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
        className="my-1.5"
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
    <Label className="check text-[10px] font-normal text-[#b7bfcd]">
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
      <Upload size={15} />
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
        className="h-8 px-1.5 text-[10px]"
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
