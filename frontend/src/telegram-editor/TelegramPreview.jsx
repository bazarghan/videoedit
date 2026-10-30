import { Bot } from 'lucide-react'
import { TelegramRichText } from './TelegramRichText'
import { FORMAT_RICH } from './telegramFormatting'

/**
 * Approximate Telegram message preview used inside the editor.
 */
export function TelegramPreview({ text, format = 'html', title = 'Telegram Bot' }) {
  return (
    <div className="tg-preview">
      <div className="tg-preview-head">
        <div className="tg-preview-avatar"><Bot size={17} /></div>
        <div>
          <p className="tg-preview-name">{title}</p>
          <p className="tg-preview-kind">
            {format === FORMAT_RICH ? 'Rich Message' : 'Regular HTML'} preview
          </p>
        </div>
      </div>

      <div className="tg-preview-scroll">
        <div className="tg-preview-bubble">
          {text
            ? <TelegramRichText text={text} format={format} />
            : <p className="tg-preview-empty">Your message preview appears here.</p>}
        </div>
      </div>

      <p className="tg-preview-note">
        Approximate preview. Telegram may render the final message slightly differently.
      </p>
    </div>
  )
}
