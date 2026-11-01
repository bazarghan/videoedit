import { useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Film,
  ListVideo,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Send,
  Sparkles,
} from "lucide-react";

import { Button } from "./components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Stepper } from "./components/ui/stepper";
import { Switch } from "./components/ui/switch";
import { Input } from "./components/ui/input";
import { TelegramEditorModal, TelegramRichText } from "./telegram-editor";
import TelegramCover from "./TelegramCover";
import { api, clock, json, size, Clip, Job, Settings } from "./types";
import { cn } from "./lib/utils";

const CAPTION_LIMIT = 1024;

const STEPS = [
  { id: "media", label: "کلیپ و کاور" },
  { id: "caption", label: "کپشن" },
  { id: "publish", label: "انتشار" },
  { id: "review", label: "بازبینی" },
] as const;

type Step = (typeof STEPS)[number]["id"] | "success";

type TelegramPostPageProps = {
  clips: Clip[];
  clip: Clip | null;
  onSelectClip: (clip: Clip | null) => void;
  settings: Settings | null;
  jobs: Job[];
  onSettings: () => void;
  onQueue: () => void;
  onBackToClips: () => void;
  refresh: () => Promise<void>;
  toast: (message: string) => void;
  onError: (message: string) => void;
};

function SummaryRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border-tertiary py-2 text-sm last:border-b-0">
      <span className="text-text-secondary">{label}</span>
      <span className="text-left text-text-primary">{value}</span>
    </div>
  );
}

function StepCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[8px] border border-border-tertiary bg-elevation-1 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-text-primary">{title}</h2>
        {description ? (
          <p className="text-sm text-text-secondary">{description}</p>
        ) : null}
      </div>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

function ClipOption({
  clip,
  selected,
  onSelect,
}: {
  clip: Clip;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "group overflow-hidden rounded-[8px] border bg-elevation-2 text-right transition-colors",
        selected
          ? "border-primary ring-1 ring-primary/40"
          : "border-border-tertiary hover:border-border-secondary",
      )}
    >
      <span className="relative block aspect-video overflow-hidden bg-black">
        {clip.has_cover ? (
          <img
            src={`/api/media/clip/${clip.id}/cover?v=${clip.metadata.cover?.revision}`}
            alt=""
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <video
            src={`/api/media/clip/${clip.id}#t=0.1`}
            preload="metadata"
            muted
            className="size-full object-cover"
          />
        )}
        <span
          className="absolute bottom-1.5 left-1.5 rounded-[4px] bg-black/70 px-1.5 py-0.5 text-[11px] text-white"
          dir="ltr"
        >
          {clock(clip.metadata.duration)}
        </span>
        {selected ? (
          <span className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="size-3.5" />
          </span>
        ) : null}
      </span>
      <span className="flex flex-col gap-0.5 p-2.5">
        <strong className="truncate text-sm font-medium text-text-primary">
          {clip.name}
        </strong>
        <span className="text-xs text-text-tertiary" dir="ltr">
          {clip.metadata.width} × {clip.metadata.height} ·{" "}
          {size(clip.metadata.size)}
        </span>
      </span>
    </button>
  );
}

