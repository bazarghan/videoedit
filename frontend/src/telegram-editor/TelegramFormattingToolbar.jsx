import { useEffect, useId, useRef, useState } from "react";
import {
  Anchor,
  ArrowLeft,
  AtSign,
  Bold,
  BookMarked,
  CalendarClock,
  ChevronsUpDown,
  Code2,
  Ellipsis,
  EyeOff,
  FileCode,
  Heading2,
  Highlighter,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Pilcrow,
  Plus,
  Quote,
  SeparatorHorizontal,
  Sigma,
  Sparkles,
  Strikethrough,
  Subscript,
  Superscript,
  Table2,
  Underline,
} from "lucide-react";
import { buildTelegramFormat, FORMAT_RICH } from "./telegramFormatting";

const baseFormats = [
  { title: "ضخیم", icon: Bold, open: "<b>", close: "</b>" },
  { title: "مورب", icon: Italic, open: "<i>", close: "</i>" },
  { title: "زیرخط", icon: Underline, open: "<u>", close: "</u>" },
  { title: "خط‌خورده", icon: Strikethrough, open: "<s>", close: "</s>" },
  {
    title: "اسپویلر",
    icon: EyeOff,
    open: "<tg-spoiler>",
    close: "</tg-spoiler>",
  },
  { title: "کد", icon: Code2, open: "<code>", close: "</code>" },
  {
    title: "نقل‌قول",
    icon: Quote,
    open: "<blockquote>",
    close: "</blockquote>",
  },
  {
    title: "نقل‌قول جمع‌شونده",
    icon: ChevronsUpDown,
    open: "<blockquote expandable>",
    close: "</blockquote>",
  },
];

const richFormats = [
  { title: "هایلایت", icon: Highlighter, open: "<mark>", close: "</mark>" },
  { title: "بالانویس", icon: Superscript, open: "<sup>", close: "</sup>" },
  { title: "زیرنویس", icon: Subscript, open: "<sub>", close: "</sub>" },
];

