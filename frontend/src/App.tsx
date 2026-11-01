import { useEffect, useState } from "react";
import {
  Scissors,
  LayoutGrid,
  ListVideo,
  Film,
  Settings as SettingsIcon,
  LogOut,
  Plus,
  ArrowUpRight,
  Upload,
  Link,
  Play,
  Download,
  Send,
  Trash2,
  X,
  LoaderCircle,
  Check,
  ChevronRight,
  HardDrive,
  Sparkles,
  ChevronDown,
  SlidersHorizontal,
} from "lucide-react";
import {
  api,
  json,
  size,
  clock,
  Project,
  Job,
  Clip,
  Settings,
  DownloadProxy,
  DownloadProxyDraft,
} from "./types";
import Editor from "./Editor";
import SettingsPage from "./Settings";
import DownloadProxyFields from "./DownloadProxy";
import TelegramPostPage from "./TelegramPostPage";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";

const emptyProxy: DownloadProxyDraft = {
  host: "",
  port: 1080,
  username: "",
  password: "",
  password_saved: false,
  clear_password: false,
};

const nav = [
  { id: "projects", label: "پروژه‌ها", icon: LayoutGrid },
  { id: "queue", label: "فعالیت‌ها", icon: ListVideo },
  { id: "clips", label: "کلیپ‌های رندرشده", icon: Film },
  { id: "post", label: "ارسال پست", icon: Send },
  { id: "settings", label: "تنظیمات", icon: SettingsIcon },
];

