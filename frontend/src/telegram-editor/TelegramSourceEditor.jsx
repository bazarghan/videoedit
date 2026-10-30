import { useLayoutEffect, useRef, useState } from 'react'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExtension,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bidiIsolates, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { html } from '@codemirror/lang-html'
import { tags } from '@lezer/highlight'
import { sourceDirection } from './telegramEditorExtensions'

const highlighting = HighlightStyle.define([
  { tag: tags.tagName, class: 'tg-src-tag' },
  { tag: tags.attributeName, class: 'tg-src-attribute' },
  { tag: tags.attributeValue, class: 'tg-src-string' },
  { tag: tags.comment, class: 'tg-src-comment' },
  { tag: tags.angleBracket, class: 'tg-src-punctuation' },
])

/**
 * CodeMirror surface used inside <TelegramEditor />.
 *
 * It is deliberately uncontrolled: the CodeMirror document is the source of
 * truth while typing, and the `value` prop is only written back when it differs.
 */
export function TelegramSourceEditor({
  editorRef,
  value,
  direction = 'auto',
  maxLength,
  onChange,
  onSelectionChange,
  placeholder = 'Write your message…',
  label,
  describedBy,
  invalid,
  autoFocus = false,
}) {
  const hostRef = useRef(null)
  const fallbackRef = useRef(null)
  const activeEditorRef = editorRef ?? fallbackRef
  const [initialValue] = useState(value ?? '')
  const [configuration] = useState(() => new Compartment())

  // Keep the latest callbacks/limit without recreating the editor instance.
  const onChangeRef = useRef(onChange)
  const onSelectionChangeRef = useRef(onSelectionChange)
  const maxLengthRef = useRef(maxLength)
  onChangeRef.current = onChange
  onSelectionChangeRef.current = onSelectionChange
  maxLengthRef.current = maxLength

  useLayoutEffect(() => {
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          html({ autoCloseTags: false, matchClosingTags: false }),
          syntaxHighlighting(highlighting),
          bidiIsolates({ alwaysIsolate: true }),
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          configuration.of([]),
          EditorState.transactionFilter.of((transaction) => {
            // Reject a whole insertion rather than silently cutting HTML or an IME commit.
            // An existing oversized draft can still be shortened.
            if (!transaction.docChanged) return transaction
            const before = transaction.startState.doc.length
            const after = transaction.newDoc.length
            const limit = maxLengthRef.current
            return limit == null || after <= limit || after < before ? transaction : []
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current?.(update.state.doc.toString())
            if (update.docChanged || update.selectionSet) onSelectionChangeRef.current?.()
          }),
        ],
      }),
    })
    activeEditorRef.current = view
    if (autoFocus) view.focus()
    return () => {
      activeEditorRef.current = null
      view.destroy()
    }
  }, [activeEditorRef, initialValue, configuration])

  useLayoutEffect(() => {
    const view = activeEditorRef.current
    if (!view) return
    view.dispatch({
      effects: configuration.reconfigure([
        sourceDirection(direction),
        EditorView.contentAttributes.of({
          'aria-label': label || '',
          'aria-describedby': describedBy || '',
          'aria-invalid': String(!!invalid),
          'aria-multiline': 'true',
          spellcheck: 'false',
          autocapitalize: 'off',
          autocorrect: 'off',
        }),
        placeholderExtension(placeholder || ''),
      ]),
    })
  }, [activeEditorRef, configuration, direction, label, describedBy, invalid, placeholder])

  useLayoutEffect(() => {
    const view = activeEditorRef.current
    if (!view) return
    const next = value ?? ''
    if (view.state.doc.toString() !== next) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        annotations: Transaction.addToHistory.of(false),
        filter: false,
      })
    }
  }, [activeEditorRef, value])

  return <div ref={hostRef} className="tg-source-editor" dir="ltr" />
}
