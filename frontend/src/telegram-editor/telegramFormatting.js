// Telegram Bot API HTML: https://core.telegram.org/bots/api#html-style
// Telegram Rich Message HTML: https://core.telegram.org/bots/api#rich-html-style
// Extracted from the HLNetwork editor. No variables or test-send logic included.

export const FORMAT_HTML = 'html'
export const FORMAT_RICH = 'rich'
export const HTML_TEXT_LIMIT = 4096
export const RICH_TEXT_LIMIT = 32768

export const escapeTelegramHtml = (value) => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#x27;')

export const isTelegramLink = (value) => {
  try {
    const url = new URL(value)
    return ['https:', 'http:', 'tg:', 'mailto:', 'tel:'].includes(url.protocol)
  } catch {
    return false
  }
}

const ANCHOR_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/
const LIST_TYPES = new Set(['1', 'a', 'A', 'i', 'I'])

const lines = (value) => String(value ?? '').split('\n').filter((line) => line.trim() !== '')

const anchorName = (value) => {
  const name = String(value ?? '').trim()
  if (!ANCHOR_NAME.test(name)) {
    throw new Error('Use an anchor name that starts with a letter and contains letters, digits, - or _.')
  }
  return name
}

const checkListType = (value) => {
  const type = String(value ?? '').trim()
  if (type && !LIST_TYPES.has(type)) throw new Error('List type must be one of 1, a, A, i, I.')
  return type
}

const buildList = (selectedText, checkedBoxes = false) => {
  const items = lines(selectedText)
  if (!items.length) throw new Error('Select the list lines first, one item per line.')
  const rendered = items.map((raw) => {
    let text = raw.trim()
    let checked = ''
    if (checkedBoxes) {
      const match = text.match(/^\[(x|X| )?\]\s*(.*)$/)
      checked = match && match[1] && match[1] !== ' ' ? ' checked' : ''
      text = match ? match[2] : text
    }
    return `<li>${checkedBoxes ? `<input type="checkbox"${checked}>` : ''}${text}</li>`
  })
  return rendered.join('\n')
}

const buildTable = (values, selectedText) => {
  const rows = lines(selectedText)
  if (!rows.length) throw new Error('Select the table rows first, one row per line using | between cells.')
  const parsed = rows.map((row) => row.split('|').map((cell) => cell.trim()))
  if (parsed.some((cells) => cells.length < 2)) {
    throw new Error('Each table row needs at least two cells separated by |.')
  }
  if (Math.max(...parsed.map((cells) => cells.length)) > 20) {
    throw new Error('Rich tables support up to 20 columns.')
  }
  const align = String(values.align ?? '')
  const valign = String(values.valign ?? '')
  if (align && !['left', 'center', 'right'].includes(align)) {
    throw new Error('Choose a supported horizontal alignment.')
  }
  if (valign && !['top', 'middle', 'bottom'].includes(valign)) {
    throw new Error('Choose a supported vertical alignment.')
  }
  const positiveInteger = (name, label) => {
    const raw = String(values[name] ?? '').trim()
    if (!raw) return 1
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) {
      throw new Error(`${label} must be a positive whole number.`)
    }
    return Number(raw)
  }
  const colspan = positiveInteger('colspan', 'Columns to merge')
  const rowspan = positiveInteger('rowspan', 'Rows to merge')
  const mergeRow = positiveInteger('mergeRow', 'Merge starting row') - 1
  const mergeColumn = positiveInteger('mergeColumn', 'Merge starting column') - 1
  const merging = colspan > 1 || rowspan > 1
  if (merging && (mergeRow + rowspan > parsed.length
      || parsed.slice(mergeRow, mergeRow + rowspan).some((cells) => mergeColumn + colspan > cells.length))) {
    throw new Error('The merged cell must fit within the selected table rows and columns.')
  }
  const sharedAttrs = `${align ? ` align="${align}"` : ''}${valign ? ` valign="${valign}"` : ''}`
  const flags = ['bordered', 'striped', 'compact'].filter((flag) => values[flag]).join(' ')
  const caption = String(values.caption ?? '').trim()
  const body = parsed.map((cells, index) => {
    const tag = index === 0 ? 'th' : 'td'
    const rendered = cells.map((cell, column) => {
      const inMerge = merging && index >= mergeRow && index < mergeRow + rowspan
        && column >= mergeColumn && column < mergeColumn + colspan
      const origin = index === mergeRow && column === mergeColumn
      if (inMerge && !origin) return ''
      const spanAttrs = merging && origin
        ? `${colspan > 1 ? ` colspan="${colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}` : ''
      const contents = inMerge
        ? parsed.slice(mergeRow, mergeRow + rowspan).flatMap((row) => row.slice(mergeColumn, mergeColumn + colspan)).join('<br/>')
        : cell
      return `<${tag}${sharedAttrs}${spanAttrs}>${contents}</${tag}>`
    }).join('')
    return `<tr>${rendered}</tr>`
  }).join('\n')
  return `<table${flags ? ` ${flags}` : ''}>${caption ? `<caption>${escapeTelegramHtml(caption)}</caption>\n` : ''}${body}</table>`
}

export const RICH_FORMAT_TYPES = new Set([
  'heading', 'paragraph', 'footer', 'divider', 'ul', 'ol', 'checklist', 'table',
  'details', 'mark', 'sup', 'sub', 'anchor', 'reference', 'referenceLink',
  'math', 'mathBlock',
])

