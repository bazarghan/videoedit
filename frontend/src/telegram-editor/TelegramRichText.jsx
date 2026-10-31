import { Fragment, useMemo, useState } from 'react'
import { isTelegramLink } from './telegramFormatting'

const anchorId = (name) => `tg-anchor-${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}`

const Spoiler = ({ children }) => {
  const [revealed, setRevealed] = useState(false)
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={revealed ? 'پنهان کردن اسپویلر' : 'نمایش اسپویلر'}
      aria-expanded={revealed}
      className="tg-rt-spoiler"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setRevealed(!revealed)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          setRevealed(!revealed)
        }
      }}
    >
      <span style={revealed ? undefined : { filter: 'blur(5px)' }}>{children}</span>
    </span>
  )
}

const renderText = (text, key) => text.split(/((?<!\S)@[a-zA-Z0-9_]{5,}\b)/g).map((part, index) => (
  /^@[a-zA-Z0-9_]{5,}$/.test(part)
    ? (
      <a
        key={`${key}-${index}`}
        href={`https://t.me/${part.slice(1)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="tg-rt-link"
      >
        {part}
      </a>
    )
    : part
))

const MEDIA_TAGS = ['img', 'video', 'audio', 'tg-document', 'tg-map']
const BUTTON_TAGS = ['tg-button', 'tg-button-row', 'tg-thinking']

const renderNode = (node, key, ctx = {}) => {
  const { insideLink = false, skipWhitespace = false } = ctx
  if (node.nodeType === 3) {
    if (skipWhitespace && !node.textContent.trim()) return null
    return insideLink ? node.textContent : renderText(node.textContent, key)
  }
  if (node.nodeType !== 1) return null
  const tag = node.localName
  if (['script', 'style', 'iframe', 'object', 'template'].includes(tag)) return null

  const renderChildren = (options = {}) => Array.from(node.childNodes, (child, index) => (
    <Fragment key={index}>
      {renderNode(child, `${key}-${index}`, { insideLink: insideLink || tag === 'a', ...options })}
    </Fragment>
  ))

  // Only known React elements are constructed; authored attributes never reach the DOM.
  switch (tag) {
    case 'b':
    case 'strong':
      return <strong>{renderChildren()}</strong>
    case 'i':
    case 'em':
      return <em>{renderChildren()}</em>
    case 'u':
    case 'ins':
      return <u>{renderChildren()}</u>
    case 's':
    case 'strike':
    case 'del':
      return <s>{renderChildren()}</s>
    case 'mark':
      return <mark className="tg-rt-mark">{renderChildren()}</mark>
    case 'sup':
      return <sup className="tg-rt-sup">{renderChildren()}</sup>
    case 'sub':
      return <sub className="tg-rt-sub">{renderChildren()}</sub>
    case 'br':
      return <br />
    case 'tg-spoiler':
      return <Spoiler>{renderChildren()}</Spoiler>
    case 'span':
      return node.getAttribute('class') === 'tg-spoiler'
        ? <Spoiler>{renderChildren()}</Spoiler>
        : <>{renderChildren()}</>
    case 'a': {
      const href = node.getAttribute('href') || ''
      const name = node.getAttribute('name')
      if (name) return <span id={anchorId(name)} />
      if (href.startsWith('#')) {
        return <a href={`#${anchorId(href.slice(1))}`} className="tg-rt-link">{renderChildren()}</a>
      }
      return isTelegramLink(href)
        ? <a href={href} target="_blank" rel="noopener noreferrer" className="tg-rt-link">{renderChildren()}</a>
        : <>{renderChildren()}</>
    }
    case 'tg-reference':
      return (
        <span id={anchorId(node.getAttribute('name'))} className="tg-rt-reference">
          {renderChildren()}
        </span>
      )
    case 'code':
      return <code className="tg-rt-code" dir="auto">{node.textContent}</code>
    case 'pre': {
      const language = node.querySelector('code')?.getAttribute('class')?.match(/^language-([a-zA-Z0-9_+#.-]+)$/)?.[1]
      return (
        <div className="tg-rt-pre-wrap">
          {language && <div className="tg-rt-lang">{language}</div>}
          <pre className="tg-rt-pre" dir="ltr"><code>{node.textContent}</code></pre>
        </div>
      )
    }
    case 'blockquote':
      return node.hasAttribute('expandable')
        ? (
          <details className="tg-rt-details">
            <summary className="tg-rt-summary">نمایش نقل‌قول</summary>
            <div>{renderChildren()}</div>
          </details>
        )
        : <blockquote className="tg-rt-quote">{renderChildren()}</blockquote>
    case 'aside':
      return <aside className="tg-rt-aside">{renderChildren()}</aside>
    case 'cite':
      return <cite className="tg-rt-cite">{renderChildren()}</cite>
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return <span className={`tg-rt-h tg-rt-${tag}`}>{renderChildren()}</span>
    case 'p':
      return <span className="tg-rt-p">{renderChildren()}</span>
    case 'footer':
      return <span className="tg-rt-footer">{renderChildren()}</span>
    case 'hr':
      return <hr className="tg-rt-hr" />
    case 'tg-math':
      return <span dir="ltr" className="tg-rt-math">{node.textContent}</span>
    case 'tg-math-block':
      return <span dir="ltr" className="tg-rt-math tg-rt-math-block">{node.textContent}</span>
    case 'details':
      return (
        <details open={node.hasAttribute('open') || undefined} className="tg-rt-details">
          {renderChildren({ skipWhitespace: true })}
        </details>
      )
    case 'summary':
      return <summary className="tg-rt-summary">{renderChildren()}</summary>
    case 'ul':
    case 'ol': {
      const numbering = {
        1: 'decimal',
        a: 'lower-alpha',
        A: 'upper-alpha',
        i: 'lower-roman',
        I: 'upper-roman',
      }
      const listStyle = tag === 'ul' ? 'disc' : numbering[node.getAttribute('type')] || 'decimal'
      const start = tag === 'ol' && node.hasAttribute('start') ? Number(node.getAttribute('start')) : Number.NaN
      const shared = {
        className: 'tg-rt-list',
        style: { listStyleType: listStyle },
      }
      return tag === 'ol'
        ? (
          <ol
            {...shared}
            start={Number.isSafeInteger(start) ? start : undefined}
            reversed={node.hasAttribute('reversed') || undefined}
          >
            {renderChildren({ skipWhitespace: true })}
          </ol>
        )
        : <ul {...shared}>{renderChildren({ skipWhitespace: true })}</ul>
    }
    case 'li': {
      const value = node.getAttribute('value')
      const props = value !== null && !Number.isNaN(Number(value)) ? { value: Number(value) } : {}
      return <li {...props} className="tg-rt-li">{renderChildren()}</li>
    }
    case 'input':
      return node.getAttribute('type') === 'checkbox'
        ? (
          <input
            type="checkbox"
            defaultChecked={node.hasAttribute('checked')}
            disabled
            readOnly
            className="tg-rt-check"
          />
        )
        : null
    case 'table': {
      const flags = ['bordered', 'striped', 'compact'].filter((flag) => node.hasAttribute(flag))
      return (
        <span className="tg-rt-table-wrap">
          <table className={`tg-rt-table ${flags.includes('bordered') ? 'tg-rt-table--bordered' : ''}`}>
            {renderChildren({ skipWhitespace: true })}
          </table>
        </span>
      )
    }
    case 'caption':
      return <caption className="tg-rt-caption">{renderChildren()}</caption>
    case 'tbody':
    case 'thead':
    case 'tfoot': {
      const Section = tag
      return <Section>{renderChildren({ skipWhitespace: true })}</Section>
    }
    case 'tr': {
      const striped = node.closest('table')?.hasAttribute('striped')
      return <tr className={striped ? 'tg-rt-row--striped' : undefined}>{renderChildren({ skipWhitespace: true })}</tr>
    }
    case 'th':
    case 'td': {
      const Cell = tag
      const value = (name) => node.getAttribute(name)
      const numeric = (name) => {
        const number = Number(value(name))
        return Number.isInteger(number) && number > 1 ? number : undefined
      }
      return (
        <Cell
          colSpan={numeric('colspan')}
          rowSpan={numeric('rowspan')}
          style={{ textAlign: value('align') || undefined, verticalAlign: value('valign') || undefined }}
          className={`tg-rt-cell ${tag === 'th' ? 'tg-rt-th' : ''}`}
        >
          {renderChildren()}
        </Cell>
      )
    }
    case 'figure':
    case 'tg-collage':
    case 'tg-slideshow':
      return <span className="tg-rt-block tg-rt-unsupported">{renderChildren()}</span>
    case 'figcaption':
      return <span className="tg-rt-figcaption">{renderChildren()}</span>
    case 'tg-emoji':
      return (
        <span title={`ایموجی سفارشی ${node.getAttribute('emoji-id') || ''} (پیش‌نمایش جایگزین)`} className="tg-rt-emoji">
          {node.textContent}
        </span>
      )
    case 'tg-time':
      return (
        <span
          title={`تاریخ/زمان Telegram: ${node.getAttribute('unix') || ''}؛ قالب: ${node.getAttribute('format') || 'جایگزین'}`}
          className="tg-rt-time"
        >
          {node.textContent}
        </span>
      )
    default:
      if (MEDIA_TAGS.includes(tag)) return <span className="tg-rt-unsupported">رسانه در پیش‌نمایش پشتیبانی نمی‌شود</span>
      if (BUTTON_TAGS.includes(tag)) {
        return <span className="tg-rt-unsupported">{renderChildren()} · دکمه در پیش‌نمایش پشتیبانی نمی‌شود</span>
      }
      return <>{renderChildren()}</>
  }
}

/**
 * Approximate Telegram renderer used by the preview pane.
 * It creates only known React elements and never injects authored HTML.
 */
export function TelegramRichText({ text, format = 'html' }) {
  const nodes = useMemo(() => {
    if (typeof document === 'undefined') return []
    const template = document.createElement('template')
    template.innerHTML = text || ''
    return Array.from(template.content.childNodes)
  }, [text])

  return (
    <div
      dir="auto"
      className={`tg-rt ${format === 'rich' ? 'tg-rt--rich' : 'tg-rt--html'}`}
      style={{ unicodeBidi: 'plaintext' }}
    >
      {nodes.map((node, index) => (
        <Fragment key={`${text}-${index}`}>{renderNode(node, index, { format })}</Fragment>
      ))}
    </div>
  )
}