const tools = [
  {
    type: "link",
    title: "درج پیوند",
    icon: Link,
    fields: [
      { key: "url", label: "URL", placeholder: "https://example.com" },
      { key: "text", label: "متن پیوند", placeholder: "" },
    ],
  },
  {
    type: "mention",
    title: "اشاره به کاربر",
    icon: AtSign,
    fields: [
      { key: "userId", label: "شناسه کاربر Telegram", placeholder: "123456789" },
      { key: "text", label: "متن اشاره", placeholder: "" },
    ],
  },
  {
    type: "pre",
    title: "بلوک کد",
    icon: FileCode,
    fields: [
      { key: "language", label: "زبان (اختیاری)", placeholder: "python" },
    ],
  },
  {
    type: "emoji",
    title: "ایموجی سفارشی",
    icon: Sparkles,
    fields: [
      {
        key: "emojiId",
        label: "شناسه ایموجی سفارشی",
        placeholder: "5368324170671202286",
      },
      { key: "text", label: "ایموجی جایگزین", placeholder: "👍" },
    ],
    help: "به یک bot واجد شرایط برای ایموجی سفارشی نیاز دارد. پیش‌نمایش، ایموجی جایگزین را نشان می‌دهد.",
  },
  {
    type: "time",
    title: "تاریخ و زمان",
    icon: CalendarClock,
    fields: [
      { key: "unix", label: "زمان یونیکس (ثانیه)", placeholder: "" },
      { key: "format", label: "قالب زمان (اختیاری)", placeholder: "wDT" },
      { key: "text", label: "متن جایگزین", placeholder: "" },
    ],
    help: "قالب‌ها: wDT = روز هفته، تاریخ و زمان؛ t = زمان؛ r = نسبی. Telegram از زبان‌بندی خواننده استفاده می‌کند.",
  },
  {
    type: "heading",
    title: "سرتیتر",
    icon: Heading2,
    richOnly: true,
    fields: [
      {
        key: "level",
        label: "سطح",
        type: "select",
        options: [
          ["1", "H1"],
          ["2", "H2"],
          ["3", "H3"],
          ["4", "H4"],
          ["5", "H5"],
          ["6", "H6"],
        ],
      },
    ],
  },
  {
    type: "paragraph",
    title: "پاراگراف",
    icon: Pilcrow,
    richOnly: true,
    fields: [],
  },
  {
    type: "footer",
    title: "پاورقی",
    icon: Pilcrow,
    richOnly: true,
    fields: [],
  },
  {
    type: "divider",
    title: "جداکننده",
    icon: SeparatorHorizontal,
    richOnly: true,
    fields: [],
  },
  {
    type: "ul",
    title: "فهرست نشانه‌دار",
    icon: List,
    richOnly: true,
    fields: [],
  },
  {
    type: "ol",
    title: "فهرست شماره‌دار",
    icon: ListOrdered,
    richOnly: true,
    fields: [
      { key: "start", label: "شروع از (اختیاری)", placeholder: "1" },
      {
        key: "numbering",
        label: "شماره‌گذاری",
        type: "select",
        options: [
          ["", "1, 2, 3"],
          ["a", "a, b, c"],
          ["A", "A, B, C"],
          ["i", "i, ii, iii"],
          ["I", "I, II, III"],
        ],
      },
      { key: "reversed", label: "شمارش معکوس", type: "checkbox" },
    ],
  },
  {
    type: "checklist",
    title: "چک‌لیست",
    icon: ListChecks,
    richOnly: true,
    fields: [],
  },
  {
    type: "table",
    title: "جدول",
    icon: Table2,
    richOnly: true,
    fields: [
      { key: "caption", label: "عنوان (اختیاری)", placeholder: "" },
      {
        key: "align",
        label: "ترازبندی افقی سلول",
        type: "select",
        options: [
          ["", "پیش‌فرض"],
          ["left", "چپ"],
          ["center", "وسط"],
          ["right", "راست"],
        ],
      },
      {
        key: "valign",
        label: "ترازبندی عمودی سلول",
        type: "select",
        options: [
          ["", "پیش‌فرض"],
          ["top", "بالا"],
          ["middle", "وسط"],
          ["bottom", "پایین"],
        ],
      },
      {
        key: "mergeRow",
        label: "ادغام از سطر (اختیاری)",
        type: "number",
        min: 1,
        step: 1,
        placeholder: "1",
        optional: true,
      },
      {
        key: "mergeColumn",
        label: "ادغام از ستون (اختیاری)",
        type: "number",
        min: 1,
        max: 20,
        step: 1,
        placeholder: "1",
        optional: true,
      },
      {
        key: "colspan",
        label: "ستون‌های ادغام (اختیاری)",
        type: "number",
        min: 1,
        max: 20,
        step: 1,
        placeholder: "1",
        optional: true,
      },
      {
        key: "rowspan",
        label: "سطرهای ادغام (اختیاری)",
        type: "number",
        min: 1,
        step: 1,
        placeholder: "1",
        optional: true,
      },
      { key: "bordered", label: "دارای حاشیه", type: "checkbox" },
      { key: "striped", label: "راه‌راه", type: "checkbox" },
      { key: "compact", label: "فشرده", type: "checkbox" },
    ],
  },
  {
    type: "details",
    title: "بخش جمع‌شونده",
    icon: ChevronsUpDown,
    richOnly: true,
    fields: [
      { key: "summary", label: "خلاصه", placeholder: "" },
      { key: "open", label: "به‌طور پیش‌فرض باز", type: "checkbox" },
    ],
  },
  {
    type: "anchor",
    title: "لنگر",
    icon: Anchor,
    richOnly: true,
    fields: [{ key: "name", label: "نام لنگر", placeholder: "chapter-1" }],
  },
  {
    type: "reference",
    title: "مرجع",
    icon: BookMarked,
    richOnly: true,
    fields: [{ key: "name", label: "نام مرجع", placeholder: "note-1" }],
  },
  {
    type: "referenceLink",
    title: "پیوند به لنگر",
    icon: Link,
    richOnly: true,
    fields: [{ key: "name", label: "نام لنگر", placeholder: "chapter-1" }],
  },
  {
    type: "math",
    title: "فرمول",
    icon: Sigma,
    richOnly: true,
    fields: [
      { key: "source", label: "منبع LaTeX", placeholder: "x^2 + y^2" },
    ],
  },
  {
    type: "mathBlock",
    title: "فرمول بلوکی",
    icon: Sigma,
    richOnly: true,
    fields: [{ key: "source", label: "منبع LaTeX", placeholder: "E = mc^2" }],
  },
];

