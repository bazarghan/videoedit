import { useEffect, useState } from "react";
import {
  Send,
  ShieldCheck,
  HardDrive,
  LoaderCircle,
  Trash2,
  Check,
  Sparkles,
  Mic,
  Languages,
  Bot,
  Radio,
  Plus,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { api, json, size, Settings } from "./types";
import ProjectDefaultsPanel from "./ProjectDefaults";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { useConfirm } from "./components/ui/confirm-dialog";
import { settingsSections, type SettingsSectionId } from "./settingsSections";
type Props = {
  section: SettingsSectionId;
  onSection: (section: SettingsSectionId) => void;
  onSettings: (s: Settings) => void;
  onError: (s: string) => void;
  toast: (s: string) => void;
};
export default function SettingsPage({
  section,
  onSection,
  onSettings,
  onError,
  toast,
}: Props) {
  const confirm = useConfirm();
  const [settings, setSettings] = useState<Settings | null>(null),
    [apiId, setApiId] = useState(""),
    [hash, setHash] = useState(""),
    [botToken, setBotToken] = useState(""),
    [channel, setChannel] = useState(""),
    [limit, setLimit] = useState(20),
    [aiBase, setAiBase] = useState("http://localhost:20128/v1"),
    [aiModel, setAiModel] = useState("kr/claude-sonnet-4.5"),
    [aiPrompt, setAiPrompt] = useState(""),
    [aiKey, setAiKey] = useState(""),
    [elevenModel, setElevenModel] = useState("scribe_v2"),
    [elevenMax, setElevenMax] = useState(6),
    [elevenKey, setElevenKey] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    const s = await api<Settings>("/settings");
    setSettings(s);
    onSettings(s);
    setApiId(String(s.telegram.api_id));
    setLimit(s.storage.limit_gb);
    setAiBase(s.ai.base_url);
    setAiModel(s.ai.model);
    setAiPrompt(s.ai.caption_prompt || "");
    setElevenModel(s.elevenlabs.model);
    setElevenMax(s.elevenlabs.max_duration_minutes);
  }
  useEffect(() => {
    load().catch((e) => onError(e.message));
  }, []);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!settings)
    return (
      <div className="page loading">
        <LoaderCircle className="spin" /> در حال بارگذاری تنظیمات…
      </div>
    );
  const connected = settings.telegram_status.connected;
  const activeSection =
    settingsSections.find((item) => item.id === section) ??
    settingsSections[0];
  return (
    <div className="page settings-page">
      <div className="page-heading compact">
        <div>
          <span className="eyebrow">تنظیمات فضای کاری</span>
          <h1>{activeSection.label}</h1>
          <p>{activeSection.description}</p>
        </div>
      </div>
      <div className="settings-content">
        <div className="settings-mobile-tabs" role="tablist" aria-label="بخش‌های تنظیمات">
          {settingsSections.map((item) => {
            const ItemIcon = item.icon;
            return (
              <button
                type="button"
                key={item.id}
                role="tab"
                aria-selected={section === item.id}
                className={section === item.id ? "active" : ""}
                onClick={() => onSection(item.id)}
              >
                <ItemIcon size={14} />
                {item.label}
              </button>
            );
          })}
        </div>
          <div hidden={section !== "defaults"}>
            <ProjectDefaultsPanel
              initial={settings.project_defaults}
              onSaved={(defaults) => {
                const next = { ...settings, project_defaults: defaults };
                setSettings(next);
                onSettings(next);
              }}
              onError={onError}
              toast={toast}
            />
          </div>
          <div hidden={section !== "subtitles"}>
            <section className="panel">
              <div className="panel-heading">
                <div className="panel-icon">
                  <Sparkles size={22} />
                </div>
                <div>
                  <h2>زیرنویس و کپشن خودکار</h2>
                  <p>
                    ElevenLabs رونویسی می‌کند؛ 9Router ترجمه می‌کند و
                    کپشن‌های Telegram را می‌نویسد.
                  </p>
                </div>
                <span
                  className={
                    "badge " +
                    (settings.ai.api_key_saved &&
                    settings.elevenlabs.api_key_saved
                      ? "success"
                      : "")
                  }
                >
                  {settings.ai.api_key_saved &&
                  settings.elevenlabs.api_key_saved
                    ? "آماده"
                    : "نیازمند توکن"}
                </span>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    await api(
                      "/settings/elevenlabs",
                      json("PUT", {
                        api_key: elevenKey,
                        model: elevenModel,
                        max_duration_minutes: Number(elevenMax),
                      }),
                    );
                    await api(
                      "/settings/ai",
                      json("PUT", {
                        api_key: aiKey,
                        base_url: aiBase,
                        model: aiModel,
                        caption_prompt: aiPrompt,
                      }),
                    );
                    setAiKey("");
                    setElevenKey("");
                    await load();
                    toast("تنظیمات زیرنویس و کپشن خودکار ذخیره شد.");
                  });
                }}
              >
                <div className="section-heading">
                  <h3>
                    <Mic size={14} /> رونویسی ElevenLabs
                  </h3>
                  <span>منبع انگلیسی</span>
                </div>
                <label>
                  توکن API ElevenLabs
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={elevenKey}
                    onChange={(e) => setElevenKey(e.target.value)}
                    placeholder={
                      settings.elevenlabs.api_key_saved
                        ? "به‌صورت امن ذخیره شده — برای حفظ آن خالی بگذارید"
                        : "xi-api-key از elevenlabs.io"
                    }
                  />
                </label>
                <label>
                  مدل رونویسی
                  <Input
                    value={elevenModel}
                    onChange={(e) => setElevenModel(e.target.value)}
                    placeholder="scribe_v2"
                  />
                </label>
                <label>
                  حداکثر طول ویدیو (دقیقه)
                  <Input
                    type="number"
                    min={1}
                    max={600}
                    step={1}
                    value={elevenMax}
                    onChange={(e) => setElevenMax(Number(e.target.value))}
                    required
                  />
                </label>
                <p className="hint">
                  ویدیوهای طولانی‌تر از این مقدار، پیش از مصرف توکن‌های
                  ElevenLabs مسدود می‌شوند. مقدار پیش‌فرض ۶ دقیقه است.
                </p>
                <p className="hint">
                  برای ElevenLabs Scribe v2 از <code>scribe_v2</code> (پیشنهادی)
                  یا برای مدل قدیمی‌تر از <code>scribe_v1</code> استفاده کنید.
                  شناسه مدل مستقیماً به‌عنوان <code>model_id</code> به
                  ElevenLabs ارسال می‌شود.
                </p>
                <div className="control-divider" />
                <div className="section-heading">
                  <h3>
                    <Languages size={14} /> ترجمه 9Router
                  </h3>
                  <span>خروجی فارسی</span>
                </div>
                <label>
                  آدرس پایه 9Router
                  <Input
                    value={aiBase}
                    onChange={(e) => setAiBase(e.target.value)}
                    placeholder="http://localhost:20128/v1"
                    required
                  />
                </label>
                <label>
                  توکن API 9Router
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={aiKey}
                    onChange={(e) => setAiKey(e.target.value)}
                    placeholder={
                      settings.ai.api_key_saved
                        ? "به‌صورت امن ذخیره شده — برای حفظ آن خالی بگذارید"
                        : "کلید را از داشبورد 9Router کپی کنید"
                    }
                  />
                </label>
                <label>
                  مدل ترجمه
                  <Input
                    value={aiModel}
                    onChange={(e) => setAiModel(e.target.value)}
                    placeholder="kr/claude-sonnet-4.5"
                    required
                  />
                </label>
                <div className="control-divider" />
                <div className="section-heading">
                  <h3>
                    <Send size={14} /> کپشن‌های Telegram
                  </h3>
                  <span>قالب کپشن خودکار</span>
                </div>
                <label>
                  پرامپت سیستمی کپشن
                  <Textarea
                    className="min-h-56 text-xs leading-relaxed"
                    rows={12}
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="قالب دقیق کپشنی که AI باید برگرداند را توصیف کنید…"
                  />
                </label>
                <p className="hint">
                  کپشن خودکار زیرنویس‌های انگلیسی و فارسی این کلیپ را همراه با
                  این پرامپت سیستمی به مدل 9Router شما می‌فرستد. برای بازگرداندن
                  قالب کپشن فارسی پیش‌فرض، فیلد را خالی کنید.
                </p>
                <p className="hint">
                  هر دو توکن به‌صورت رمزنگاری‌شده ذخیره می‌شوند و هرگز به مرورگر
                  بازگردانده نمی‌شوند. نقطه پایانی 9Router باید با OpenAI سازگار
                  باشد (<code>/chat/completions</code>). 9Router را محلی اجرا
                  کنید یا این را به درگاه خودتان متصل کنید.
                </p>
                <button className="secondary" disabled={busy}>
                  {busy ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <Check size={16} />
                  )}{" "}
                  ذخیره تنظیمات AI
                </button>
              </form>
            </section>
          </div>
          <div hidden={section !== "telegram"}>
            <div className="settings-stack">
              <section className="panel">
                <div className="panel-heading">
                  <div className="panel-icon">
                    <Bot size={22} />
                  </div>
                  <div>
                    <h2>ربات Telegram</h2>
                    <p>کلیپ‌ها را از طریق ربات خودتان ارسال کنید، نه حساب شخصی.</p>
                  </div>
                  <span className={"badge " + (connected ? "success" : "")}>
                    {connected ? "آنلاین" : "نیازمند تنظیم"}
                  </span>
                </div>
                {connected && (
                  <div className="connected-card">
                    <ShieldCheck size={20} />
                    <div>
                      <strong>{settings.telegram_status.name}</strong>
                      <small>
                        {settings.telegram_status.username
                          ? "@" + settings.telegram_status.username
                          : "اعتبارنامه‌های ربات تأیید شد"}
                      </small>
                    </div>
                    <span className="badge success">متصل</span>
                  </div>
                )}
                {!connected && settings.telegram_status.error && (
                  <p role="alert" className="inline-error">
                    {settings.telegram_status.error}
                  </p>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(async () => {
                      let saved = false;
                      try {
                        await api(
                          "/settings/telegram",
                          json("PUT", {
                            api_id: Number(apiId),
                            api_hash: hash,
                            bot_token: botToken,
                          }),
                        );
                        saved = true;
                      } finally {
                        setHash("");
                        setBotToken("");
                        await load();
                      }
                      if (saved) toast("تنظیمات ربات Telegram ذخیره شد.");
                    });
                  }}
                >
                  <div className="form-row">
                    <label>
                      شناسه API
                      <Input
                        inputMode="numeric"
                        type="number"
                        value={apiId}
                        onChange={(e) => setApiId(e.target.value)}
                        required
                        min={1}
                      />
                    </label>
                    <label>
                      هش API
                      <Input
                        type="password"
                        autoComplete="new-password"
                        value={hash}
                        onChange={(e) => setHash(e.target.value)}
                        placeholder={
                          settings.telegram.api_hash_saved
                            ? "به‌صورت امن ذخیره شده — برای حفظ آن خالی بگذارید"
                            : "هش API ۳۲ کاراکتری"
                        }
                        required={!settings.telegram.api_hash_saved}
                      />
                    </label>
                  </div>
                  <label>
                    توکن ربات
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={botToken}
                      onChange={(e) => setBotToken(e.target.value)}
                      placeholder={
                        settings.telegram.bot_token_saved
                          ? "به‌صورت امن ذخیره شده — برای حفظ آن خالی بگذارید"
                          : "123456:ABC-DEF… از @BotFather"
                      }
                      required={!settings.telegram.bot_token_saved}
                    />
                  </label>
                  <p className="hint">
                    یک ربات با{" "}
                    <a
                      href="https://t.me/BotFather"
                      target="_blank"
                      rel="noreferrer"
                    >
                      @BotFather
                    </a>{" "}
                    و یک اپلیکیشن API در{" "}
                    <a
                      href="https://my.telegram.org/apps"
                      target="_blank"
                      rel="noreferrer"
                    >
                      my.telegram.org
                    </a>
                    . شناسه و هش API امکان آپلود MTProto را فراهم می‌کنند تا
                    کلیپ‌های بزرگ‌تر از محدودیت 20 MB در Bot API هم ارسال شوند.
                  </p>
                  <button className="secondary" disabled={busy}>
                    {busy ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Bot size={16} />
                    )}{" "}
                    ذخیره تنظیمات ربات
                  </button>
                </form>
                <div className="note">
                  <Check size={16} />
                  <span>
                    توکن ربات و اعتبارنامه‌های API به‌صورت رمزنگاری‌شده ذخیره
                    می‌شوند. هیچ حساب شخصی Telegram وارد یا ذخیره نمی‌شود.
                  </span>
                </div>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div className="panel-icon">
                    <Radio size={22} />
                  </div>
                  <div>
                    <h2>کانال‌ها</h2>
                    <p>یک کانال اضافه کنید و تأیید کنید که ربات می‌تواند در آن ارسال کند.</p>
                  </div>
                  <span className="badge">
                    {settings.telegram.channels.length || 0} کانال
                  </span>
                </div>
                {settings.telegram.channels.length ? (
                  <div className="channel-list">
                    {settings.telegram.channels.map((item) => (
                      <div className="channel-row" key={item.id}>
                        <span className="channel-icon">
                          <Radio size={17} />
                        </span>
                        <div className="channel-copy">
                          <strong>{item.name}</strong>
                          <small>
                            {item.username ? "@" + item.username : item.id}
                          </small>
                          {item.error ? (
                            <small className="channel-error">
                              <AlertTriangle size={12} /> {item.error}
                            </small>
                          ) : (
                            <small className="channel-ok">
                              <Check size={12} /> تأیید شد — ربات مدیر است
                            </small>
                          )}
                        </div>
                        <button
                          className="icon-button"
                          aria-label={`تأیید ${item.name}`}
                          title="بررسی دسترسی ربات"
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              await api(
                                `/telegram/channels/${item.id}/verify`,
                                json("POST"),
                              );
                              await load();
                              toast("دسترسی کانال تأیید شد.");
                            })
                          }
                        >
                          <RefreshCw size={15} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`حذف ${item.name}`}
                          disabled={busy}
                          onClick={async () => {
                            if (
                              !(await confirm({
                                title: "حذف کانال",
                                message: `${item.name} از تنظیمات حذف شود؟`,
                                confirmLabel: "حذف کانال",
                              }))
                            )
                              return;
                            run(async () => {
                              await api(
                                `/telegram/channels/${item.id}`,
                                json("DELETE"),
                              );
                              await load();
                              toast("کانال حذف شد.");
                            });
                          }}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="hint">
                    هنوز کانالی وجود ندارد. ربات را به مدیر کانال ارتقا دهید،
                    سپس کانال را در پایین اضافه کنید.
                  </p>
                )}
                <form
                  className="channel-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(async () => {
                      await api(
                        "/telegram/channels",
                        json("POST", { channel }),
                      );
                      setChannel("");
                      await load();
                      toast("کانال تأیید و اضافه شد.");
                    });
                  }}
                >
                  <label>
                    افزودن کانال
                    <Input
                      value={channel}
                      onChange={(e) => setChannel(e.target.value)}
                      placeholder="@channel، t.me/channel یا -100…"
                      required
                    />
                  </label>
                  <button className="secondary" disabled={busy || !connected}>
                    {busy ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Plus size={16} />
                    )}{" "}
                    افزودن و تأیید
                  </button>
                </form>
                <p className="hint">
                  این بررسی تأیید می‌کند که ربات مدیر با مجوز ارسال پیام است.
                  ابتدا اعتبارنامه‌های معتبر ربات را ذخیره کنید.
                </p>
              </section>
            </div>
          </div>
          <div hidden={section !== "storage"}>
            <section className="panel">
              <div className="panel-heading">
                <div className="panel-icon">
                  <HardDrive size={22} />
                </div>
                <div>
                  <h2>فضای ذخیره‌سازی</h2>
                  <p>برای پروژه بعدی خود جا باز کنید.</p>
                </div>
              </div>
              <div className="storage-total">
                <strong>{size(settings.storage.used)}</strong>
                <span>از {settings.storage.limit_gb} GB محدودیت فضای کاری</span>
              </div>
              <div className="meter large">
                <i
                  style={{
                    width: `${Math.min(100, (settings.storage.used / (settings.storage.limit_gb * 1024 ** 3)) * 100)}%`,
                  }}
                />
              </div>
              <p className="hint">
                {size(settings.storage.free)} روی حجم در دسترس است. 1 GB
                به‌عنوان ذخیره برای پردازش ایمن نگه داشته می‌شود.
              </p>
              <form
                className="limit-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    await api(
                      "/settings/storage",
                      json("PUT", { limit_gb: limit }),
                    );
                    await load();
                    toast("محدودیت فضای ذخیره‌سازی ذخیره شد.");
                  });
                }}
              >
                <label>
                  محدودیت فضای کاری (GB)
                  <Input
                    type="number"
                    min={2}
                    max={10000}
                    value={limit}
                    onChange={(e) => setLimit(Number(e.target.value))}
                  />
                </label>
                <button className="secondary" disabled={busy}>
                  ذخیره محدودیت
                </button>
              </form>
              <div className="cleanup-list">
                {Object.entries(settings.storage.categories)
                  .filter(([name]) =>
                    ["sources", "thumbnails", "renders", "assets"].includes(
                      name,
                    ),
                  )
                  .map(([name, bytes]) => (
                    <div key={name}>
                      <span>
                        <strong>
                          {
                            {
                              sources: "ویدیوهای اصلی",
                              thumbnails: "تصاویر بندانگشتی پروژه",
                              renders: "کلیپ‌های رندرشده",
                              assets: "موسیقی و واترمارک‌ها",
                            }[name]
                          }
                        </strong>
                        <small>{size(bytes)}</small>
                      </span>
                      {name !== "assets" && (
                        <button
                          className="icon-button"
                          aria-label={`پاک‌سازی ${name}`}
                          disabled={busy}
                          onClick={async () => {
                            if (
                              !(await confirm({
                                title: "پاک‌سازی فایل‌ها",
                                message:
                                  name === "sources"
                                    ? "همه ویدیوهای اصلی حذف شوند؟ خروجی‌های موجود باقی می‌مانند، اما این پروژه‌ها دیگر قابل رندر نیستند."
                                    : name === "renders"
                                      ? "همه کلیپ‌های رندرشده و پیش‌نمایش‌های رندرشده حذف شوند؟"
                                      : "همه تصاویر بندانگشتی پروژه حذف شوند؟ پروژه‌ها ویدیوها و رندرهای خود را حفظ می‌کنند.",
                                confirmLabel: "پاک‌سازی",
                              }))
                            )
                              return;
                            run(async () => {
                              await api(
                                `/settings/cleanup/${name}`,
                                json("POST"),
                              );
                              await load();
                              toast("فایل‌ها پاک‌سازی شدند.");
                            });
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  ))}
              </div>
              <p className="hint">
                پاک‌سازی زمانی در دسترس است که همه کارهای فعال تمام شوند. برای
                حذف هم‌زمان فایل‌های اصلی، دارایی‌ها، زیرنویس‌ها، تصاویر
                بندانگشتی و خروجی‌های یک پروژه، آن پروژه را حذف کنید.
              </p>
            </section>
          </div>
        </div>
    </div>
  );
}
