import { useEffect, useId, useRef, useState } from 'react'
import { EditorSelection, Transaction } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import { Check, Code2, Eye, EyeOff, FileText, X } from 'lucide-react'
import { TelegramFormattingToolbar } from './TelegramFormattingToolbar'
import { TelegramSourceEditor } from './TelegramSourceEditor'
import { TelegramPreview } from './TelegramPreview'
import {
  escapeTelegramHtml,
  FORMAT_HTML,
  FORMAT_RICH,
  HTML_TEXT_LIMIT,
  RICH_TEXT_LIMIT,
} from './telegramFormatting'

/**
 * Standalone Telegram message editor.
 *
 * Use it inline (controlled or uncontrolled) or inside <TelegramEditorModal />.
 * The `value` is Telegram HTML source; send it to the Bot API with parse_mode=HTML.
 */
export function TelegramEditor({
  value,
  onChange,
  title = 'ویرایشگر پیام',
  description,
  label,
  placeholder = 'پیام خود را بنویسید…',
  format = FORMAT_HTML,
  onFormatChange,
  richEnabled = true,
  maxLength = HTML_TEXT_LIMIT,
  previewTitle = 'Telegram Bot',
  defaultShowPreview = false,
  theme = 'auto',
  autoFocus = false,
  onApply,
  onCancel,
  applyLabel = 'اعمال',
  cancelLabel = 'لغو',
  className = '',
}) {
  const uid = useId().replaceAll(':', '')
  const editorRef = useRef(null)

  // `value` may be controlled or omitted for a self-managed draft.
  const controlled = value !== undefined
  const [internalText, setInternalText] = useState(value ?? '')
  const text = controlled ? (value ?? '') : internalText

  const [internalFormat, setInternalFormat] = useState(format)
  const [direction, setDirection] = useState('auto')
  const [showPreview, setShowPreview] = useState(defaultShowPreview)
  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  const [insertionError, setInsertionError] = useState('')

  useEffect(() => {
    if (format) setInternalFormat(format)
  }, [format])

  const textFormat = richEnabled ? internalFormat : FORMAT_HTML
  const rich = textFormat === FORMAT_RICH
  const effectiveMaxLength = rich ? RICH_TEXT_LIMIT : (maxLength ?? HTML_TEXT_LIMIT)
  const overLimit = text.length > effectiveMaxLength

  const changeText = (next) => {
    if (!controlled) setInternalText(next)
    onChange?.(next)
  }

  const changeFormat = (next) => {
    setInternalFormat(next)
    setInsertionError('')
    onFormatChange?.(next)
  }

  const captureSelection = () => {
    const view = editorRef.current
    if (!view) return
    const { head } = view.state.selection.main
    const line = view.state.doc.lineAt(head)
    setCursor({ line: line.number, col: head - line.from + 1 })
  }

  const restoreSelection = () => {
    editorRef.current?.focus()
  }

  const getSelectedText = () => {
    const view = editorRef.current
    if (!view) return ''
    const { from, to } = view.state.selection.main
    return view.state.sliceDoc(from, to)
  }

  const insertTextAtCursor = (insert, cursorOffset = 0) => {
    const view = editorRef.current
    if (!view) return false
    const { from: start, to: end } = view.state.selection.main
    const nextLength = view.state.doc.length - (end - start) + insert.length
    if (nextLength > effectiveMaxLength) {
      setInsertionError(`این فیلد حداکثر ${effectiveMaxLength} نویسه را شامل قالب‌بندی می‌پذیرد.`)
      return false
    }
    setInsertionError('')
    const position = start + insert.length + cursorOffset
    view.dispatch({
      changes: { from: start, to: end, insert },
      selection: EditorSelection.cursor(position),
      scrollIntoView: true,
      annotations: [Transaction.userEvent.of('input.format'), isolateHistory.of('full')],
    })
    view.focus()
    return true
  }

  const wrapSelection = (open, close, selectedText) => {
    let selected = selectedText ?? getSelectedText()
    if (selectedText == null && open === '<code>') selected = escapeTelegramHtml(selected)
    return insertTextAtCursor(open + selected + close, selected ? 0 : -close.length)
  }

  const handleApply = () => {
    if (overLimit) return
    onApply?.()
  }

  return (
    <div
      className={`tg-editor ${className}`.trim()}
      data-theme={theme}
      dir="ltr"
      aria-label={title}
    >
      <header className="tg-header">
        <div className="tg-header-main">
          <div className="tg-header-icon" aria-hidden="true"><FileText size={18} /></div>
          <div className="tg-header-text">
            <h2 className="tg-title">{title}</h2>
            {(description || label) && (
              <p className="tg-description" dir="auto">{description || label}</p>
            )}
          </div>
        </div>

        <div className="tg-header-actions">
          {richEnabled && (
            <div className="tg-segment" role="group" aria-label="قالب پیام">
              <button type="button" aria-pressed={!rich} onClick={() => changeFormat(FORMAT_HTML)}>
                HTML ساده
              </button>
              <button type="button" aria-pressed={rich} onClick={() => changeFormat(FORMAT_RICH)}>
                پیام غنی
              </button>
            </div>
          )}
          {onCancel && (
            <button type="button" className="tg-icon-btn" aria-label="بستن ویرایشگر" title="بستن ویرایشگر" onClick={onCancel}>
              <X size={17} />
            </button>
          )}
        </div>
      </header>

      <TelegramFormattingToolbar
        format={textFormat}
        getSelectedText={getSelectedText}
        onFormat={wrapSelection}
        onRestoreSelection={restoreSelection}
        insertionError={insertionError}
      />

      <div className="tg-viewbar">
        <div className="tg-segment" role="group" aria-label="نمای ویرایشگر">
          <button
            type="button"
            aria-pressed={!showPreview}
            onClick={() => {
              setShowPreview(false)
              requestAnimationFrame(restoreSelection)
            }}
          >
            <Code2 size={14} />
            نوشتن HTML
          </button>
          <button type="button" aria-pressed={showPreview} onClick={() => setShowPreview(true)}>
            <Eye size={14} />
            پیش‌نمایش
          </button>
        </div>

        <label className="tg-direction">
          <span>جهت متن منبع</span>
          <select
            aria-label="جهت متن منبع"
            value={direction}
            onChange={(event) => setDirection(event.target.value)}
          >
            <option value="auto">خودکار</option>
            <option value="rtl">RTL</option>
            <option value="ltr">LTR</option>
          </select>
        </label>
      </div>

      <div className={`tg-body ${showPreview ? 'tg-body--preview' : ''}`.trim()}>
        <div className="tg-source-wrap">
          <TelegramSourceEditor
            editorRef={editorRef}
            value={text}
            maxLength={effectiveMaxLength}
            direction={direction}
            placeholder={placeholder}
            label={label || title}
            describedBy={`${uid}-help ${uid}-status`}
            invalid={overLimit || !!insertionError}
            autoFocus={autoFocus}
            onChange={(next) => {
              changeText(next)
              setInsertionError('')
            }}
            onSelectionChange={captureSelection}
          />
        </div>

        {showPreview && (
          <aside className="tg-preview-pane" aria-label="پیش‌نمایش پیام">
            <TelegramPreview text={text} format={textFormat} title={previewTitle} />
          </aside>
        )}
      </div>

      <footer className="tg-footer">
        <div className="tg-status">
          <p id={`${uid}-help`} className="tg-help">
            منبع HTML · برجسته‌سازی نحو · قالب‌بندی تگ‌های Telegram را درج می‌کند
          </p>
          <p id={`${uid}-status`} className={overLimit ? 'tg-over' : undefined}>
            {rich
              ? `${text.length} / ${RICH_TEXT_LIMIT} نویسه`
              : `${text.length} / ${effectiveMaxLength} نویسه`}
            <span className="tg-cursor">
              {' '}· سطر {cursor.line}، ستون {cursor.col} · {text.split('\n').length} خط
            </span>
          </p>
        </div>

        {(insertionError || overLimit) && (
          <p role="alert" className="tg-alert">
            {insertionError || `این پیام از محدودیت ${effectiveMaxLength} نویسه‌ای فراتر رفته است.`}
          </p>
        )}

        {(onApply || onCancel) && (
          <div className="tg-footer-actions">
            <button type="button" className="tg-btn" onClick={() => setShowPreview((current) => !current)}>
              {showPreview ? <EyeOff size={14} /> : <Eye size={14} />}
              {showPreview ? 'پنهان کردن پیش‌نمایش' : 'نمایش پیش‌نمایش'}
            </button>
            <div className="tg-footer-buttons">
              {onCancel && (
                <button type="button" className="tg-btn" onClick={onCancel}>{cancelLabel}</button>
              )}
              {onApply && (
                <button
                  type="button"
                  className="tg-btn tg-btn--primary"
                  onClick={handleApply}
                  disabled={overLimit}
                >
                  <Check size={14} />
                  {applyLabel}
                </button>
              )}
            </div>
          </div>
        )}
      </footer>
    </div>
  )
}
