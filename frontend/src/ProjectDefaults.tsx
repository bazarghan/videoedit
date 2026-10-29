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
      onError("The watermark end must follow its start.");
      return;
    }
    if (watermark.kind === "image" && !watermark.asset_id && !imageFile) {
      onError("Choose a default watermark image.");
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
      toast("Project defaults saved. New imports will use these settings.");
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
      toast("Built-in project defaults restored for new imports.");
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
          <h2>Project defaults</h2>
          <p>Your preferred subtitles and watermark, ready for every import.</p>
        </div>
      </div>
      <p className="hint defaults-intro">
        Saved defaults apply to newly imported videos. Existing projects keep
        their own settings. You can also save defaults from the editor’s
        Captions and Mark tabs.
      </p>
      <div className="defaults-tabs" role="tablist" aria-label="Project defaults">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "subtitles"}
          className={tab === "subtitles" ? "active" : ""}
          onClick={() => setTab("subtitles")}
        >
          Subtitles
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "watermark"}
          className={tab === "watermark" ? "active" : ""}
          onClick={() => setTab("watermark")}
        >
          Watermark
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
              <h3>Subtitles</h3>
              <Check
                checked={subtitles.burn}
                onChange={(value) => subtitle("burn", value)}
              >
                Add captions to exports
              </Check>
              <SelectField
                label="Font family"
                value={subtitles.font}
                options={fonts}
                onChange={(value) => subtitle("font", value)}
              />
              <Check
                checked={subtitles.bold}
                onChange={(value) => subtitle("bold", value)}
              >
                Bold
              </Check>
              <NumberField
                label="Font size (px)"
                value={subtitles.size}
                min={12}
                max={160}
                onChange={(value) => subtitle("size", value)}
              />
              <div className="form-row">
                <ColorField
                  label="Text color"
                  value={subtitles.color}
                  onChange={(value) => subtitle("color", value)}
                />
                <ColorField
                  label="Outline color"
                  value={subtitles.outline_color}
                  onChange={(value) => subtitle("outline_color", value)}
                />
              </div>
              <div className="form-row">
                <NumberField
                  label="Outline"
                  value={subtitles.outline}
                  min={0}
                  max={12}
                  step={0.1}
                  onChange={(value) => subtitle("outline", value)}
                />
                <NumberField
                  label="Shadow"
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
                Background box
              </Check>
              {subtitles.box && (
                <NumberField
                  label="Box opacity (0–1)"
                  value={subtitles.box_opacity}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(value) => subtitle("box_opacity", value)}
                />
              )}
              <div className="form-row">
                <SelectField
                  label="Position"
                  value={subtitles.position}
                  options={["bottom", "middle", "top"]}
                  onChange={(value) => subtitle("position", value)}
                />
                <SelectField
                  label="Alignment"
                  value={subtitles.align}
                  options={["left", "center", "right"]}
                  onChange={(value) => subtitle("align", value)}
                />
              </div>
              <div className="form-row">
                <NumberField
                  label="Margin (px)"
                  value={subtitles.margin}
                  min={0}
                  max={400}
                  onChange={(value) => subtitle("margin", value)}
                />
                <NumberField
                  label="Timing offset (s)"
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
                Preserve original ASS styling
              </Check>
              <Check
                checked={subtitles.soft}
                onChange={(value) => subtitle("soft", value)}
              >
                Use the video's original soft subtitles
              </Check>
              <div className="control-divider" />
              <h3>Persian subtitles</h3>
              <SelectField
                label="Persian font family"
                value={subtitles.fa_font}
                options={fonts}
                onChange={(value) => subtitle("fa_font", value)}
              />
              <Check
                checked={subtitles.fa_bold}
                onChange={(value) => subtitle("fa_bold", value)}
              >
                Bold Persian text
              </Check>
              <NumberField
                label="Persian font size (px)"
                value={subtitles.fa_size}
                min={12}
                max={160}
                onChange={(value) => subtitle("fa_size", value)}
              />
              <div className="form-row">
                <ColorField
                  label="Persian color"
                  value={subtitles.fa_color}
                  onChange={(value) => subtitle("fa_color", value)}
                />
                <ColorField
                  label="Persian outline color"
                  value={subtitles.fa_outline_color}
                  onChange={(value) => subtitle("fa_outline_color", value)}
                />
              </div>
              <div className="form-row">
                <NumberField
                  label="Persian outline"
                  value={subtitles.fa_outline}
                  min={0}
                  max={12}
                  step={0.1}
                  onChange={(value) => subtitle("fa_outline", value)}
                />
                <NumberField
                  label="Gap above Persian (px)"
                  value={subtitles.gap}
                  min={0}
                  max={200}
                  step={0.5}
                  onChange={(value) => subtitle("gap", value)}
                />
              </div>
              <p className="hint">
                Defaults match Viditor: English in white Arial above, Persian
                in yellow IRAN Yekan ExtraBold below. Embedded source soft
                subtitles are ignored unless this option is on.
              </p>
            </div>
            <div hidden={tab !== "watermark"}>
              <h3>Watermark</h3>
              <SelectField
                label="Watermark type"
                value={watermark.kind}
                options={[
                  ["none", "No watermark"],
                  ["text", "Text"],
                  ["image", "Image"],
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
                        Watermark text
                        <Input
                          className="h-9 text-xs"
                          value={watermark.text}
                          maxLength={300}
                          placeholder="@yourname"
                          onChange={(e) => mark("text", e.target.value)}
                        />
                      </label>
                      <SelectField
                        label="Font family"
                        value={watermark.font}
                        options={fonts}
                        onChange={(value) => mark("font", value)}
                      />
                      <NumberField
                        label="Text size (px)"
                        value={watermark.size}
                        min={12}
                        max={200}
                        onChange={(value) => mark("size", value)}
                      />
                      <ColorField
                        label="Text color"
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
                        <Stamp size={16} /> Use multi-element template
                      </button>
                    </>
                  )}
                </>
              )}
              {watermark.kind === "image" && (
                <>
                  <label>
                    {watermark.asset_id
                      ? "Replace saved image (PNG or JPEG)"
                      : "Default image (PNG or JPEG)"}
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
                    The saved image is copied into each new project, so it stays
                    available if another project is deleted.
                  </p>
                  <NumberField
                    label="Image width (fraction of frame)"
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
                      label="Opacity (0–1)"
                      value={watermark.opacity}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(value) => mark("opacity", value)}
                    />
                  )}
                  <label>
                    Corner preset
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
                        <SelectValue placeholder="Choose a corner…" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tl">Top left</SelectItem>
                        <SelectItem value="tr">Top right</SelectItem>
                        <SelectItem value="bl">Bottom left</SelectItem>
                        <SelectItem value="br">Bottom right</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <div className="form-row">
                    <NumberField
                      label="Horizontal position (0–1)"
                      value={watermark.x}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(value) => mark("x", value)}
                    />
                    <NumberField
                      label="Vertical position (0–1)"
                      value={watermark.y}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(value) => mark("y", value)}
                    />
                  </div>
                  <NumberField
                    label="Margin (px)"
                    value={watermark.margin}
                    min={0}
                    max={400}
                    onChange={(value) => mark("margin", value)}
                  />
                  <div className="form-row">
                    <NumberField
                      label="Visible from (s)"
                      value={watermark.start}
                      min={0}
                      step={0.1}
                      onChange={(value) => mark("start", value)}
                    />
                    <label>
                      Until (s)
                      <Input
                        className="h-9 text-xs"
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={watermark.end ?? ""}
                        placeholder="End of clip"
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
                    Times are relative to the clip start. Leave Until blank to
                    show the watermark through the end of the clip.
                  </p>
                </>
              )}
            </div>
          </div>
          <p className="hint">
            Sizes and margins use a 1080-pixel reference height and scale with
            the video output.
          </p>
          <div className="form-actions">
            <button className="primary" type="submit">
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Save size={16} />
              )}{" "}
              Save project defaults
            </button>
            <button
              className="text-link"
              type="button"
              onClick={() => void reset()}
            >
              Reset to built-in defaults
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