const LIST_TOOLS = ["ul", "ol", "checklist"];

const helpFor = (item) =>
  item.help ??
  (LIST_TOOLS.includes(item.type)
    ? "هر آیتم را در یک خط وارد کنید، یا از خطوط انتخاب‌شده شروع کنید. هر خط به یک آیتم فهرست تبدیل می‌شود."
    : item.type === "table"
      ? "در هر خط یک سطر بنویسید و سلول‌ها را با | جدا کنید. اولین خط سرستون می‌شود. ترازبندی روی همهٔ سلول‌ها اعمال می‌شود."
      : item.type === "details"
        ? "متن انتخاب‌شده بدنهٔ جمع‌شونده می‌شود؛ اگر چیزی انتخاب نشده بود، آن را پس از درج بنویسید."
        : undefined);

const defaultsFor = (item) => {
  const values = {};
  for (const field of item.fields) {
    if (field.type === "select") values[field.key] = field.options[0][0];
    else if (field.type === "checkbox") values[field.key] = false;
    else values[field.key] = "";
  }
  return values;
};

/**
 * Telegram HTML formatting toolbar. It has no external UI-library dependency:
 * panels are plain absolutely-positioned elements and anchors are native buttons.
 */
export const TelegramFormattingToolbar = ({
  getSelectedText,
  onFormat,
  onRestoreSelection,
  format = "html",
  children,
  insertionError,
}) => {
  const uid = useId().replaceAll(":", "");
  const toolbarRef = useRef(null);
  const restoreRef = useRef(onRestoreSelection);
  const [group, setGroup] = useState(null);
  const [tool, setTool] = useState(null);
  const [values, setValues] = useState({});
  const [selection, setSelection] = useState("");
  const [error, setError] = useState(null);
  const [tableTab, setTableTab] = useState("create");
  const [popLeft, setPopLeft] = useState(12);
  const [popTop, setPopTop] = useState(null);
  const rich = format === FORMAT_RICH;

  restoreRef.current = onRestoreSelection;

  const focusField = (key) => {
    if (!key) return;
    requestAnimationFrame(() =>
      document.getElementById(`${uid}-${key}`)?.focus(),
    );
  };

  const closePanel = (restoreFocus = true) => {
    setGroup(null);
    setTool(null);
    setError(null);
    if (restoreFocus) restoreRef.current?.();
  };

  const openTool = (next) => {
    const selected = getSelectedText();
    setSelection(selected);
    setValues({
      ...defaultsFor(next),
      text: selected,
      source: selected,
      rows: selected,
    });
    setError(null);
    setTableTab("create");
    setTool(next);
    focusField(
      next.type === "table"
        ? "rows"
        : next.fields.find((field) => field.type !== "checkbox")?.key,
    );
  };

  const apply = (event) => {
    event.preventDefault();
    try {
      const missing = tool.fields.find(
        (field) =>
          !field.type &&
          !field.optional &&
          !["language", "format", "start", "caption", "source"].includes(
            field.key,
          ) &&
          !String(values[field.key] ?? "").trim(),
      );
      if (missing) {
        setError({
          key: missing.key,
          message: `${missing.label} را وارد کنید.`,
        });
        focusField(missing.key);
        return;
      }
      const result = buildTelegramFormat(
        tool.type,
        values,
        tool.type === "table" || LIST_TOOLS.includes(tool.type)
          ? values.rows
          : selection,
        rich ? "rich" : "html",
      );
      if (onFormat(result.open, result.close, result.text) !== false) {
        setGroup(null);
        setTool(null);
      }
    } catch (caught) {
      // Keep validation next to the relevant control, including fields on another table tab.
      const message = caught.message;
      const keys = {
        link: "url",
        mention: "userId",
        pre: "language",
        emoji: /جایگزین/.test(message) ? "text" : "emojiId",
        time: /قالب/.test(message) ? "format" : "unix",
        ol: "start",
        details: "summary",
        math: "source",
        mathBlock: "source",
      };
      let key = /خطوط فهرست/.test(message)
        ? "rows"
        : keys[tool.type] || "name";
      if (tool.type === "table") {
        key = /ستون‌های ادغام/.test(message)
          ? "colspan"
          : /سطرهای ادغام/.test(message)
            ? "rowspan"
            : /ستون شروع ادغام/.test(message)
              ? "mergeColumn"
              : /ادغام/.test(message)
                ? "mergeRow"
                : /افقی/.test(message)
                  ? "align"
                  : /عمودی/.test(message)
                    ? "valign"
                    : "rows";
        setTableTab(
          ["mergeRow", "mergeColumn", "colspan", "rowspan"].includes(key)
            ? "merge"
            : ["align", "valign"].includes(key)
              ? "style"
              : "create",
        );
      }
      setError({ key, message });
      focusField(key);
    }
  };

  const startTool = (item) => {
    if (item.fields.length > 0 || item.type === "table") {
      openTool(item);
      return;
    }
    const selected = getSelectedText();
    try {
      const result = buildTelegramFormat(
        item.type,
        defaultsFor(item),
        selected,
        rich ? "rich" : "html",
      );
      if (onFormat(result.open, result.close, result.text) !== false) {
        setGroup(null);
        setTool(null);
      }
    } catch (caught) {
      openTool(item);
      setError({
        key: LIST_TOOLS.includes(item.type) ? "rows" : "selection",
        message: caught.message,
      });
    }
  };

  const toggleGroup = (item, trigger) => {
    if (group === item.key) {
      closePanel(true);
      return;
    }
    const toolbar = toolbarRef.current;
    if (toolbar && trigger) {
      const toolbarRect = toolbar.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      const width = Math.min(360, Math.max(0, toolbarRect.width - 24));
      const wanted = triggerRect.left - toolbarRect.left;
      const left = Math.max(
        12,
        Math.min(wanted, toolbarRect.width - width - 12),
      );
      setPopLeft(left);
      setPopTop(triggerRect.bottom - toolbarRect.top + 8);
    }
    setGroup(item.key);
    setTool(null);
    setError(null);
    setTableTab("create");
    if (item.direct) {
      const next = tools.find((candidate) => candidate.type === item.direct);
      if (next) openTool(next);
    }
  };

  // One document-level listener closes the anchored panel. Escape is left to the
  // modal wrapper when no panel is open.
  useEffect(() => {
    if (!group) return;
    const onPointerDown = (event) => {
      if (toolbarRef.current?.contains(event.target)) return;
      setGroup(null);
      setTool(null);
      setError(null);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setGroup(null);
      setTool(null);
      setError(null);
      restoreRef.current?.();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [group]);

  const formatButton = ({ title, icon: Icon, open, close }) => (
    <button
      key={title}
      type="button"
      className="tg-icon-btn"
      title={title}
      aria-label={title}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onFormat(open, close)}
    >
      <Icon size={16} />
    </button>
  );

  const renderField = (field) => {
    const invalid = error?.key === field.key;
    const id = `${uid}-${field.key}`;
    const common = {
      id,
      "aria-invalid": invalid || undefined,
      "aria-describedby": invalid ? `${uid}-error` : undefined,
    };
    if (field.type === "checkbox") {
      return (
        <div key={field.key} className="tg-field tg-field--check">
          <input
            {...common}
            type="checkbox"
            className="tg-check"
            checked={!!values[field.key]}
            onChange={(event) => {
              setValues({ ...values, [field.key]: event.target.checked });
              setError(null);
            }}
          />
          <label htmlFor={id} className="tg-label">
            {field.label}
          </label>
          {invalid && (
            <p id={`${uid}-error`} role="alert" className="tg-error">
              {error.message}
            </p>
          )}
        </div>
      );
    }
    const onChange = (event) => {
      setValues({ ...values, [field.key]: event.target.value });
      setError(null);
    };
    return (
      <div key={field.key} className="tg-field">
        <label htmlFor={id} className="tg-label">
          {field.label}
        </label>
        {field.type === "select" ? (
          <select
            {...common}
            className="tg-select"
            value={values[field.key] ?? ""}
            onChange={onChange}
          >
            {field.options.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        ) : field.type === "textarea" ? (
          <textarea
            {...common}
            className="tg-textarea"
            rows={4}
            dir="auto"
            value={values[field.key] ?? ""}
            placeholder={field.placeholder}
            onChange={onChange}
          />
        ) : (
          <input
            {...common}
            className="tg-input"
            value={values[field.key] ?? ""}
            placeholder={field.placeholder}
            dir={
              ["text", "caption", "summary"].includes(field.key)
                ? "auto"
                : "ltr"
            }
            type={field.type || "text"}
            min={field.min}
            max={field.max}
            step={field.step}
            onChange={onChange}
          />
        )}
        {invalid && (
          <p id={`${uid}-error`} role="alert" className="tg-error">
            {error.message}
          </p>
        )}
      </div>
    );
  };

  const groups = [
    { key: "link", title: "پیوند", icon: Link, direct: "link" },
    ...(rich
      ? [
          {
            key: "lists",
            title: "فهرست‌ها",
            icon: List,
            types: ["ul", "ol", "checklist"],
          },
          { key: "table", title: "جدول", icon: Table2, direct: "table" },
        ]
      : []),
    {
      key: "insert",
      title: "درج",
      icon: Plus,
      types: [
        "mention",
        "pre",
        "emoji",
        "time",
        "details",
        "heading",
        "math",
        "mathBlock",
      ],
    },
    {
      key: "more",
      title: "بیشتر",
      icon: Ellipsis,
      types: [
        "paragraph",
        "footer",
        "divider",
        "anchor",
        "reference",
        "referenceLink",
      ],
      formats: [...baseFormats.slice(3), ...(rich ? richFormats : [])],
    },
  ];

  const renderForm = () => {
    const table = tool.type === "table";
    const tableFields =
      tableTab === "create"
        ? ["caption"]
        : tableTab === "style"
          ? ["align", "valign", "bordered", "striped", "compact"]
          : ["mergeRow", "mergeColumn", "colspan", "rowspan"];
    return (
      <form noValidate onSubmit={apply} className="tg-form">
        <div className="tg-form-head">
          {!groups.find((item) => item.key === group)?.direct && (
            <button
              type="button"
              className="tg-icon-btn"
              aria-label="بازگشت به ابزارها"
              title="بازگشت به ابزارها"
              onClick={() => {
                setTool(null);
                setError(null);
                requestAnimationFrame(() => {
                  document
                    .getElementById(`${uid}-panel-${group}`)
                    ?.querySelector("button")
                    ?.focus();
                });
              }}
            >
              <ArrowLeft size={16} />
            </button>
          )}
          <h3 className="tg-form-title">{tool.title}</h3>
        </div>

        {table && (
          <div
            className="tg-segment tg-segment--sm"
            role="group"
            aria-label="تنظیمات جدول"
          >
            {[
              ["create", "ایجاد"],
              ["style", "ترازبندی"],
              ["merge", "ادغام سلول‌ها"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={tableTab === value}
                onClick={() => setTableTab(value)}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="tg-form-body">
          {table &&
            tableTab === "create" &&
            renderField({
              key: "rows",
              label: "سطرهای جدول",
              type: "textarea",
              placeholder: "نام | وضعیت\nتهران | فعال",
            })}
          {LIST_TOOLS.includes(tool.type) &&
            renderField({
              key: "rows",
              label: "آیتم‌های فهرست",
              type: "textarea",
              placeholder: "هر آیتم در یک خط",
            })}
          {tool.fields
            .filter(
              (field) =>
                !table ||
                (tableFields.includes(field.key) && field.type !== "checkbox"),
            )
            .map(renderField)}
          {table && tableTab === "style" && (
            <fieldset className="tg-fieldset">
              <legend className="tg-legend">ظاهر</legend>
              {tool.fields
                .filter((field) => field.type === "checkbox")
                .map(renderField)}
            </fieldset>
          )}
          {error?.key === "selection" && (
            <p role="alert" className="tg-error">
              {error.message}
            </p>
          )}
          {table ? (
            <p className="tg-help">
              {tableTab === "create"
                ? "در هر خط یک سطر، با | بین سلول‌ها (حداکثر ۲۰ ستون). سطر اول سرستون است."
                : tableTab === "style"
                  ? "ترازبندی و سبک روی همهٔ سلول‌ها اعمال می‌شود."
                  : "سطر و ستون شروع را انتخاب کنید؛ شمارش از ۱ است. متن ادغام‌شده با شکست خط حفظ می‌شود."}
            </p>
          ) : (
            helpFor(tool) && <p className="tg-help">{helpFor(tool)}</p>
          )}
        </div>

        {insertionError && (
          <p aria-live="polite" className="tg-error">
            {insertionError}
          </p>
        )}

        <div className="tg-form-actions">
          <button
            type="button"
            className="tg-btn"
            onClick={() => closePanel(true)}
          >
            لغو
          </button>
          <button type="submit" className="tg-btn tg-btn--primary">
            درج قالب‌بندی
          </button>
        </div>
      </form>
    );
  };

  return (
    <div
      className="tg-toolbar"
      role="group"
      aria-label="قالب‌بندی Telegram"
      ref={toolbarRef}
    >
      {baseFormats.slice(0, 3).map(formatButton)}
      <span className="tg-sep" aria-hidden="true" />

      {groups.map((item) => (
        <div className="tg-pop" key={item.key}>
          <button
            type="button"
            className="tg-tool"
            aria-label={item.title}
            title={item.title}
            aria-haspopup="dialog"
            aria-expanded={group === item.key}
            onClick={(event) => toggleGroup(item, event.currentTarget)}
          >
            <item.icon size={16} />
            <span className="tg-tool-label">{item.title}</span>
          </button>

          {group === item.key && (
            <div
              className="tg-pop-panel"
              id={`${uid}-panel-${item.key}`}
              role="dialog"
              aria-label={tool?.title || item.title}
              style={{
                insetInlineStart: `${popLeft}px`,
                top: popTop == null ? undefined : `${popTop}px`,
              }}
            >
              {tool ? (
                renderForm()
              ) : (
                <div className="tg-menu">
                  <p className="tg-menu-title">{item.title}</p>
                  {item.formats?.map(({ title, icon: Icon, open, close }) => (
                    <button
                      key={title}
                      type="button"
                      className="tg-menu-item"
                      onClick={() => {
                        onFormat(open, close);
                        setGroup(null);
                      }}
                    >
                      <Icon size={16} />
                      {title}
                    </button>
                  ))}
                  {tools
                    .filter(
                      (candidate) =>
                        item.types?.includes(candidate.type) &&
                        (!candidate.richOnly || rich),
                    )
                    .map((candidate) => (
                      <button
                        key={candidate.type}
                        type="button"
                        className="tg-menu-item"
                        onClick={() => startTool(candidate)}
                      >
                        <candidate.icon size={16} />
                        {candidate.title}
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {children}
    </div>
  );
};
