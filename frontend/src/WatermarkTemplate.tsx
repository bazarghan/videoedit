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
        Each row is centred in the frame. Elements keep their own font, size,
        weight, colour, and alignment.
      </p>
      {template.rows.map((row, rowIndex) => (
        <div className="template-row" key={rowIndex}>
          <div className="template-row-heading">
            <strong>Row {rowIndex + 1}</strong>
            <div className="form-actions">
              <button
                className="text-link"
                type="button"
                onClick={() => addElement(rowIndex)}
              >
                <Plus size={14} /> Add element
              </button>
              <button
                className="text-link"
                type="button"
                onClick={() => removeRow(rowIndex)}
              >
                <Trash2 size={14} /> Remove row
              </button>
            </div>
          </div>
          {row.map((element, elementIndex) => (
            <div className="template-element" key={elementIndex}>
              <label>
                Text
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
                  Font
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
                  Size (px)
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
                  <span>Bold</span>
                </Label>
                <label>
                  Alignment
                  <Select
                    value={element.alignment}
                    options={[
                      ["left", "Left"],
                      ["center", "Center"],
                      ["right", "Right"],
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
                  Colour
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
                  Opacity (0–1)
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
                <Trash2 size={14} /> Remove element
              </button>
            </div>
          ))}
        </div>
      ))}
      <button className="secondary" type="button" onClick={addRow}>
        <Plus size={14} /> Add row
      </button>
      <div className="form-row">
        <label>
          Horizontal gap (px)
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
          Vertical gap (px)
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
          Border colour
          <input
            type="color"
            value={template.border_color}
            onChange={(e) =>
              onChange({ ...template, border_color: e.target.value })
            }
          />
        </label>
        <label>
          Border thickness (px)
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
        <span>Show the mark repeatedly during the clip</span>
      </Label>
      {template.repeat && (
        <div className="form-row">
          <label>
            Visible for (s)
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
            Times
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