const statusLabels: Record<string, string> = {
  ready: "آماده",
  pending: "در انتظار",
  queued: "در صف",
  running: "در حال اجرا",
  completed: "انجام شد",
  failed: "ناموفق",
  cancelled: "لغو شده",
  interrupted: "قطع شده",
};
const statusLabel = (status: string) => statusLabels[status] || status;

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null),
    [page, setPage] = useState("projects"),
    [selected, setSelected] = useState("");
  const [projects, setProjects] = useState<Project[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [clips, setClips] = useState<Clip[]>([]),
    [settings, setSettings] = useState<Settings | null>(null);
  const [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [importOpen, setImportOpen] = useState(false),
    [openClip, setOpenClip] = useState<Clip | null>(null),
    [busy, setBusy] = useState(false);
  const [url, setUrl] = useState(""),
    [name, setName] = useState(""),
    [tab, setTab] = useState("url"),
    [progress, setProgress] = useState(0);
  const [useProxy, setUseProxy] = useState(false),
    [proxy, setProxy] = useState<DownloadProxyDraft>(emptyProxy),
    [proxyBusy, setProxyBusy] = useState(false);
  const [postClip, setPostClip] = useState<Clip | null>(null);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const active = jobs.filter((j) => ["queued", "running"].includes(j.status));
  useEffect(() => {
    if (page === "settings") setSettingsMenuOpen(true);
  }, [page]);
  useEffect(() => {
    if (openClip)
      setOpenClip(clips.find((clip) => clip.id === openClip.id) || openClip);
  }, [clips, openClip?.id]);
  useEffect(() => {
    api("/me")
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false));
  }, []);
  async function refresh() {
    const [p, j, c] = await Promise.all([
      api<Project[]>("/projects"),
      api<Job[]>("/jobs"),
      api<Clip[]>("/clips"),
    ]);
    setProjects(p);
    setJobs(j);
    setClips(c);
  }
  useEffect(() => {
    if (!authenticated) return;
    refresh().catch((e) => setError(e.message));
    api<Settings>("/settings")
      .then(setSettings)
      .catch((e) => setError(e.message));
    api<DownloadProxy>("/settings/download-proxy")
      .then((config) =>
        setProxy({ ...config, password: "", clear_password: false }),
      )
      .catch((e) => setError(e.message));
    const t = setInterval(() => refresh().catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [authenticated]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(t);
  }, [notice]);
  const toast = (message: string) => {
    setError("");
    setNotice(message);
  };
  async function action(fn: () => Promise<unknown>, message?: string) {
    try {
      await fn();
      if (message) toast(message);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function openEditor(id: string) {
    setSelected(id);
    setPage("editor");
    setImportOpen(false);
  }
  async function importURL(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (useProxy) await saveProxy();
      const r = await api(
        "/import/url",
        json("POST", {
          url,
          name: name || "Imported video",
          use_proxy: useProxy,
        }),
      );
      setUrl("");
      setName("");
      openEditor(r.project_id);
      toast("دانلود افزوده شد. ویرایشگر پس از پردازش آماده می‌شود.");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveProxy() {
    const config = await api<DownloadProxy>(
      "/settings/download-proxy",
      json("PUT", {
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password,
        clear_password: proxy.clear_password,
      }),
    );
    setProxy({ ...config, password: "", clear_password: false });
  }
  async function changeProxy(remove = false) {
    setProxyBusy(true);
    try {
      if (remove) {
        await api("/settings/download-proxy", json("DELETE"));
        setProxy(emptyProxy);
        setUseProxy(false);
      } else await saveProxy();
      toast(remove ? "پروکسی ذخیره‌شده حذف شد." : "پروکسی SOCKS5 با اطمینان ذخیره شد.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProxyBusy(false);
    }
  }
  function upload(file: File) {
    setBusy(true);
    setProgress(0);
    const form = new FormData();
    form.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/import/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      setBusy(false);
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 400)
          throw new Error(
            typeof data.detail === "string" ? data.detail : "بارگذاری ناموفق بود.",
          );
        openEditor(data.project_id);
        toast("ویدیو بارگذاری شد. ویرایشگر آماده می‌شود…");
        refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    };
    xhr.onerror = () => {
      setBusy(false);
      setError("بارگذاری قطع شد. دوباره تلاش کنید.");
    };
    xhr.send(form);
  }
  function showClip(clip: Clip) {
    setOpenClip(clip);
  }
  function openSend(clip: Clip) {
    setPostClip(clip);
    setOpenClip(null);
    setPage("post");
  }
  if (authenticated === null)
    return (
      <div className="splash">
        <LoaderCircle className="spin" /> در حال باز کردن استودیوی شما
      </div>
    );
  if (!authenticated) return <Login onLogin={() => setAuthenticated(true)} />;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("projects");
          }}
        >
          <span className="brand-mark">
            <Scissors size={21} />
          </span>
          videoedit<span className="brand-dot">.</span>
        </a>
        <div className="sidebar-label">فضای کاری شما</div>
        <nav>
          {nav.map((n) => {
            if (n.id === "settings") {
              return (
                <div className="nav-group" key={n.id}>
                  <button
                    className={
                      "nav-item nav-parent" +
                      (page === n.id ? " active" : "")
                    }
                    aria-expanded={settingsMenuOpen}
                    aria-controls="workspace-settings-submenu"
                    onClick={() => {
                      if (page === n.id) {
                        setSettingsMenuOpen((open) => !open);
                      } else {
                        setSettingsMenuOpen(true);
                        setPage(n.id);
                      }
                    }}
                  >
                    <n.icon size={19} />
                    {n.label}
                    <ChevronDown
                      className={
                        "nav-chevron" + (settingsMenuOpen ? " open" : "")
                      }
                      size={15}
                    />
                  </button>
                  {settingsMenuOpen && (
                    <div
                      className="nav-submenu"
                      id="workspace-settings-submenu"
                    >
                      <button
                        className={
                          "nav-subitem " +
                          (page === "settings" ? "active" : "")
                        }
                        aria-current={
                          page === "settings" ? "page" : undefined
                        }
                        onClick={() => setPage("settings")}
                      >
                        <SlidersHorizontal size={14} />
                        تنظیمات فضای کاری
                      </button>
                    </div>
                  )}
                </div>
              );
            }
            return (
              <button
                className={page === n.id ? "nav-item active" : "nav-item"}
                key={n.id}
                onClick={() => setPage(n.id)}
              >
                <n.icon size={19} />
                {n.label}
                {n.id === "queue" && active.length > 0 && (
                  <span className="count">{active.length}</span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="storage-mini">
            <HardDrive size={16} />
            <span>فضای ذخیره‌سازی</span>
          </div>
          <div className="meter">
            <i
              style={{
                width: `${Math.min(100, ((settings?.storage.used || 0) / ((settings?.storage.limit_gb || 20) * 1024 ** 3)) * 100)}%`,
              }}
            />
          </div>
          <small>
            <span dir="ltr">{size(settings?.storage.used)}</span> از{" "}
            <span dir="ltr">{settings?.storage.limit_gb || 20} GB</span>
          </small>
          <button
            aria-label="خروج از حساب"
            className="account"
            onClick={() =>
              action(async () => {
                await api("/logout", json("POST"));
                setAuthenticated(false);
              })
            }
          >
            <span className="avatar">A</span>
            <span>
              مدیر<small>فضای کاری خصوصی</small>
            </span>
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <main className={"main " + (page === "editor" ? "editor-main" : "")}>
        <header className="topbar">
          <span className="breadcrumb">
            فضای کاری <ChevronRight size={14} />{" "}
            {page === "editor"
              ? "ویرایشگر ویدیو"
              : nav.find((n) => n.id === page)?.label}
            {page === "settings" && (
              <>
                {" "}
                <ChevronRight size={14} /> تنظیمات فضای کاری
              </>
            )}
          </span>
          <span className="topbar-right">
            <span className="live-dot" />
            {active.length
              ? `${active.length} کار در حال اجرا`
              : "همه کارها انجام شد"}
          </span>
        </header>
        {page === "projects" && (
          <div className="page">
            <div className="page-heading">
              <div>
                <span className="eyebrow">کمی ویرایش، لحظه‌ای بزرگ</span>
                <h1>
                  کلیپ بعدی‌تان
                  <br />
                  از همین‌جا شروع می‌شود<span className="accent">.</span>
                </h1>
                <p>ویدیو را بیاورید. لحظه‌تان را پیدا کنید. مال خودتانش کنید.</p>
              </div>
              <button className="primary" onClick={() => setImportOpen(true)}>
                <Plus size={18} /> پروژه جدید
              </button>
            </div>
            <div className="import-banner">
              <div className="banner-icon">
                <Link size={26} />
              </div>
              <div>
                <h3>از یک لینک تا کلیپ آماده</h3>
                <p>
                  ویدیو را وارد کنید، کادر را تنظیم کنید، زیرنویس اضافه کنید و
                  به اشتراک بگذارید.
                </p>
              </div>
              <button
                className="secondary"
                onClick={() => {
                  setTab("url");
                  setImportOpen(true);
                }}
              >
                افزودن ویدیو <ArrowUpRight size={16} />
              </button>
            </div>
            <div className="section-heading">
              <h2>
                پروژه‌های اخیر <span>{projects.length}</span>
              </h2>
              <span className="muted">اصلی‌ها، ویرایش‌ها و ایده‌های شما</span>
            </div>
            {!projects.length ? (
              <div className="empty">
                <div className="empty-art">
                  <Film size={42} />
                  <span>
                    <Plus size={18} />
                  </span>
                </div>
                <h3>بوم سفیدی برای داستان بعدی شما</h3>
                <p>
                  یک لینک مستقیم ویدیو جای‌گذاری کنید یا فایل MP4، MKV یا WebM
                  بارگذاری کنید.
                </p>
                <button className="primary" onClick={() => setImportOpen(true)}>
                  اولین ویدیوی خود را وارد کنید <ArrowUpRight size={16} />
                </button>
              </div>
            ) : (
              <div className="project-grid">
                {projects.map((p) => (
                  <article className="project-card" key={p.id}>
                    <button
                      className="project-thumb"
                      onClick={() => openEditor(p.id)}
                    >
                      {p.has_thumbnail ? (
                        <img
                          src={`/api/media/project/${p.id}/thumbnail`}
                          alt="تصویر شاخص ویدیو"
                        />
                      ) : (
                        <Film size={32} />
                      )}
                      <span className="thumb-play">
                        <Play size={22} fill="currentColor" />
                      </span>
                      <span className="duration">
                        {clock(p.metadata.duration)}
                      </span>
                    </button>
                    <div className="project-info">
                      <button onClick={() => openEditor(p.id)}>
                        <h3>{p.name}</h3>
                      </button>
                      <p>
                        {p.metadata.width
                          ? `${p.metadata.width} × ${p.metadata.height} · ${size(p.metadata.size)}`
                          : "در حال آماده‌سازی ویدیوی منبع"}
                      </p>
                      <div className="card-footer">
                        <span
                          className={
                            "badge " + (p.status === "ready" ? "success" : "")
                          }
                        >
                          {statusLabel(p.status)}
                        </span>
                        <button
                          className="icon-button"
                          aria-label={`حذف ${p.name}`}
                          onClick={() => {
                            if (
                              confirm("این پروژه و همه رسانه‌هایش حذف شوند؟")
                            )
                              action(
                                () => api(`/projects/${p.id}`, json("DELETE")),
                                "پروژه حذف شد.",
                              );
                          }}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        )}
        {page === "editor" && (
          <Editor
            id={selected}
            jobs={jobs}
            clips={clips}
            autoSubtitleLimitMinutes={
              settings?.elevenlabs.max_duration_minutes ?? 6
            }
            onError={setError}
            toast={toast}
            onClip={showClip}
            onQueue={() => setPage("queue")}
          />
        )}
        {page === "queue" && (
          <div className="page">
            <div className="page-heading compact">
              <div>
                <span className="eyebrow">کارها را پیش ببرید</span>
                <h1>فعالیت‌ها</h1>
                <p>
                  دانلودها، زیرنویس‌های خودکار، پیش‌نمایش‌ها، رندرها و ارسال‌های
                  Telegram.
                </p>
              </div>
              <span className="pill">هر بار یک رندر</span>
            </div>
            {!jobs.length ? (
              <div className="empty">
                <ListVideo size={40} />
                <h3>هنوز چیزی در صف نیست</h3>
                <p>کارهای پس‌زمینه شما اینجا نمایش داده می‌شوند.</p>
              </div>
            ) : (
              <div className="job-list">
                {jobs.map((j) => (
                  <div className="job-card" key={j.id}>
                    <div className="job-icon">
                      {j.status === "running" ? (
                        <LoaderCircle className="spin" size={22} />
                      ) : j.status === "completed" ? (
                        <Check size={22} />
                      ) : j.kind === "download" ? (
                        <Download size={22} />
                      ) : j.kind === "autosubtitle" ? (
                        <Sparkles size={22} />
                      ) : (
                        <Film size={22} />
                      )}
                    </div>
                    <div className="job-body">
                      <div className="job-title">
                        <strong>
                          {
                            {
                              download: "دانلود",
                              ingest: "بررسی ویدیو",
                              render: "رندر کلیپ",
                              cover: "کاور Telegram",
                              autosubtitle: "زیرنویس خودکار",
                              telegram: "ارسال به Telegram",
                            }[j.kind]
                          }
                        </strong>
                        <span
                          className={
                            "badge " +
                            (j.status === "completed"
                              ? "success"
                              : j.status === "failed"
                                ? "danger"
                                : "")
                          }
                        >
                          {statusLabel(j.status)}
                        </span>
                      </div>
                      <button
                        className="text-link"
                        onClick={() => openEditor(j.project_id)}
                      >
                        {projects.find((p) => p.id === j.project_id)?.name ||
                          "پروژه"}
                      </button>
                      {j.status === "running" && (
                        <>
                          <div className="meter">
                            <i style={{ width: `${j.progress}%` }} />
                          </div>
                          <small>
                            {j.progress.toFixed(0)}% · {clock(j.elapsed)}{" "}
                            سپری‌شده{" "}
                            {j.eta !== null
                              ? `· حدود ${clock(j.eta)} باقی‌مانده`
                              : ""}
                            {j.speed > 0
                              ? ` · ${size(j.bytes)} · ${size(j.speed)}/s`
                              : ""}
                          </small>
                        </>
                      )}
                      {j.error && <p className="job-error">{j.error}</p>}
                    </div>
                    <div className="job-actions">
                      {["queued", "running"].includes(j.status) && (
                        <button
                          className="secondary"
                          onClick={() =>
                            action(() =>
                              api(`/jobs/${j.id}/cancel`, json("POST")),
                            )
                          }
                        >
                          لغو
                        </button>
                      )}
                      {["failed", "cancelled", "interrupted"].includes(
                        j.status,
                      ) && (
                        <button
                          className="secondary"
                          onClick={() => {
                            if (
                              j.kind === "telegram" &&
                              j.status === "interrupted" &&
                              !confirm(
                                "این ارسال ممکن است قبلاً انجام شده باشد. تکرار می‌کنید و خطر ارسال تکراری را می‌پذیرید؟",
                              )
                            )
                              return;
                            action(
                              () => api(`/jobs/${j.id}/retry`, json("POST")),
                              "کار دوباره در صف قرار گرفت.",
                            );
                          }}
                        >
                          تلاش دوباره
                        </button>
                      )}
                      {j.result_id && j.kind === "render" && (
                        <button
                          className="secondary"
                          onClick={() => {
                            const c = clips.find((c) => c.id === j.result_id);
                            if (c) showClip(c);
                          }}
                        >
                          مشاهده کلیپ <ArrowUpRight size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {page === "clips" && (
          <div className="page">
            <div className="page-heading compact">
              <div>
                <span className="eyebrow">آماده برای دیده‌شدن</span>
                <h1>کلیپ‌های رندرشده</h1>
                <p>خروجی‌های نهایی و پیش‌نمایش‌های کوتاه، همه در یک جا.</p>
              </div>
              <span className="pill">{clips.length} کلیپ</span>
            </div>
            {!clips.length ? (
              <div className="empty">
                <Film size={40} />
                <h3>کلیپ‌های آماده شما جایشان همین‌جاست</h3>
                <p>یک پروژه را باز کنید و لحظه انتخابی‌تان را رندر کنید.</p>
              </div>
            ) : (
              <div className="project-grid">
                {clips.map((c) => (
                  <article className="project-card" key={c.id}>
                    <button
                      className="project-thumb"
                      onClick={() => showClip(c)}
                    >
                      {c.has_cover ? (
                        <img
                          src={`/api/media/clip/${c.id}/cover?v=${c.metadata.cover?.revision}`}
                          alt="کاور ویدیو"
                        />
                      ) : (
                        <video
                          src={`/api/media/clip/${c.id}#t=0.1`}
                          preload="metadata"
                          muted
                        />
                      )}
                      <span className="thumb-play">
                        <Play size={22} fill="currentColor" />
                      </span>
                      <span className="duration">
                        {clock(c.metadata.duration)}
                      </span>
                      {c.preview && (
                        <span className="preview-tag">پیش‌نمایش</span>
                      )}
                    </button>
                    <div className="project-info">
                      <h3>{c.name}</h3>
                      <p>
                        {c.metadata.width} × {c.metadata.height} ·{" "}
                        {size(c.metadata.size)}
                      </p>
                      <div className="card-footer">
                        <a
                          className="text-link"
                          href={`/api/media/clip/${c.id}?download=true`}
                        >
                          <Download size={14} /> دانلود
                        </a>
                        <button
                          className="icon-button"
                          aria-label="ارسال به Telegram"
                          onClick={() => openSend(c)}
                        >
                          <Send size={16} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label="حذف کلیپ"
                          onClick={() => {
                            if (confirm("این کلیپ رندرشده حذف شود؟"))
                              action(
                                () => api(`/clips/${c.id}`, json("DELETE")),
                                "کلیپ حذف شد.",
                              );
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        )}
        {page === "post" && (
          <TelegramPostPage
            clips={clips}
            clip={
              postClip
                ? (clips.find((item) => item.id === postClip.id) ?? postClip)
                : null
            }
            onSelectClip={setPostClip}
            settings={settings}
            jobs={jobs}
            onSettings={() => setPage("settings")}
            onQueue={() => setPage("queue")}
            onBackToClips={() => setPage("clips")}
            refresh={refresh}
            toast={toast}
            onError={setError}
          />
        )}
        {page === "settings" && (
          <SettingsPage
            onSettings={setSettings}
            onError={setError}
            toast={toast}
          />
        )}
        <footer className="footer">
          ساخته‌شده برای لحظه‌هایی که ارزش نگه‌داشتن دارند.
          <span>VideoEdit · استودیوی کلیپ</span>
        </footer>
      </main>
      {(error || notice) && (
        <div role="alert" className={"toast " + (error ? "error" : "")}>
          <span>{error || notice}</span>
          <button
            aria-label="بستن"
            onClick={() => {
              setError("");
              setNotice("");
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {importOpen && (
        <div
          className="modal-shade"
          onClick={() => {
            if (!busy) setImportOpen(false);
          }}
        >
          <section className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <span className="eyebrow">بیایید چیزی بسازیم</span>
                <h2>افزودن ویدیو</h2>
              </div>
              <button
                className="icon-button"
                disabled={busy}
                aria-label="بستن"
                onClick={() => setImportOpen(false)}
              >
                <X />
              </button>
            </div>
            <div className="tabs">
              <button
                className={tab === "url" ? "active" : ""}
                onClick={() => setTab("url")}
              >
                <Link size={15} /> لینک ویدیو
              </button>
              <button
                className={tab === "upload" ? "active" : ""}
                onClick={() => setTab("upload")}
              >
                <Upload size={15} /> بارگذاری فایل
              </button>
            </div>
            {tab === "url" ? (
              <form onSubmit={importURL}>
                <label>
                  نشانی مستقیم ویدیو
                  <Textarea
                    required
                    placeholder="https://example.com/video.mp4?token=…"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </label>
                <p className="hint">
                  از یک لینک مستقیم به فایل MP4، MKV یا WebM استفاده کنید.
                  لینک‌های امضاشده همه پارامترهای کوئری خود را حفظ می‌کنند.
                </p>
                <label>
                  نام پروژه <span className="muted">(اختیاری)</span>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="لحظه‌ای که ارزش نگه‌داشتن دارد"
                    maxLength={120}
                  />
                </label>
                <DownloadProxyFields
                  enabled={useProxy}
                  onEnabled={setUseProxy}
                  config={proxy}
                  onChange={setProxy}
                  busy={busy || proxyBusy}
                  onSave={() => changeProxy()}
                  onRemove={() => changeProxy(true)}
                />
                <button className="primary wide" disabled={busy || proxyBusy}>
                  {busy ? (
                    <LoaderCircle className="spin" size={18} />
                  ) : (
                    <Download size={18} />
                  )}{" "}
                  {busy ? "در حال افزودن…" : "دانلود و ساخت پروژه"}
                </button>
              </form>
            ) : (
              <label
                className="dropzone"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (!busy && e.dataTransfer.files[0])
                    upload(e.dataTransfer.files[0]);
                }}
              >
                <Upload size={30} />
                <strong>
                  {busy
                    ? `در حال بارگذاری · ${progress.toFixed(0)}%`
                    : "ویدیوی خود را اینجا رها کنید"}
                </strong>
                <span>
                  {busy
                    ? "این پنجره را باز نگه دارید"
                    : "یا برای انتخاب فایل کلیک کنید"}
                </span>
                <small>
                  MP4، MKV، WebM · محدود به فضای ذخیره‌سازی در دسترس
                </small>
                <input
                  type="file"
                  accept="video/*,.mkv"
                  disabled={busy}
                  onChange={(e) => {
                    if (e.target.files?.[0]) upload(e.target.files[0]);
                  }}
                />
                {busy && (
                  <div className="meter">
                    <i style={{ width: `${progress}%` }} />
                  </div>
                )}
              </label>
            )}
          </section>
        </div>
      )}
      {openClip && (
        <div className="modal-shade" onClick={() => setOpenClip(null)}>
          <section
            className="modal clip-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">
                  {openClip.preview
                    ? "پیش‌نمایش رندر واقعی"
                    : "کلیپ آماده شما"}
                </span>
                <h2>{openClip.name}</h2>
              </div>
              <button
                className="icon-button"
                aria-label="بستن کلیپ"
                onClick={() => setOpenClip(null)}
              >
                <X />
              </button>
            </div>
            <video
              className="result-video"
              src={`/api/media/clip/${openClip.id}`}
              poster={
                openClip.has_cover
                  ? `/api/media/clip/${openClip.id}/cover?v=${openClip.metadata.cover?.revision}`
                  : undefined
              }
              controls
              autoPlay
            />
            <div className="result-meta">
              <span dir="ltr">
                {clock(openClip.metadata.duration)} · {openClip.metadata.width}{" "}
                × {openClip.metadata.height} · {size(openClip.metadata.size)}
              </span>
              <a
                className="primary"
                href={`/api/media/clip/${openClip.id}?download=true`}
              >
                <Download size={16} /> دانلود MP4
              </a>
            </div>
            <div className="send-panel">
              <h3>
                <Send size={17} /> ارسال به Telegram
              </h3>
              {!settings?.telegram_status.connected ? (
                <p>
                  برای ارسال کلیپ‌ها، ربات Telegram خود را در{" "}
                  <button
                    className="text-link"
                    onClick={() => {
                      setOpenClip(null);
                      setPage("settings");
                    }}
                  >
                    تنظیمات
                  </button>{" "}
                  متصل کنید.
                </p>
              ) : !settings.telegram.channels.length ? (
                <p>
                  یک کانال در{" "}
                  <button
                    className="text-link"
                    onClick={() => {
                      setOpenClip(null);
                      setPage("settings");
                    }}
                  >
                    تنظیمات
                  </button>{" "}
                  اضافه کنید و مطمئن شوید ربات در آنجا مدیر است.
                </p>
              ) : (
                <>
                  <p>
                    کاور، کپشن و کانال مقصد را در صفحه ارسال پست تنظیم کنید و
                    سپس ارسال را نهایی کنید.
                  </p>
                  <div className="telegram-entry-actions">
                    <button
                      className="primary"
                      onClick={() => openSend(openClip)}
                    >
                      <Send size={16} /> رفتن به صفحه ارسال پست
                    </button>
                    <span className="hint">
                      {settings.telegram.channels.length} کانال متصل است.
                    </span>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("admin"),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="login-screen">
      <div className="login-decoration">
        <div className="login-frame">
          <Scissors size={52} />
        </div>
        <span className="eyebrow">استودیوی خصوصی کلیپ شما</span>
        <h1>
          داستان‌های خوب.
          <br />
          کلیپ‌های کوچک عالی<span className="accent">.</span>
        </h1>
        <p>
          لحظه را پیدا کنید. داستان را بسازید. چیزی ارزش دیدن را به اشتراک
          بگذارید.
        </p>
      </div>
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("/login", json("POST", { username, password }));
            onLogin();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="brand">
          <span className="brand-mark">
            <Scissors size={21} />
          </span>
          videoedit.
        </div>
        <h2>به فضای کاری خود خوش آمدید</h2>
        <p>برای شروع ساخت، وارد شوید.</p>
        <label>
          نام کاربری
          <Input
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label>
          گذرواژه
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <button className="primary wide" disabled={busy}>
          {busy ? (
            <LoaderCircle className="spin" size={18} />
          ) : (
            <>
              ورود <ArrowUpRight size={18} />
            </>
          )}
        </button>
        <small className="muted">
          رسانه‌ها و ویرایش‌های شما در فضای کاری خصوصی‌تان باقی می‌مانند.
        </small>
      </form>
    </div>
  );
}
