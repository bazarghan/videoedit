import { Shield, Trash2 } from "lucide-react";
import { DownloadProxyDraft } from "./types";

type Props = {
  enabled: boolean;
  onEnabled: (value: boolean) => void;
  config: DownloadProxyDraft;
  onChange: (value: DownloadProxyDraft) => void;
  busy: boolean;
  onSave: () => void;
  onRemove: () => void;
};

export default function DownloadProxyFields({
  enabled,
  onEnabled,
  config,
  onChange,
  busy,
  onSave,
  onRemove,
}: Props) {
  function update(change: Partial<DownloadProxyDraft>) {
    onChange({ ...config, ...change });
  }
  return (
    <fieldset className="download-proxy" disabled={busy}>
      <label className="check proxy-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabled(e.target.checked)}
        />
        <Shield size={16} /> Use SOCKS5 proxy
        <span className="muted">Optional</span>
      </label>
      {enabled ? (
        <>
          <div className="form-row proxy-address">
            <label>
              Proxy host
              <input
                required
                value={config.host}
                placeholder="proxy.example.com"
                autoComplete="off"
                maxLength={253}
                onChange={(e) => update({ host: e.target.value })}
              />
            </label>
            <label>
              Port
              <input
                required
                type="number"
                min={1}
                max={65535}
                value={config.port || ""}
                onChange={(e) => update({ port: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              Proxy username <span className="muted">(optional)</span>
              <input
                value={config.username}
                autoComplete="off"
                maxLength={255}
                onChange={(e) => update({ username: e.target.value })}
              />
            </label>
            <label>
              Proxy password <span className="muted">(optional)</span>
              <input
                type="password"
                value={config.password}
                autoComplete="new-password"
                maxLength={255}
                placeholder={
                  config.password_saved ? "Saved password" : "No authentication"
                }
                onChange={(e) =>
                  update({ password: e.target.value, clear_password: false })
                }
              />
            </label>
          </div>
          {config.password_saved && (
            <label className="check">
              <input
                type="checkbox"
                checked={config.clear_password}
                onChange={(e) =>
                  update({ clear_password: e.target.checked, password: "" })
                }
              />{" "}
              Clear saved password
            </label>
          )}
          <p className="hint">
            Credentials are encrypted. Leave the password blank to keep it for
            the same connection. Changing the host, port or username clears it.
            Proxy settings are saved when you start a download.
          </p>
          <div className="proxy-actions">
            <button
              type="button"
              className="secondary"
              disabled={!config.host.trim() || !config.port}
              onClick={onSave}
            >
              Save proxy
            </button>
            <button type="button" className="text-link" onClick={onRemove}>
              <Trash2 size={14} /> Remove saved proxy
            </button>
          </div>
        </>
      ) : (
        <p className="hint">
          This download connects directly. Enable to enter or reuse a proxy.
        </p>
      )}
    </fieldset>
  );
}
