import { Decoration, EditorView } from '@codemirror/view'

/**
 * Keeps every source line aware of its direction without inserting
 * direction-control characters into the saved Telegram HTML.
 */
export function sourceDirection(direction) {
  const lineDirection = Decoration.line({ attributes: { dir: direction } })
  return [
    EditorView.editorAttributes.of({ dir: direction === 'auto' ? 'ltr' : direction }),
    EditorView.perLineTextDirection.of(true),
    // CodeMirror may render the selection's line outside visibleRanges.
    // Cover every line so a distant caret uses the same direction rules.
    EditorView.decorations.compute(['doc'], (state) => {
      const ranges = []
      for (let pos = 0; pos <= state.doc.length;) {
        ranges.push(lineDirection.range(pos))
        pos = state.doc.lineAt(pos).to + 1
      }
      return Decoration.set(ranges)
    }),
  ]
}
