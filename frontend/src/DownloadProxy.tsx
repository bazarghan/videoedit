import { Shield, Trash2 } from "lucide-react";
import { DownloadProxyDraft } from "./types";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";

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
      <Label className="check proxy-toggle">
        <Checkbox
          checked={enabled}
          onCheckedChange={(value) => onEnabled(value === true)}
        />
        <Shield size={16} /> استفاده از پروکسی SOCKS5
        <span className="muted">اختیاری</span>
      </Label>
      {enabled ? (
        <>
          <div className="form-row proxy-address">
            <label>
              میزبان پروکسی
              <Input
                className="h-9 text-xs"
                required
                value={config.host}
                placeholder="proxy.example.com"
                autoComplete="off"
                maxLength={253}
                onChange={(e) => update({ host: e.target.value })}
              />
            </label>
            <label>
              پورت
              <Input
                className="h-9 text-xs"
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
              نام کاربری پروکسی <span className="muted">(اختیاری)</span>
              <Input
                className="h-9 text-xs"
                value={config.username}
                autoComplete="off"
                maxLength={255}
                onChange={(e) => update({ username: e.target.value })}
              />
            </label>
            <label>
              رمز عبور پروکسی <span className="muted">(اختیاری)</span>
              <Input
                className="h-9 text-xs"
                type="password"
                value={config.password}
                autoComplete="new-password"
                maxLength={255}
                placeholder={
                  config.password_saved ? "رمز ذخیره‌شده" : "بدون احراز هویت"
                }
                onChange={(e) =>
                  update({ password: e.target.value, clear_password: false })
                }
              />
            </label>
          </div>
          {config.password_saved && (
            <Label className="check">
              <Checkbox
                checked={config.clear_password}
                onCheckedChange={(value) =>
                  update({
                    clear_password: value === true,
                    password: "",
                  })
                }
              />
              <span>پاک کردن رمز ذخیره‌شده</span>
            </Label>
          )}
          <p className="hint">
            اطلاعات ورود رمزنگاری می‌شود. برای حفظ رمز در همان اتصال، آن را خالی
            بگذارید. با تغییر میزبان، پورت یا نام کاربری، رمز پاک می‌شود.
            تنظیمات پروکسی هنگام شروع دانلود ذخیره می‌شود.
          </p>
          <div className="proxy-actions">
            <button
              type="button"
              className="secondary"
              disabled={!config.host.trim() || !config.port}
              onClick={onSave}
            >
              ذخیره پروکسی
            </button>
            <button type="button" className="text-link" onClick={onRemove}>
              <Trash2 size={14} /> حذف پروکسی ذخیره‌شده
            </button>
          </div>
        </>
      ) : (
        <p className="hint">
          این دانلود مستقیم متصل می‌شود. برای وارد کردن یا استفادهٔ مجدد از
          پروکسی، آن را فعال کنید.
        </p>
      )}
    </fieldset>
  );
}