export const buildTelegramFormat = (type, values, selectedText = '', textFormat = FORMAT_HTML) => {
  const escaped = escapeTelegramHtml
  if (textFormat !== FORMAT_RICH && RICH_FORMAT_TYPES.has(type)) {
    throw new Error('Switch the editor to Rich Message to use this tool.')
  }
  switch (type) {
    case 'link':
      if (!isTelegramLink(values.url)) {
        throw new Error('Enter a valid https://, http://, tg://, mailto: or tel: link.')
      }
      return { open: `<a href="${escaped(values.url)}">`, close: '</a>', text: escaped(values.text) }
    case 'mention':
      if (!/^[1-9]\d*$/.test(values.userId)) throw new Error('Enter a numeric Telegram user ID.')
      return { open: `<a href="tg://user?id=${values.userId}">`, close: '</a>', text: escaped(values.text) }
    case 'pre': {
      const language = values.language.trim()
      if (language && !/^[a-zA-Z0-9_+#.-]+$/.test(language)) {
        throw new Error('Enter a language name such as python, javascript or c++.')
      }
      return {
        open: language ? `<pre><code class="language-${escaped(language)}">` : '<pre>',
        close: language ? '</code></pre>' : '</pre>',
        text: escaped(selectedText),
      }
    }
    case 'emoji': {
      if (!/^[1-9]\d*$/.test(values.emojiId)) throw new Error('Enter a numeric custom emoji ID.')
      const segments = [...new Intl.Segmenter().segment(values.text)]
      if (segments.length !== 1 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(values.text)) {
        throw new Error('Enter one fallback emoji, such as 👍.')
      }
      return { open: `<tg-emoji emoji-id="${values.emojiId}">`, close: '</tg-emoji>', text: escaped(values.text) }
    }
    case 'time': {
      const unix = Number(values.unix)
      if (!/^\d+$/.test(values.unix) || !Number.isSafeInteger(unix) || unix > Math.floor(Date.now() / 1000) + 1098 * 86400) {
        throw new Error('Enter a Unix timestamp between 0 and three years from now.')
      }
      if (!/^(?:r|w?[dD]?[tT]?)$/.test(values.format)) {
        throw new Error('Use a Telegram time format such as wDT, t, r, or leave it empty.')
      }
      return {
        open: `<tg-time unix="${unix}"${values.format ? ` format="${escaped(values.format)}"` : ''}>`,
        close: '</tg-time>',
        text: escaped(values.text),
      }
    }
    case 'heading': {
      const level = Number(values.level)
      if (!Number.isInteger(level) || level < 1 || level > 6) throw new Error('Choose a heading level from 1 to 6.')
      return { open: `<h${level}>`, close: `</h${level}>`, text: selectedText }
    }
    case 'paragraph':
      return { open: '<p>', close: '</p>', text: selectedText }
    case 'footer':
      return { open: '<footer>', close: '</footer>', text: selectedText }
    case 'divider':
      return { open: '<hr/>\n', close: '', text: '' }
    case 'mark':
      return { open: '<mark>', close: '</mark>', text: selectedText }
    case 'sup':
      return { open: '<sup>', close: '</sup>', text: selectedText }
    case 'sub':
      return { open: '<sub>', close: '</sub>', text: selectedText }
    case 'ul':
      return { open: '<ul>\n', close: '\n</ul>', text: buildList(selectedText) }
    case 'checklist':
      return { open: '<ul>\n', close: '\n</ul>', text: buildList(selectedText, true) }
    case 'ol': {
      const start = String(values.start ?? '').trim()
      const listType = checkListType(values.numbering)
      if (start && (!/^-?\d+$/.test(start) || !Number.isSafeInteger(Number(start)))) {
        throw new Error('Ordered list start must be a whole number.')
      }
      const attrs = `${start ? ` start="${escaped(start)}"` : ''}${listType ? ` type="${listType}"` : ''}${values.reversed ? ' reversed' : ''}`
      return { open: `<ol${attrs}>\n`, close: '\n</ol>', text: buildList(selectedText) }
    }
    case 'table':
      return { open: '', close: '', text: buildTable(values, selectedText) }
    case 'details': {
      const summary = String(values.summary ?? '').trim()
      if (!summary) throw new Error('Enter a summary line for the collapsible section.')
      return {
        open: `<details${values.open ? ' open' : ''}><summary>${escaped(summary)}</summary>\n`,
        close: '\n</details>',
        text: selectedText,
      }
    }
    case 'anchor':
      return { open: `<a name="${anchorName(values.name)}"></a>`, close: '', text: '' }
    case 'reference':
      return { open: `<tg-reference name="${anchorName(values.name)}">`, close: '</tg-reference>', text: selectedText }
    case 'referenceLink':
      return { open: `<a href="#${anchorName(values.name)}">`, close: '</a>', text: selectedText }
    case 'math':
      return {
        open: '<tg-math>',
        close: '</tg-math>',
        text: escaped(values.source || selectedText).replaceAll('{', '&#123;').replaceAll('}', '&#125;'),
      }
    case 'mathBlock':
      return {
        open: '<tg-math-block>',
        close: '</tg-math-block>',
        text: escaped(values.source || selectedText).replaceAll('{', '&#123;').replaceAll('}', '&#125;'),
      }
    default:
      throw new Error('Unsupported Telegram format.')
  }
}
