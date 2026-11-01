import { RefObject, useEffect, useState } from "react";
import { Image, LoaderCircle } from "lucide-react";
import { api, Clip, Job, json } from "./types";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

type Props = {
  clip: Clip;
  video: RefObject<HTMLVideoElement | null>;
  jobs: Job[];
  refresh: () => Promise<void>;
  toast: (message: string) => void;
  onError: (message: string) => void;
};

export default function TelegramCover({
  clip,
  video,
  jobs,
  refresh,
  toast,
  onError,
}: Props) {
  const [time, setTime] = useState(0),
    [busy, setBusy] = useState(false);
  const active = jobs.some(
    (job) =>
      job.project_id === clip.project_id &&
      ["queued", "running"].includes(job.status),
  );
  const preparing = jobs.some(
    (job) =>
      job.project_id === clip.project_id &&
      job.kind === "cover" &&
      ["queued", "running"].includes(job.status),
  );
  const cover = clip.metadata.cover;
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const update = () => setTime(Math.round(element.currentTime * 1000) / 1000);
    update();
    element.addEventListener("timeupdate", update);
    return () => element.removeEventListener("timeupdate", update);
  }, [clip.id, video]);
  function seek(value: number) {
    const element = video.current;
    if (!element) return;
    element.pause();
    element.currentTime = Math.min(
      Math.max(0, value),
      Math.max(0, clip.metadata.duration - 0.001),
    );
    setTime(Math.round(element.currentTime * 1000) / 1000);
  }
  async function choose(timestamp: number | null) {
    video.current?.pause();
    setBusy(true);
    try {
      await api(`/clips/${clip.id}/cover`, json("PUT", { time: timestamp }));
      await refresh();
      toast(
        "به‌روزرسانی کاور در صف قرار گرفت. پیش از ارسال این کلیپ آماده خواهد بود.",
      );
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const status = preparing
    ? "در حال آماده‌سازی کاور…"
    : cover?.origin === "prerender"
      ? "ذخیره‌شده پیش از کپشن‌ها"
      : cover?.mode === "manual"
        ? "فریم انتخاب‌شده"
        : "فریم خودکار";

  return (
    <section className="flex flex-col gap-4 border-t border-border-tertiary pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <Image size={16} /> کاور Telegram
          </h3>
          <p className="text-sm text-text-secondary">
            فریم تمیز و بدون زیرنویس که بالای پست در تلگرام نمایش داده می‌شود.
          </p>
        </div>
        <span className="flex h-[26px] items-center rounded-[4px] border border-border-tertiary bg-elevation-2 px-2 text-xs text-text-secondary">
          {status}
          {cover && !preparing ? (
            <>
              {" · "}
              <span dir="ltr">{cover.time.toFixed(2)}</span> ثانیه
            </>
          ) : null}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
        <div className="aspect-video overflow-hidden rounded-[6px] border border-border-tertiary bg-black">
          {clip.has_cover ? (
            <img
              src={`/api/media/clip/${clip.id}/cover?v=${cover?.revision}`}
              alt="کاور انتخاب‌شدهٔ Telegram"
              className="size-full object-contain"
            />
          ) : (
            <div className="flex size-full items-center justify-center text-text-tertiary">
              <Image size={26} />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm text-text-primary">
            فریم پیش‌نمایش (ثانیه)
            <Input
              className="h-9 text-xs"
              type="number"
              value={time}
              min={0}
              max={Math.max(0, clip.metadata.duration - 0.001)}
              step={0.001}
              onChange={(event) => seek(Number(event.target.value))}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || active}
              onClick={() => choose(video.current?.currentTime ?? time)}
            >
              {busy ? <LoaderCircle className="spin" /> : <Image />}
              استفاده از فریم فعلی
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy || active}
              onClick={() => choose(null)}
            >
              فریم خودکار
            </Button>
          </div>
          <p className="text-xs leading-6 text-text-tertiary">
            برای هر کلیپ به‌طور خودکار یک کاور ساخته می‌شود. ویدیوی بالا را
            متوقف یا جابه‌جا کنید و سپس با فریم فعلی آن کاور دلخواه خود را
            انتخاب کنید. کاوری که پیش از رندر ذخیره شود، بدون زیرنویس سوخته باقی
            می‌ماند.
          </p>
        </div>
      </div>
    </section>
  );
}
