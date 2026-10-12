import { useState } from "react";
import { LoaderCircle, Save, SlidersHorizontal } from "lucide-react";
import { api, fonts, json, ProjectDefaults } from "./types";

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
      <input
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
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((option) => {
          const [value, title] =
            typeof option === "string" ? [option, option] : option;
          return (
            <option key={value} value={value}>
              {title}
            </option>
          );
        })}
      </select>
    </label>
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
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy} className="defaults-fields">
          <div className="defaults-columns">
            <div>
              <h3>Subtitles</h3>
              <label className="check">
                <input
                  type="checkbox"
                  checked={subtitles.burn}
                  onChange={(e) => subtitle("burn", e.target.checked)}
                />{" "}
                Add captions to exports
              </label>
              <SelectField
                label="Font family"
                value={subtitles.font}
                options={fonts}
                onChange={(value) => subtitle("font", value)}
              />
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
              <label className="check">
                <input
                  type="checkbox"
                  checked={subtitles.box}
                  onChange={(e) => subtitle("box", e.target.checked)}
                />{" "}
                Background box
              </label>
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
              <label className="check">
                <input
                  type="checkbox"
                  checked={subtitles.preserve_ass}
                  onChange={(e) => subtitle("preserve_ass", e.target.checked)}
                />{" "}
                Preserve original ASS styling
              </label>
              <p className="hint">
                The first embedded text track is selected automatically.
                Original ASS styling overrides these style controls when
                enabled.
              </p>
            </div>
            <div>
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
                  <label>
                    Watermark text
                    <input
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
                  <NumberField
                    label="Opacity (0–1)"
                    value={watermark.opacity}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(value) => mark("opacity", value)}
                  />
                  <label>
                    Corner preset
                    <select
                      value=""
                      onChange={(e) => {
                        const value = e.target.value;
                        setDraft((old) => ({
                          ...old,
                          watermark: {
                            ...old.watermark,
                            x: value.endsWith("l") ? 0 : 1,
                            y: value.startsWith("t") ? 0 : 1,
                          },
                        }));
                      }}
                    >
                      <option value="" disabled>
                        Choose a corner…
                      </option>
                      <option value="tl">Top left</option>
                      <option value="tr">Top right</option>
                      <option value="bl">Bottom left</option>
                      <option value="br">Bottom right</option>
                    </select>
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
                      <input
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
