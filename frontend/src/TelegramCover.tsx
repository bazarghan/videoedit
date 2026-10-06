import { RefObject, useEffect, useState } from "react";
import { Image, LoaderCircle } from "lucide-react";
import { api, Clip, Job, json } from "./types";

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
      toast("Cover update queued. It will be ready before you send this clip.");
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="telegram-cover">
      <h3>
        <Image size={17} /> Telegram cover
      </h3>
      <div className="cover-picker">
        <div className="cover-image">
          {clip.has_cover ? (
            <img
              src={`/api/media/clip/${clip.id}/cover?v=${cover?.revision}`}
              alt="Selected Telegram cover"
            />
          ) : (
            <Image size={26} />
          )}
        </div>
        <div className="cover-settings">
          <span className="badge">
            {preparing
              ? "Preparing cover…"
              : cover?.mode === "manual"
                ? "Selected frame"
                : "Automatic frame"}
            {cover && !preparing ? ` · ${cover.time.toFixed(2)}s` : ""}
          </span>
          <label>
            Preview frame (seconds)
            <input
              type="number"
              value={time}
              min={0}
              max={Math.max(0, clip.metadata.duration - 0.001)}
              step={0.001}
              onChange={(event) => seek(Number(event.target.value))}
            />
          </label>
          <div className="cover-actions">
            <button
              className="secondary"
              disabled={busy || active}
              onClick={() => choose(video.current?.currentTime ?? time)}
            >
              {busy ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Image size={15} />
              )}{" "}
              Use current frame
            </button>
            <button
              className="text-link"
              disabled={busy || active}
              onClick={() => choose(null)}
            >
              Automatic frame
            </button>
          </div>
        </div>
      </div>
      <p className="hint">
        Every clip gets a cover automatically. Pause or seek the video above,
        then use its current frame to choose your own. The cover includes your
        finished edits.
      </p>
    </section>
  );
}
