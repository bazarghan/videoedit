import { useEffect, useState } from "react";
import {
  Send,
  ShieldCheck,
  HardDrive,
  LoaderCircle,
  Trash2,
  Check,
  KeyRound,
  Sparkles,
  Mic,
  Languages,
  SlidersHorizontal,
  ChevronRight,
} from "lucide-react";
import { api, json, size, Settings } from "./types";
import ProjectDefaultsPanel from "./ProjectDefaults";
import { Input } from "./components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
type Props = {
  onSettings: (s: Settings) => void;
  onError: (s: string) => void;
  toast: (s: string) => void;
};
export default function SettingsPage({ onSettings, onError, toast }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null),
    [apiId, setApiId] = useState(""),
    [hash, setHash] = useState(""),
    [phone, setPhone] = useState(""),
    [destination, setDestination] = useState("me"),
    [limit, setLimit] = useState(20),
    [aiBase, setAiBase] = useState("http://localhost:20128/v1"),
    [aiModel, setAiModel] = useState("kr/claude-sonnet-4.5"),
    [aiKey, setAiKey] = useState(""),
    [elevenModel, setElevenModel] = useState("scribe_v2"),
    [elevenMax, setElevenMax] = useState(6),
    [elevenKey, setElevenKey] = useState(""),
    [section, setSection] = useState("defaults"),
    [step, setStep] = useState("connect"),
    [code, setCode] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [destinations, setDestinations] = useState<{ id: string; name: string }[]>(
      [],
    );
  async function load() {
    const s = await api<Settings>("/settings");
    setSettings(s);
    onSettings(s);
    setApiId(String(s.telegram.api_id));
    setPhone(s.telegram.phone);
    setDestination(s.telegram.destination);
    setLimit(s.storage.limit_gb);
    setAiBase(s.ai.base_url);
    setAiModel(s.ai.model);
    setElevenModel(s.elevenlabs.model);
    setElevenMax(s.elevenlabs.max_duration_minutes);
    setStep(s.telegram_status.step || "connect");
    if (s.telegram_status.connected)
      setDestinations(await api("/telegram/destinations"));
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
        <LoaderCircle className="spin" /> Loading settings…
      </div>
    );
  const connected = settings.telegram_status.connected;
  const sections = [
    {
      id: "defaults",
      label: "Editing defaults",
      description: "Caption and watermark presets",
      icon: SlidersHorizontal,
    },
    {
      id: "subtitles",
      label: "Auto subtitles",
      description: "ElevenLabs and 9Router",
      icon: Sparkles,
      badge:
        settings.ai.api_key_saved && settings.elevenlabs.api_key_saved
          ? "Ready"
          : "",
    },
    {
      id: "telegram",
      label: "Telegram",
      description: "Account and delivery",
      icon: Send,
      badge: connected ? "Connected" : "",
    },
    {
      id: "storage",
      label: "Storage",
      description: "Space and cleanup",
      icon: HardDrive,
    },
  ];
  return (
    <div className="page settings-page">
      <div className="page-heading compact">
        <div>
          <span className="eyebrow">A WORKSPACE THAT WORKS FOR YOU</span>
          <h1>Settings</h1>
          <p>
            Choose a section to manage your defaults, subtitle services,
            Telegram, and storage.
          </p>
        </div>
      </div>
      <div className="settings-shell">
        <nav className="settings-nav" aria-label="Settings sections">
          <span className="eyebrow">WORKSPACE SETTINGS</span>
          {sections.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={
                  "settings-nav-item " + (section === item.id ? "active" : "")
                }
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => setSection(item.id)}
              >
                <span className="settings-nav-icon">
                  <Icon size={18} />
                </span>
                <span className="settings-nav-copy">
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
                {item.badge && (
                  <span className="settings-nav-badge">{item.badge}</span>
                )}
                <ChevronRight className="settings-nav-arrow" size={15} />
              </button>
            );
          })}
        </nav>
        <div className="settings-content">
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
                  <h2>Auto subtitles</h2>
                  <p>ElevenLabs transcribes; 9Router translates to Persian.</p>
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
                    ? "Ready"
                    : "Needs tokens"}
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
                      }),
                    );
                    setAiKey("");
                    setElevenKey("");
                    await load();
                    toast("Auto subtitle settings saved.");
                  });
                }}
              >
                <div className="section-heading">
                  <h3>
                    <Mic size={14} /> ElevenLabs transcription
                  </h3>
                  <span>English source</span>
                </div>
                <label>
                  ElevenLabs API token
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={elevenKey}
                    onChange={(e) => setElevenKey(e.target.value)}
                    placeholder={
                      settings.elevenlabs.api_key_saved
                        ? "Saved securely — leave blank to keep"
                        : "xi-api-key from elevenlabs.io"
                    }
                  />
                </label>
                <label>
                  Transcription model
                  <Input
                    value={elevenModel}
                    onChange={(e) => setElevenModel(e.target.value)}
                    placeholder="scribe_v2"
                  />
                </label>
                <label>
                  Maximum video length (minutes)
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
                  Videos longer than this are blocked before any ElevenLabs
                  tokens are used. The default is 6 minutes.
                </p>
                <p className="hint">
                  Use <code>scribe_v2</code> for ElevenLabs Scribe v2
                  (recommended) or <code>scribe_v1</code> for the older model.
                  The model ID is sent directly to ElevenLabs as{" "}
                  <code>model_id</code>.
                </p>
                <div className="control-divider" />
                <div className="section-heading">
                  <h3>
                    <Languages size={14} /> 9Router translation
                  </h3>
                  <span>Persian output</span>
                </div>
                <label>
                  9Router base URL
                  <Input
                    value={aiBase}
                    onChange={(e) => setAiBase(e.target.value)}
                    placeholder="http://localhost:20128/v1"
                    required
                  />
                </label>
                <label>
                  9Router API token
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={aiKey}
                    onChange={(e) => setAiKey(e.target.value)}
                    placeholder={
                      settings.ai.api_key_saved
                        ? "Saved securely — leave blank to keep"
                        : "Copy the key from the 9Router dashboard"
                    }
                  />
                </label>
                <label>
                  Translation model
                  <Input
                    value={aiModel}
                    onChange={(e) => setAiModel(e.target.value)}
                    placeholder="kr/claude-sonnet-4.5"
                    required
                  />
                </label>
                <p className="hint">
                  Both tokens are encrypted at rest and never returned to the
                  browser. The 9Router endpoint must be OpenAI-compatible (
                  <code>/chat/completions</code>). Run 9Router locally or point
                  this at your own gateway.
                </p>
                <button className="secondary" disabled={busy}>
                  {busy ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <Check size={16} />
                  )}{" "}
                  Save auto subtitle settings
                </button>
              </form>
            </section>
          </div>
          <div hidden={section !== "telegram"}>
            <section className="panel">
              <div className="panel-heading">
                <div className="panel-icon">
                  <Send size={22} />
                </div>
                <div>
                  <h2>Telegram</h2>
                  <p>Send finished clips from your own account.</p>
                </div>
                <span className={"badge " + (connected ? "success" : "")}>
                  {connected ? "Connected" : "Not connected"}
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
                        : "Account connected securely"}
                    </small>
                  </div>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await api("/telegram/disconnect", json("POST"));
                        await load();
                        toast("Telegram account disconnected.");
                      })
                    }
                  >
                    Disconnect & log out
                  </button>
                </div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    await api(
                      "/settings/telegram",
                      json("PUT", {
                        api_id: Number(apiId),
                        api_hash: hash,
                        phone,
                        destination,
                      }),
                    );
                    setHash("");
                    await load();
                    toast("Telegram settings saved.");
                  });
                }}
              >
                <div className="form-row">
                  <label>
                    API ID
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
                    API hash
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={hash}
                      onChange={(e) => setHash(e.target.value)}
                      placeholder={
                        settings.telegram.api_hash_saved
                          ? "Saved securely — leave blank to keep"
                          : "32-character API hash"
                      }
                      required={!settings.telegram.api_hash_saved}
                    />
                  </label>
                </div>
                <label>
                  Phone number
                  <Input
                    type="tel"
                    placeholder="+1 555 123 4567"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    required
                  />
                </label>
                <p className="hint">
                  Create an API application at{" "}
                  <a
                    href="https://my.telegram.org/apps"
                    target="_blank"
                    rel="noreferrer"
                  >
                    my.telegram.org
                  </a>
                  . Your API hash and authorized session are encrypted in
                  persistent storage.
                </p>
                {connected && (
                  <label>
                    Default destination
                    <Select
                      value={destination || "me"}
                      onValueChange={(value) => setDestination(value)}
                    >
                      <SelectTrigger
                        className="h-9 text-xs"
                        aria-label="Default destination"
                      >
                        <SelectValue placeholder="Choose a destination" />
                      </SelectTrigger>
                      <SelectContent>
                        {destinations.map((d) => (
                          <SelectItem key={d.id} value={d.id}>
                            {d.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                )}
                <button className="secondary" disabled={busy}>
                  Save Telegram settings
                </button>
              </form>
              {!connected && (
                <div className="login-telegram">
                  {step === "connect" ? (
                    <>
                      <p>
                        After saving your settings, request a login code to
                        connect.
                      </p>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            const r = await api(
                              "/telegram/connect",
                              json("POST"),
                            );
                            setStep(r.step || "connect");
                            if (r.connected) await load();
                            toast("Check Telegram for your login code.");
                          })
                        }
                      >
                        {busy ? (
                          <LoaderCircle className="spin" size={17} />
                        ) : (
                          <Send size={17} />
                        )}{" "}
                        Connect account
                      </button>
                    </>
                  ) : (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        run(async () => {
                          const r = await api(
                            "/telegram/verify",
                            json("POST", { code, password }),
                          );
                          setPassword("");
                          setCode("");
                          if (r.connected) {
                            await load();
                            toast("Telegram connected.");
                          } else setStep(r.step);
                        });
                      }}
                    >
                      <label>
                        {step === "password"
                          ? "Two-step verification password"
                          : "Telegram login code"}
                        <Input
                          type={step === "password" ? "password" : "text"}
                          autoComplete="off"
                          value={step === "password" ? password : code}
                          onChange={(e) =>
                            step === "password"
                              ? setPassword(e.target.value)
                              : setCode(e.target.value)
                          }
                          required
                        />
                      </label>
                      <p className="hint">
                        Login codes and two-step verification passwords are used
                        once and never saved.
                      </p>
                      <div className="form-actions">
                        <button className="primary" disabled={busy}>
                          <KeyRound size={16} />{" "}
                          {step === "password"
                            ? "Unlock account"
                            : "Verify code"}
                        </button>
                        <button
                          type="button"
                          className="text-link"
                          onClick={() => {
                            setStep("connect");
                            setCode("");
                            setPassword("");
                          }}
                        >
                          Start again
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )}
              <div className="note">
                <Check size={16} />
                <span>
                  Clips are sent only when you click Send. Connecting an account
                  never sends a message.
                </span>
              </div>
            </section>
          </div>
          <div hidden={section !== "storage"}>
            <section className="panel">
              <div className="panel-heading">
                <div className="panel-icon">
                  <HardDrive size={22} />
                </div>
                <div>
                  <h2>Storage</h2>
                  <p>Keep room for your next project.</p>
                </div>
              </div>
              <div className="storage-total">
                <strong>{size(settings.storage.used)}</strong>
                <span>of {settings.storage.limit_gb} GB workspace limit</span>
              </div>
              <div className="meter large">
                <i
                  style={{
                    width: `${Math.min(100, (settings.storage.used / (settings.storage.limit_gb * 1024 ** 3)) * 100)}%`,
                  }}
                />
              </div>
              <p className="hint">
                {size(settings.storage.free)} available on the volume. A 1 GB
                reserve is kept for safe processing.
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
                    toast("Storage limit saved.");
                  });
                }}
              >
                <label>
                  Workspace limit (GB)
                  <Input
                    type="number"
                    min={2}
                    max={10000}
                    value={limit}
                    onChange={(e) => setLimit(Number(e.target.value))}
                  />
                </label>
                <button className="secondary" disabled={busy}>
                  Save limit
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
                              sources: "Original videos",
                              thumbnails: "Project thumbnails",
                              renders: "Rendered clips",
                              assets: "Music & watermarks",
                            }[name]
                          }
                        </strong>
                        <small>{size(bytes)}</small>
                      </span>
                      {name !== "assets" && (
                        <button
                          className="icon-button"
                          aria-label={`Clean ${name}`}
                          disabled={busy}
                          onClick={() => {
                            if (
                              confirm(
                                name === "sources"
                                  ? "Remove ALL original videos? Existing exports remain, but these projects cannot be rendered again."
                                  : name === "renders"
                                    ? "Delete ALL rendered clips and rendered previews?"
                                    : "Remove all project thumbnails? Projects keep their videos and renders.",
                              )
                            )
                              run(async () => {
                                await api(
                                  `/settings/cleanup/${name}`,
                                  json("POST"),
                                );
                                await load();
                                toast("Files cleaned up.");
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
                Cleanup is available when all active jobs finish. Delete a
                project to remove its originals, assets, subtitles, thumbnails
                and exports together.
              </p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
