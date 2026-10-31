import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TelegramEditor } from './TelegramEditor'
import { FORMAT_HTML } from './telegramFormatting'

/**
 * Modal shell around <TelegramEditor />.
 *
 * It keeps a draft while open; Apply commits the draft through `onChange`,
 * while Cancel, Escape, the X button and the backdrop discard it.
 */
export function TelegramEditorModal({
  open,
  onClose,
  value,
  onChange,
  format = FORMAT_HTML,
  onFormatChange,
  title = 'ویرایشگر پیام',
  ...props
}) {
  const [draft, setDraft] = useState(value ?? '')
  const [draftFormat, setDraftFormat] = useState(format)
  const wasOpen = useRef(false)
  const previousFocus = useRef(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (open && !wasOpen.current) {
      setDraft(value ?? '')
      setDraftFormat(format)
      previousFocus.current = document.activeElement
    }
    wasOpen.current = open
  }, [open, value, format])

  useEffect(() => {
    if (!open) return undefined

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      // An open formatting panel handles Escape itself.
      if (document.querySelector('.tg-pop-panel')) return
      onCloseRef.current?.(false)
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      const target = previousFocus.current
      if (target && typeof target.focus === 'function') target.focus()
    }
  }, [open])

  if (!open || typeof document === 'undefined') return null

  const close = () => onClose?.(false)

  return createPortal(
    <div
      className="tg-modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className="tg-modal-panel" role="dialog" aria-modal="true" aria-label={title}>
        <TelegramEditor
          {...props}
          title={title}
          value={draft}
          onChange={setDraft}
          format={draftFormat}
          onFormatChange={setDraftFormat}
          autoFocus
          onCancel={close}
          onApply={() => {
            onChange?.(draft)
            onFormatChange?.(draftFormat)
            close()
          }}
        />
      </div>
    </div>,
    document.body,
  )
}
