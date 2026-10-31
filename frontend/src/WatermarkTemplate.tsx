import { Plus, Trash2 } from "lucide-react";
import { fonts } from "./types";
import type { WatermarkTemplate, WatermarkText } from "./types";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";

type Props = {
  template: WatermarkTemplate;
  onChange: (template: WatermarkTemplate) => void;
  disabled?: boolean;
};

function newElement(): WatermarkText {
  return {
    text: "",
    font_family: "Arial",
    font_size: 60,
    bold: true,
    color: "#ffffff",
    opacity: 0.2,
    alignment: "left",
  };
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <SelectRoot value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([option, title]) => (
          <SelectItem key={option} value={option}>
            {title}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}

export default function WatermarkTemplateEditor({
  template,
  onChange,
  disabled = false,
}: Props) {
  function setRows(rows: WatermarkText[][]) {
    onChange({ ...template, rows });
  }
  function setElement(
    rowIndex: number,
    elementIndex: number,
    patch: Partial<WatermarkText>,
  ) {
    setRows(
      template.rows.map((row, r) =>
        r === rowIndex
          ? row.map((element, e) =>
              e === elementIndex ? { ...element, ...patch } : element,
            )
          : row,
      ),
    );
  }
  function addRow() {
    setRows([...template.rows, [newElement()]]);
  }
  function removeRow(rowIndex: number) {
    setRows(template.rows.filter((_, index) => index !== rowIndex));
  }
  function addElement(rowIndex: number) {
    setRows(
      template.rows.map((row, index) =>
        index === rowIndex ? [...row, newElement()] : row,
      ),
    );
  }
  function removeElement(rowIndex: number, elementIndex: number) {
    setRows(
      template.rows
        .map((row, index) =>
          index === rowIndex ? row.filter((_, e) => e !== elementIndex) : row,
        )
        .filter((row) => row.length > 0),
    );
  }
  return (
    <fieldset disabled={disabled} className="template-editor">
      <p className="hint">
        هر سطر در قاب وسط‌چین می‌شود. هر عنصر فونت، اندازه، ضخامت، رنگ و
        ترازبندی خودش را حفظ می‌کند.
      </p>
      {template.rows.map((row, rowIndex) => (
        <div className="template-row" key={rowIndex}>
          <div className="template-row-heading">
            <strong>سطر {rowIndex + 1}</strong>
            <div className="form-actions">
              <button
                className="text-link"
                type="button"
                onClick={() => addElement(rowIndex)}
              >
                <Plus size={14} /> افزودن عنصر
              </button>
              <button
                className="text-link"
                type="button"
                onClick={() => removeRow(rowIndex)}
              >
                <Trash2 size={14} /> حذف سطر
              </button>
            </div>
          </div>
          {row.map((element, elementIndex) => (
            <div className="template-element" key={elementIndex}>
              <label>
                متن
                <Input
                  className="h-9 text-xs"
                  value={element.text}
                  maxLength={300}
                  placeholder="@yourname"
                  onChange={(e) =>
                    setElement(rowIndex, elementIndex, {
                      text: e.target.value,
                    })
                  }
                />
              </label>
              <div className="form-row">
                <label>
                  فونت
                  <Select
                    value={element.font_family}
                    options={fonts}
                    onChange={(value) =>
                      setElement(rowIndex, elementIndex, {
                        font_family: value,
                      })
                    }
                  />
                </label>
                <label>
                  اندازه (px)
                  <Input
                    className="h-9 text-xs"
                    type="number"
                    value={element.font_size}
                    min={8}
                    max={400}
                    step={1}
                    required
                    onChange={(e) =>
                      setElement(rowIndex, elementIndex, {
                        font_size: e.target.valueAsNumber,
                      })
                    }
                  />
                </label>
              </div>
              <div className="form-row">
                <Label className="check">
                  <Checkbox
                    checked={element.bold}
                    onCheckedChange={(value) =>
                      setElement(rowIndex, elementIndex, {
                        bold: value === true,
                      })
                    }
                  />
                  <span>ضخیم</span>
                </Label>
                <label>
                  ترازبندی
                  <Select
                    value={element.alignment}
                    options={[
                      ["left", "چپ"],
                      ["center", "وسط"],
                      ["right", "راست"],
                    ]}
                    onChange={(value) =>
                      setElement(rowIndex, elementIndex, {
                        alignment: value as WatermarkText["alignment"],
                      })
                    }
                  />
                </label>
              </div>
              <div className="form-row">
                <label>
                  رنگ
                  <input
                    type="color"
                    value={element.color}
                    onChange={(e) =>
                      setElement(rowIndex, elementIndex, {
                        color: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  شفافیت (0–1)
                  <Input
                    className="h-9 text-xs"
                    type="number"
                    value={element.opacity}
                    min={0}
                    max={1}
                    step={0.01}
                    required
                    onChange={(e) =>
                      setElement(rowIndex, elementIndex, {
                        opacity: e.target.valueAsNumber,
                      })
                    }
                  />
                </label>
              </div>
              <button
                className="text-link"
                type="button"
                onClick={() => removeElement(rowIndex, elementIndex)}
              >
                <Trash2 size={14} /> حذف عنصر
              </button>
            </div>
          ))}
        </div>
      ))}
      <button className="secondary" type="button" onClick={addRow}>
        <Plus size={14} /> افزودن سطر
      </button>
      <div className="form-row">
        <label>
          فاصلهٔ افقی (px)
          <Input
            className="h-9 text-xs"
            type="number"
            value={template.gap_horizontal}
            min={0}
            max={600}
            step={1}
            required
            onChange={(e) =>
              onChange({
                ...template,
                gap_horizontal: e.target.valueAsNumber,
              })
            }
          />
        </label>
        <label>
          فاصلهٔ عمودی (px)
          <Input
            className="h-9 text-xs"
            type="number"
            value={template.gap_vertical}
            min={0}
            max={600}
            step={1}
            required
            onChange={(e) =>
              onChange({
                ...template,
                gap_vertical: e.target.valueAsNumber,
              })
            }
          />
        </label>
      </div>
      <div className="form-row">
        <label>
          رنگ حاشیه
          <input
            type="color"
            value={template.border_color}
            onChange={(e) =>
              onChange({ ...template, border_color: e.target.value })
            }
          />
        </label>
        <label>
          ضخامت حاشیه (px)
          <Input
            className="h-9 text-xs"
            type="number"
            value={template.border_thickness}
            min={0}
            max={20}
            step={0.1}
            required
            onChange={(e) =>
              onChange({
                ...template,
                border_thickness: e.target.valueAsNumber,
              })
            }
          />
        </label>
      </div>
      <Label className="check">
        <Checkbox
          checked={template.repeat}
          onCheckedChange={(value) =>
            onChange({ ...template, repeat: value === true })
          }
        />
        <span>نمایش مکرر نشان در طول کلیپ</span>
      </Label>
      {template.repeat && (
        <div className="form-row">
          <label>
            مدت نمایش (ثانیه)
            <Input
              className="h-9 text-xs"
              type="number"
              value={template.decay_time}
              min={0.1}
              max={120}
              step={0.1}
              required
              onChange={(e) =>
                onChange({ ...template, decay_time: e.target.valueAsNumber })
              }
            />
          </label>
          <label>
            تعداد
            <Input
              className="h-9 text-xs"
              type="number"
              value={template.replication_count}
              min={1}
              max={50}
              step={1}
              required
              onChange={(e) =>
                onChange({
                  ...template,
                  replication_count: e.target.valueAsNumber,
                })
              }
            />
          </label>
        </div>
      )}
    </fieldset>
  );
}