export default function TelegramPostPage({
  clips,
  clip,
  onSelectClip,
  settings,
  jobs,
  onSettings,
  onQueue,
  onBackToClips,
  refresh,
  toast,
  onError,
}: TelegramPostPageProps) {
  const channels = settings?.telegram.channels ?? [];
  const [step, setStep] = useState<Step>("media");
  const [choosing, setChoosing] = useState(!clip);
  const [destination, setDestination] = useState(
    settings?.telegram.default_channel || channels[0]?.id || "",
  );
  const [sendToChannel, setSendToChannel] = useState(true);
  const [chatId, setChatId] = useState("");
  const [caption, setCaption] = useState("");
  const [captionFormat, setCaptionFormat] = useState("html");
  const [captionOpen, setCaptionOpen] = useState(false);
  const [captionBusy, setCaptionBusy] = useState(false);
  const [asFile, setAsFile] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);

  const channel =
    channels.find((item) => item.id === destination) ?? channels[0] ?? null;
  const manualChatId = chatId.trim();
  const chatIdValid =
    /^-?\d+$/.test(manualChatId) ||
    /^@?[A-Za-z][A-Za-z0-9_]{3,}$/.test(manualChatId);
  const destinationReady = sendToChannel ? Boolean(channel) : chatIdValid;
  const coverPending = clip
    ? jobs.some(
        (job) =>
          job.project_id === clip.project_id &&
          job.kind === "cover" &&
          ["queued", "running"].includes(job.status),
      )
    : false;
  const currentIndex = STEPS.findIndex((item) => item.id === step);
  const captionLength = caption.length;

  const coverLabel = useMemo(() => {
    if (clip?.metadata.cover?.mode === "manual") return "فریم انتخاب‌شده";
    return "فریم خودکار";
  }, [clip?.metadata.cover?.mode]);

  function resetComposer(clearClip: boolean) {
    setStep("media");
    setChoosing(true);
    setCaption("");
    setCaptionFormat("html");
    setAsFile(false);
    setSendToChannel(true);
    setChatId("");
    setError("");
    setJobId(null);
    if (clearClip) onSelectClip(null);
  }

  async function autoCaption() {
    if (!clip) return;
    setCaptionBusy(true);
    setError("");
    try {
      const result = await api<{ caption: string }>(
        `/clips/${clip.id}/caption`,
        json("POST"),
      );
      setCaption(result.caption);
      setCaptionOpen(true);
      toast("کپشن خودکار آماده است. پیش از ارسال آن را بررسی کنید.");
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setCaptionBusy(false);
    }
  }

  function goTo(next: Step) {
    setError("");
    setStep(next);
  }

  async function send() {
    if (!clip || !destinationReady || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const result = await api<{ job_id: string }>(
        `/clips/${clip.id}/send`,
        json("POST", {
          destination: sendToChannel ? (channel?.id ?? "") : "",
          chat_id: sendToChannel ? "" : manualChatId,
          caption,
          as_file: asFile,
        }),
      );
      setJobId(result.job_id);
      setStep("success");
      toast(
        sendToChannel
          ? "ارسال به Telegram در صف قرار گرفت. آن را در فعالیت‌ها پیگیری کنید."
          : "ارسال تستی در صف قرار گرفت. آن را در فعالیت‌ها پیگیری کنید.",
      );
      await refresh().catch(() => {});
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const header = (
    <header className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-medium tracking-wide text-primary">
            انتشار در تلگرام
          </span>
          <h1 className="text-2xl font-semibold text-text-primary">
            ارسال پست
          </h1>
          <p className="max-w-2xl text-sm text-text-secondary">
            یک کلیپ رندرشده را انتخاب کنید و کاور، کپشن و مقصد پست را
            مرحله‌به‌مرحله بررسی کنید.
          </p>
        </div>
        {clip ? (
          <Button
            type="button"
            variant="outline"
            className="border-destructive/40 text-destructive hover:bg-destructive/10"
            onClick={() => resetComposer(true)}
          >
            <RotateCcw />
            شروع دوباره
          </Button>
        ) : null}
      </div>
      {step !== "success" ? (
        <Stepper
          steps={STEPS.map((item) => item.label)}
          current={currentIndex}
          aria-label="مراحل ارسال پست"
        />
      ) : null}
    </header>
  );

  if (!settings) {
    return (
      <div className="page">
        <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-5">
          {header}
          <p className="text-sm text-text-secondary">
            در حال دریافت تنظیمات تلگرام…
          </p>
        </div>
      </div>
    );
  }

  if (!settings.telegram_status.connected) {
    return (
      <div className="page">
        <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-5">
          {header}
          <StepCard
            title="اتصال تلگرام"
            description="برای ارسال پست، ابتدا ربات را در تنظیمات آماده کنید."
          >
            <p className="text-sm text-text-secondary">
              ربات تلگرام هنوز متصل نیست. اطلاعات ربات را در تنظیمات وارد کنید.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={onSettings}>
                رفتن به تنظیمات
              </Button>
              <Button type="button" variant="outline" onClick={onBackToClips}>
                بازگشت به کلیپ‌ها
              </Button>
            </div>
          </StepCard>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-5">
        {header}

        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-[8px] border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {step === "media" ? (
          <StepCard
            title={choosing || !clip ? "انتخاب کلیپ" : "کلیپ و کاور"}
            description={
              choosing || !clip
                ? "از کلیپ‌های رندرشده یکی را برای ارسال انتخاب کنید."
                : "کلیپ انتخاب‌شده را بررسی کنید و کاور پست تلگرام را مشخص کنید."
            }
          >
            {choosing || !clip ? (
              clips.length ? (
                <>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {clips.map((item) => (
                      <ClipOption
                        key={item.id}
                        clip={item}
                        selected={clip?.id === item.id}
                        onSelect={() => {
                          onSelectClip(item);
                          setChoosing(false);
                        }}
                      />
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={onBackToClips}
                    >
                      بازگشت به کلیپ‌ها
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center gap-3 rounded-[8px] border border-dashed border-border-secondary bg-elevation-2 px-4 py-10 text-center">
                  <Film className="size-8 text-text-tertiary" />
                  <div className="flex flex-col gap-1">
                    <strong className="text-sm font-medium text-text-primary">
                      هنوز کلیپ رندرشده‌ای ندارید
                    </strong>
                    <p className="text-sm text-text-secondary">
                      ابتدا یک پروژه را رندر کنید تا اینجا برای ارسال قابل
                      انتخاب باشد.
                    </p>
                  </div>
                  <Button type="button" onClick={onBackToClips}>
                    رفتن به کلیپ‌ها
                  </Button>
                </div>
              )
            ) : (
              <>
                <div className="overflow-hidden rounded-[8px] border border-border-tertiary bg-black">
                  <video
                    ref={(element) => {
                      video.current = element;
                    }}
                    className="max-h-[340px] w-full bg-black"
                    src={`/api/media/clip/${clip.id}`}
                    poster={
                      clip.has_cover
                        ? `/api/media/clip/${clip.id}/cover?v=${clip.metadata.cover?.revision}`
                        : undefined
                    }
                    controls
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-[6px] border border-border-tertiary bg-elevation-2 px-2 py-2 sm:px-3">
                    <span className="block text-xs text-text-tertiary">
                      مدت
                    </span>
                    <strong className="text-sm font-medium text-text-primary">
                      {clock(clip.metadata.duration)}
                    </strong>
                  </div>
                  <div className="rounded-[6px] border border-border-tertiary bg-elevation-2 px-2 py-2 sm:px-3">
                    <span className="block text-xs text-text-tertiary">
                      رزولوشن
                    </span>
                    <strong
                      className="text-sm font-medium text-text-primary"
                      dir="ltr"
                    >
                      {clip.metadata.width} × {clip.metadata.height}
                    </strong>
                  </div>
                  <div className="rounded-[6px] border border-border-tertiary bg-elevation-2 px-2 py-2 sm:px-3">
                    <span className="block text-xs text-text-tertiary">
                      حجم
                    </span>
                    <strong className="text-sm font-medium text-text-primary">
                      {size(clip.metadata.size)}
                    </strong>
                  </div>
                </div>

                <TelegramCover
                  clip={clip}
                  video={video}
                  jobs={jobs}
                  refresh={refresh}
                  toast={toast}
                  onError={onError}
                />

                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" onClick={() => goTo("caption")}>
                    ادامه
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setChoosing(true)}
                  >
                    تغییر کلیپ
                  </Button>
                </div>
              </>
            )}
          </StepCard>
        ) : null}

        {step === "caption" && clip ? (
          <StepCard
            title="کپشن پست"
            description="متن همراه ویدیو را بنویسید یا از کپشن خودکار استفاده کنید."
          >
            <div className="rounded-[8px] border border-border-tertiary bg-elevation-2">
              <div className="min-h-[84px] px-3 py-2.5 text-sm text-text-primary">
                {caption ? (
                  <TelegramRichText text={caption} format={captionFormat} />
                ) : (
                  <span className="text-text-tertiary">
                    هنوز کپشنی نیست. متن قالب‌بندی‌شده، لینک یا ایموجی اضافه
                    کنید.
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-tertiary px-3 py-2">
                <span className="text-xs text-text-tertiary">
                  {captionLength} / {CAPTION_LIMIT}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={captionBusy || !settings.ai.api_key_saved}
                    onClick={() => void autoCaption()}
                    title={
                      !settings.ai.api_key_saved
                        ? "ابتدا توکن API سرویس 9Router را در تنظیمات وارد کنید"
                        : "با استفاده از پرامپت موجود در تنظیمات، از زیرنویس‌های این کلیپ کپشن بنویس"
                    }
                  >
                    {captionBusy ? (
                      <LoaderCircle className="spin" />
                    ) : (
                      <Sparkles />
                    )}
                    {captionBusy ? "در حال نوشتن…" : "کپشن خودکار"}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setCaptionOpen(true)}
                  >
                    <Pencil />
                    {caption ? "ویرایش کپشن" : "نوشتن کپشن"}
                  </Button>
                </div>
              </div>
            </div>
            <p className="text-sm text-text-secondary">
              کپشن خودکار از زیرنویس‌های انگلیسی و فارسی کلیپ و همچنین پرامپت
              سیستمی در تنظیمات ← زیرنویس و کپشن خودکار استفاده می‌کند.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={() => goTo("publish")}>
                ادامه
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => goTo("media")}
              >
                بازگشت
              </Button>
            </div>
          </StepCard>
        ) : null}

        {step === "publish" && clip ? (
          <StepCard
            title="تنظیمات انتشار"
            description="مقصد و شکل ارسال پست را انتخاب کنید."
          >
            <label
              htmlFor="send-to-channel"
              className="flex cursor-pointer items-start justify-between gap-4 rounded-[8px] border border-border-tertiary bg-elevation-2 p-4"
            >
              <span className="flex flex-col gap-1">
                <span className="text-sm font-medium text-text-primary">
                  ارسال به کانال
                </span>
                <span className="text-sm text-text-secondary">
                  برای ارسال تستی، این گزینه را خاموش کنید و شناسه چت مقصد را
                  دستی وارد کنید.
                </span>
              </span>
              <Switch
                id="send-to-channel"
                checked={sendToChannel}
                onCheckedChange={setSendToChannel}
                aria-label="ارسال به کانال"
                className="mt-0.5"
              />
            </label>

            {sendToChannel ? (
              channels.length ? (
                <label className="flex flex-col gap-1.5 text-sm text-text-primary">
                  کانال مقصد
                  <Select
                    value={channel?.id ?? ""}
                    onValueChange={(value) => setDestination(value)}
                  >
                    <SelectTrigger aria-label="کانال مقصد">
                      <SelectValue placeholder="یک کانال انتخاب کنید" />
                    </SelectTrigger>
                    <SelectContent>
                      {channels.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                          {item.username ? ` (@${item.username})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              ) : (
                <p className="text-sm text-text-secondary">
                  هنوز کانالی ثبت نشده است. یک کانال در تنظیمات اضافه کنید یا
                  «ارسال به کانال» را خاموش کنید و شناسه چت را وارد کنید.
                </p>
              )
            ) : (
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="test-chat-id"
                  className="text-sm text-text-primary"
                >
                  شناسه چت مقصد (Chat ID)
                </label>
                <Input
                  id="test-chat-id"
                  dir="ltr"
                  value={chatId}
                  onChange={(event) => setChatId(event.target.value)}
                  placeholder="-1001234567890"
                  aria-invalid={manualChatId ? !chatIdValid : undefined}
                  aria-describedby="test-chat-id-hint"
                />
                <p
                  id="test-chat-id-hint"
                  className="text-sm text-text-secondary"
                >
                  برای گرفتن شناسه، در چت خصوصی ربات
                  {settings.telegram_status.username
                    ? ` (@${settings.telegram_status.username})`
                    : ""}{" "}
                  یا در گروهی که ربات عضو آن است دستور{" "}
                  <span dir="ltr" className="font-mono">
                    /chatid
                  </span>{" "}
                  را بفرستید. ربات باید به آن چت دسترسی داشته باشد.
                </p>
                {manualChatId && !chatIdValid ? (
                  <p className="text-sm text-destructive">
                    شناسه چت باید عددی باشد؛ مانند -1001234567890. می‌توانید نام
                    کاربری عمومی را هم با @ وارد کنید.
                  </p>
                ) : null}
              </div>
            )}

            {sendToChannel && channel?.error ? (
              <p className="text-sm text-destructive">
                وضعیت این کانال: {channel.error}
              </p>
            ) : null}

            <label
              htmlFor="send-as-file"
              className="flex cursor-pointer items-start justify-between gap-4 rounded-[8px] border border-border-tertiary bg-elevation-2 p-4"
            >
              <span className="flex flex-col gap-1">
                <span className="text-sm font-medium text-text-primary">
                  ارسال به‌صورت فایل
                </span>
                <span className="text-sm text-text-secondary">
                  ویدیو به‌جای ویدیوی قابل پخش، به‌صورت سند ارسال می‌شود.
                </span>
              </span>
              <Switch
                id="send-as-file"
                checked={asFile}
                onCheckedChange={setAsFile}
                aria-label="ارسال به‌صورت فایل"
                className="mt-0.5"
              />
            </label>
            <p className="text-sm text-text-secondary">
              ویدیوها از طریق MTProto و با ربات شما آپلود می‌شوند، تا ۲
              گیگابایت.
              {coverPending
                ? " کاور در حال آماده‌سازی است و پیش از ارسال کامل می‌شود."
                : ""}
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={() => goTo("review")}
                disabled={!destinationReady}
              >
                بازبینی نهایی
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => goTo("caption")}
              >
                بازگشت
              </Button>
            </div>
          </StepCard>
        ) : null}

        {step === "review" && clip ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-[8px] border border-border-tertiary bg-elevation-1 p-4">
              <div className="flex flex-col gap-1">
                <h2 className="text-base font-medium text-text-primary">
                  پیش‌نمایش کپشن
                </h2>
                <p className="text-sm text-text-secondary">
                  این متن همراه ویدیو ارسال می‌شود.
                </p>
              </div>
              <div
                className="mt-4 min-h-[150px] rounded-[8px] border border-border-tertiary bg-elevation-2 p-3 text-sm text-text-primary"
                dir="auto"
              >
                {caption ? (
                  <TelegramRichText text={caption} format={captionFormat} />
                ) : (
                  <span className="text-text-tertiary">
                    بدون کپشن — فقط ویدیو و کاور ارسال می‌شود.
                  </span>
                )}
              </div>
            </section>

            <section className="flex flex-col rounded-[8px] border border-border-tertiary bg-elevation-1 p-4">
              <div className="flex flex-col gap-1">
                <h2 className="text-base font-medium text-text-primary">
                  خلاصه ارسال
                </h2>
                <p className="text-sm text-text-secondary">
                  پیش از نهایی کردن، مقصد و تنظیمات را بررسی کنید.
                </p>
              </div>
              <div className="mt-3">
                <SummaryRow
                  label="کلیپ"
                  value={<span className="truncate">{clip.name}</span>}
                />
                <SummaryRow
                  label={sendToChannel ? "کانال" : "چت مقصد"}
                  value={
                    sendToChannel ? (
                      channel ? (
                        `${channel.name}${channel.username ? ` (@${channel.username})` : ""}`
                      ) : (
                        "انتخاب نشده"
                      )
                    ) : manualChatId ? (
                      <span dir="ltr">{manualChatId}</span>
                    ) : (
                      "وارد نشده"
                    )
                  }
                />
                <SummaryRow
                  label="نوع ارسال"
                  value={asFile ? "فایل (سند)" : "ویدیوی قابل پخش"}
                />
                <SummaryRow label="مدت" value={clock(clip.metadata.duration)} />
                <SummaryRow
                  label="رزولوشن"
                  value={
                    <span dir="ltr">
                      {clip.metadata.width} × {clip.metadata.height}
                    </span>
                  }
                />
                <SummaryRow label="حجم" value={size(clip.metadata.size)} />
                <SummaryRow
                  label="کاور"
                  value={clip.has_cover ? coverLabel : "کاور خودکار"}
                />
                <SummaryRow
                  label="کپشن"
                  value={
                    captionLength ? `${captionLength} کاراکتر` : "بدون کپشن"
                  }
                />
              </div>
              {coverPending ? (
                <p className="mt-3 text-sm text-warning">
                  آماده‌سازی کاور در حال انجام است؛ ارسال پس از تکمیل آن شروع
                  می‌شود.
                </p>
              ) : null}
              <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
                <Button
                  type="button"
                  onClick={() => void send()}
                  disabled={submitting || coverPending || !destinationReady}
                >
                  {submitting ? <LoaderCircle className="spin" /> : <Send />}
                  {submitting ? "در حال ثبت…" : "همین حالا ارسال کنید"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => goTo("publish")}
                  disabled={submitting}
                >
                  بازگشت
                </Button>
              </div>
            </section>
          </div>
        ) : null}

        {step === "success" ? (
          <section className="mx-auto flex w-full max-w-2xl flex-col gap-4">
            <div className="rounded-[8px] border border-success/40 bg-success/10 p-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
                <div className="flex flex-col gap-1">
                  <h2 className="text-base font-medium text-text-primary">
                    ارسال در صف قرار گرفت
                  </h2>
                  <p className="text-sm text-text-secondary">
                    {sendToChannel ? (
                      <>
                        پست برای کانال{" "}
                        <strong className="font-medium text-text-primary">
                          {channel?.name}
                        </strong>{" "}
                        در صف ارسال قرار گرفت.
                      </>
                    ) : (
                      <>
                        ارسال تستی به چت{" "}
                        <strong
                          className="font-medium text-text-primary"
                          dir="ltr"
                        >
                          {manualChatId}
                        </strong>{" "}
                        در صف قرار گرفت.
                      </>
                    )}{" "}
                    پیشرفت را در بخش فعالیت‌ها دنبال کنید.
                    {jobId ? (
                      <span className="mt-1 block text-xs text-text-tertiary">
                        شناسه کار: <span dir="ltr">{jobId}</span>
                      </span>
                    ) : null}
                  </p>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={() => resetComposer(true)}>
                <RotateCcw />
                ارسال پست دیگر
              </Button>
              <Button type="button" variant="outline" onClick={onQueue}>
                <ListVideo />
                مشاهده فعالیت‌ها
              </Button>
              <Button type="button" variant="ghost" onClick={onBackToClips}>
                بازگشت به کلیپ‌ها
              </Button>
            </div>
          </section>
        ) : null}

        <TelegramEditorModal
          open={captionOpen}
          onClose={() => setCaptionOpen(false)}
          value={caption}
          onChange={setCaption}
          format={captionFormat}
          onFormatChange={setCaptionFormat}
          maxLength={CAPTION_LIMIT}
          richEnabled={false}
          defaultShowPreview
          title="کپشن پست"
          label="کپشن برای پست کانال Telegram شما"
          placeholder="کپشن بنویسید…"
          previewTitle={settings.telegram_status.name || "کانال Telegram"}
        />
      </div>
    </div>
  );
}
