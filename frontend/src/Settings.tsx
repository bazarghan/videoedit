import { useEffect, useState } from "react";
import {
  Send,
  ShieldCheck,
  HardDrive,
  LoaderCircle,
  Trash2,
  Check,
  KeyRound,
} from "lucide-react";
import { api, json, size, Settings } from "./types";
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
  return (
    <div className="page settings-page">
      <div className="page-heading compact">
        <div>
          <span className="eyebrow">A WORKSPACE THAT WORKS FOR YOU</span>
          <h1>Settings</h1>
          <p>Connect your account and manage your media storage.</p>
        </div>
      </div>
      <div className="settings-grid">
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
                <input
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
                <input
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
              <input
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
              . Your API hash and authorized session are encrypted in persistent
              storage.
            </p>
            {connected && (
              <label>
                Default destination
                <select
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                >
                  {destinations.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
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
                    After saving your settings, request a login code to connect.
                  </p>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const r = await api("/telegram/connect", json("POST"));
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
                    <input
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
                      {step === "password" ? "Unlock account" : "Verify code"}
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
              <input
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
                ["sources", "previews", "renders", "assets"].includes(name),
              )
              .map(([name, bytes]) => (
                <div key={name}>
                  <span>
                    <strong>
                      {
                        {
                          sources: "Original videos",
                          previews: "Browser previews",
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
                                : "Remove all browser previews? You can regenerate them in the editor.",
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
            Cleanup is available when all active jobs finish. Delete a project
            to remove its originals, assets, subtitles, previews and exports
            together.
          </p>
        </section>
      </div>
    </div>
  );
}
