import { useState } from "react";
import { LoaderCircle, Save, SlidersHorizontal, Stamp } from "lucide-react";
import { api, fonts, json, ProjectDefaults } from "./types";
import WatermarkTemplateEditor from "./WatermarkTemplate";
import { templateFromLegacy } from "./watermark";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";

type Props = {
  initial: ProjectDefaults;
  onSaved: (defaults: ProjectDefaults) => void;
  onError: (message: string) => void;
  toast: (message: string) => void;
};

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      {label}
      <Input
        className="h-9 text-xs"
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        required
        onChange={(e) => onChange(e.target.valueAsNumber)}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[] | [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-9 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => {
            const [optionValue, title] =
              typeof option === "string" ? [option, option] : option;
            return (
              <SelectItem key={optionValue} value={optionValue}>
                {title}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </label>
  );
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Label className="check text-[11px] font-normal text-[#b7bfcd]">
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <span>{children}</span>
    </Label>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export default function ProjectDefaultsPanel({
  initial,
  onSaved,
  onError,
  toast,
}: Props) {
  const [draft, setDraft] = useState(initial);
  const [tab, setTab] = useState<"subtitles" | "watermark">("subtitles");
  const [busy, setBusy] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [uploadKey, setUploadKey] = useState(0);
  const subtitles = draft.subtitles;
  const watermark = draft.watermark;
  function subtitle<K extends keyof ProjectDefaults["subtitles"]>(
    key: K,
    value: ProjectDefaults["subtitles"][K],
  ) {
    setDraft((old) => ({
      ...old,
      subtitles: { ...old.subtitles, [key]: value },
    }));
  }
  function mark<K extends keyof ProjectDefaults["watermark"]>(
    key: K,
    value: ProjectDefaults["watermark"][K],
  ) {
    setDraft((old) => ({
      ...old,
      watermark: { ...old.watermark, [key]: value },
    }));
  }
  async function save() {
    if (watermark.end !== null && watermark.end <= watermark.start) {
      onError("پایان واترمارک باید بعد از شروع آن باشد.");
      return;
    }
    if (watermark.kind === "image" && !watermark.asset_id && !imageFile) {
      onError("یک تصویر واترمارک پیش‌فرض انتخاب کنید.");
      return;
    }
    setBusy(true);
    try {
      let saved: ProjectDefaults;
      if (imageFile && watermark.kind === "image") {
        const form = new FormData();
        form.append("file", imageFile);
        form.append("defaults", JSON.stringify(draft));
        saved = await api<ProjectDefaults>(
          "/settings/project-defaults/watermark",
          { method: "POST", body: form },
        );
        setImageFile(null);
        setUploadKey((old) => old + 1);
      } else {
        saved = await api<ProjectDefaults>(
          "/settings/project-defaults",
          json("PUT", draft),
        );
      }
      setDraft(saved);
      onSaved(saved);
      toast("پیش‌فرض‌های پروژه ذخیره شد. واردکردن‌های جدید از این تنظیمات استفاده می‌کنند.");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    setBusy(true);
    try {
      const saved = await api<ProjectDefaults>(
        "/settings/project-defaults",
        json("DELETE"),
      );
      setDraft(saved);
      setImageFile(null);
      setUploadKey((old) => old + 1);
      onSaved(saved);
      toast("پیش‌فرض‌های داخلی پروژه برای واردکردن‌های جدید بازگردانده شد.");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel project-defaults">
      <div className="panel-heading">
        <div className="panel-icon">
          <SlidersHorizontal size={22} />
        </div>
        <div>
          <h2>پیش‌فرض‌های پروژه</h2>
          <p>زیرنویس و واترمارک دلخواه شما، آماده برای هر بار واردکردن.</p>
        </div>
      </div>
      <p className="hint defaults-intro">
        پیش‌فرض‌های ذخیره‌شده برای ویدیوهای تازه واردشده اعمال می‌شوند.
        پروژه‌های موجود تنظیمات خودشان را حفظ می‌کنند. می‌توانید پیش‌فرض‌ها را
        از تب‌های Captions و Mark در ویرایشگر هم ذخیره کنید.
      </p>
      <div className="defaults-tabs" role="tablist" aria-label="پیش‌فرض‌های پروژه">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "subtitles"}
          className={tab === "subtitles" ? "active" : ""}
          onClick={() => setTab("subtitles")}
        >
          زیرنویس
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "watermark"}
          className={tab === "watermark" ? "active" : ""}
          onClick={() => setTab("watermark")}
        >
          واترمارک
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy} className="defaults-fields">
          <div className="defaults-columns">
            <div hidden={tab !== "subtitles"}>
              <h3>زیرنویس</h3>
              <Check
                checked={subtitles.burn}
                onChange={(value) => subtitle("burn", value)}
              >
                افزودن کپشن به خروجی‌ها
              </Check>
              <SelectField
                label="خانواده فونت"
                value={subtitles.font}
                options={fonts}
                onChange={(value) => subtitle("font", value)}
              />
              <Check
                checked={subtitles.bold}
                onChange={(value) => subtitle("bold", value)}
              >
                ضخیم
              </Check>
              <NumberField
                label="اندازه فونت (px)"
                value={subtitles.size}
                min={12}
                max={160}
                onChange={(value) => subtitle("size", value)}
              />
              <div className="form-row">
                <ColorField
                  label="رنگ متن"
                  value={subtitles.color}
                  onChange={(value) => subtitle("color", value)}
                />
                <ColorField
                  label="رنگ خط دور"
                  value={subtitles.outline_color}
                  onChange={(value) => subtitle("outline_color", value)}
                />
              </div>
              <div className="form-row">
                <NumberField
                  label="خط دور"
                  value={subtitles.outline}
                  min={0}
                  max={12}
                  step={0.1}
                  onChange={(value) => subtitle("outline", value)}
                />
                <NumberField
                  label="سایه"
                  value={subtitles.shadow}
                  min={0}
                  max={12}
                  step={0.1}
                  onChange={(value) => subtitle("shadow", value)}
                />
              </div>
              <Check
                checked={subtitles.box}
                onChange={(value) => subtitle("box", value)}
              >
                کادر پس‌زمینه
              </Check>
              {subtitles.box && (
                <NumberField
                  label="شفافیت کادر (0–1)"
                  value={subtitles.box_opacity}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(value) => subtitle("box_opacity", value)}
                />
              )}
              <div className="form-row">
                <SelectField
                  label="موقعیت"
                  value={subtitles.position}
                  options={["bottom", "middle", "top"]}
                  onChange={(value) => subtitle("position", value)}
                />
                <SelectField
                  label="ترازبندی"
                  value={subtitles.align}
                  options={["left", "center", "right"]}
                  onChange={(value) => subtitle("align", value)}
                />
              </div>
              <div className="form-row">
                <NumberField
                  label="حاشیه (px)"
                  value={subtitles.margin}
                  min={0}
                  max={400}
                  onChange={(value) => subtitle("margin", value)}
                />
                <NumberField
                  label="جابه‌جایی زمانی (s)"
                  value={subtitles.offset}
                  min={-600}
                  max={600}
                  step={0.1}
                  onChange={(value) => subtitle("offset", value)}
                />
              </div>
              <Check
                checked={subtitles.preserve_ass}
                onChange={(value) => subtitle("preserve_ass", value)}
              >
                حفظ استایل ASS اصلی
              </Check>
              <Check
                checked={subtitles.soft}
                onChange={(value) => subtitle("soft", value)}
              >
                استفاده از زیرنویس‌های نرم اصلی ویدیو
              </Check>
              <div className="control-divider" />
              <h3>زیرنویس فارسی</h3>
              <SelectField
                label="خانواده فونت فارسی"
                value={subtitles.fa_font}
                options={fonts}
                onChange={(value) => subtitle("fa_font", value)}
              />
              <Check
                checked={subtitles.fa_bold}
                onChange={(value) => subtitle("fa_bold", value)}
              >
                متن فارسی ضخیم
              </Check>
              <NumberField
                label="اندازه فونت فارسی (px)"
                value={subtitles.fa_size}
                min={12}
                max={160}
                onChange={(value) => subtitle("fa_size", value)}
              />
              <div className="form-row">
                <ColorField
                  label="رنگ فارسی"
                  value={subtitles.fa_color}
                  onChange={(value) => subtitle("fa_color", value)}
                />
                <ColorField
                  label="رنگ خط دور فارسی"
                  value={subtitles.fa_outline_color}
                  onChange={(value) => subtitle("fa_outline_color", value)}
                />
              </div>
              <div className="form-row">
                <NumberField
                  label="خط دور فارسی"
                  value={subtitles.fa_outline}
                  min={0}
                  max={12}
                  step={0.1}
                  onChange={(value) => subtitle("fa_outline", value)}
                />
                <NumberField
                  label="فاصله بالای فارسی (px)"
                  value={subtitles.gap}
                  min={0}
                  max={200}
                  step={0.5}
                  onChange={(value) => subtitle("gap", value)}
                />
              </div>
              <p className="hint">
                پیش‌فرض‌ها با Viditor هم‌خوان‌اند: انگلیسی با Arial سفید در بالا
                و فارسی با IRAN Yekan ExtraBold زرد در پایین. زیرنویس‌های نرم
                تعبیه‌شده در منبع نادیده گرفته می‌شوند مگر اینکه این گزینه روشن
                باشد.
              </p>
            </div>
            <div hidden={tab !== "watermark"}>
              <h3>واترمارک</h3>
              <SelectField
                label="نوع واترمارک"
                value={watermark.kind}
                options={[
                  ["none", "بدون واترمارک"],
                  ["text", "متن"],
                  ["image", "تصویر"],
                ]}
                onChange={(value) => mark("kind", value)}
              />
              {watermark.kind === "text" && (
                <>
                  {watermark.template ? (
                    <WatermarkTemplateEditor
                      template={watermark.template}
                      onChange={(template) => mark("template", template)}
                    />
                  ) : (
                    <>
                      <label>
                        متن واترمارک
                        <Input
                          className="h-9 text-xs"
                          value={watermark.text}
                          maxLength={300}
                          placeholder="@yourname"
                          onChange={(e) => mark("text", e.target.value)}
                        />
                      </label>
                      <SelectField
                        label="خانواده فونت"
                        value={watermark.font}
                        options={fonts}
                        onChange={(value) => mark("font", value)}
                      />
                      <NumberField
                        label="اندازه متن (px)"
                        value={watermark.size}
                        min={12}
                        max={200}
                        onChange={(value) => mark("size", value)}
                      />
                      <ColorField
                        label="رنگ متن"
                        value={watermark.color}
                        onChange={(value) => mark("color", value)}
                      />
                      <button
                        className="secondary"
                        type="button"
                        onClick={() =>
                          mark("template", templateFromLegacy(watermark))
                        }
                      >
                        <Stamp size={16} /> استفاده از قالب چندعنصری
                      </button>
                    </>
                  )}
                </>
              )}
              {watermark.kind === "image" && (
                <>
                  <label>
                    {watermark.asset_id
                      ? "جایگزینی تصویر ذخیره‌شده (PNG یا JPEG)"
                      : "تصویر پیش‌فرض (PNG یا JPEG)"}
                    <input
                      key={uploadKey}
                      type="file"
                      accept=".png,.jpg,.jpeg"
                      onChange={(e) =>
                        setImageFile(e.target.files?.[0] || null)
                      }
                    />
                  </label>
                  <p className="hint">
                    تصویر ذخیره‌شده در هر پروژه جدید کپی می‌شود، بنابراین حتی
                    اگر پروژه دیگری حذف شود در دسترس می‌ماند.
                  </p>
                  <NumberField
                    label="عرض تصویر (کسری از کادر)"
                    value={watermark.width}
                    min={0.02}
                    max={0.8}
                    step={0.01}
                    onChange={(value) => mark("width", value)}
                  />
                </>
              )}
              {watermark.kind !== "none" && (
                <>
                  {(!watermark.template || watermark.kind === "image") && (
                    <NumberField
                      label="شفافیت (0–1)"
                      value={watermark.opacity}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(value) => mark("opacity", value)}
                    />
                  )}
                  <label>
                    پیش‌تنظیم گوشه
                    <Select
                      value=""
                      onValueChange={(value) => {
                        const edge = watermark.template ? 0.12 : 0;
                        setDraft((old) => ({
                          ...old,
                          watermark: {
                            ...old.watermark,
                            x: value.endsWith("l") ? edge : 1 - edge,
                            y: value.startsWith("t") ? edge : 1 - edge,
                          },
                        }));
                      }}
                    >
                      <SelectTrigger className="h-9 text-xs">
                        <SelectValue placeholder="یک گوشه انتخاب کنید…" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tl">بالا چپ</SelectItem>
                        <SelectItem value="tr">بالا راست</SelectItem>
                        <SelectItem value="bl">پایین چپ</SelectItem>
                        <SelectItem value="br">پایین راست</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <div className="form-row">
                    <NumberField
                      label="موقعیت افقی (0–1)"
                      value={watermark.x}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(value) => mark("x", value)}
                    />
                    <NumberField
                      label="موقعیت عمودی (0–1)"
                      value={watermark.y}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(value) => mark("y", value)}
                    />
                  </div>
                  <NumberField
                    label="حاشیه (px)"
                    value={watermark.margin}
                    min={0}
                    max={400}
                    onChange={(value) => mark("margin", value)}
                  />
                  <div className="form-row">
                    <NumberField
                      label="نمایان از (s)"
                      value={watermark.start}
                      min={0}
                      step={0.1}
                      onChange={(value) => mark("start", value)}
                    />
                    <label>
                      تا (s)
                      <Input
                        className="h-9 text-xs"
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={watermark.end ?? ""}
                        placeholder="پایان کلیپ"
                        onChange={(e) =>
                          mark(
                            "end",
                            e.target.value === ""
                              ? null
                              : e.target.valueAsNumber,
                          )
                        }
                      />
                    </label>
                  </div>
                  <p className="hint">
                    زمان‌ها نسبت به شروع کلیپ محاسبه می‌شوند. برای نمایش
                    واترمارک تا پایان کلیپ، «تا» را خالی بگذارید.
                  </p>
                </>
              )}
            </div>
          </div>
          <p className="hint">
            اندازه‌ها و حاشیه‌ها بر اساس ارتفاع مرجع ۱۰۸۰ پیکسل محاسبه و با
            خروجی ویدیو مقیاس می‌شوند.
          </p>
          <div className="form-actions">
            <button className="primary" type="submit">
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Save size={16} />
              )}{" "}
              ذخیره پیش‌فرض‌های پروژه
            </button>
            <button
              className="text-link"
              type="button"
              onClick={() => void reset()}
            >
              بازگردانی به پیش‌فرض‌های داخلی
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
