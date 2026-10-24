import { useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { api } from '../../lib/api'
import { Icon } from '../Icon'
import './ai.css'

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; info: string; code: string; closed: boolean }

const FENCE = /^\s*```\s*(.*)$/
const ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/

/** Paragraphs, headings, quotes, bullet / numbered lists and fenced code. Unclosed fences (while streaming) run to the end. */
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let para: string[] = []
  const endPara = (): void => {
    if (para.length) out.push({ kind: 'p', text: para.join(' ') })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = FENCE.exec(line)
    if (fence) {
      endPara()
      const body: string[] = []
      let closed = false
      for (i++; i < lines.length; i++) {
        if (/^\s*```\s*$/.test(lines[i])) {
          closed = true
          break
        }
        body.push(lines[i])
      }
      out.push({ kind: 'code', info: fence[1].trim(), code: body.join('\n'), closed })
      continue
    }
    if (!line.trim()) {
      endPara()
      continue
    }
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line)
    if (h) {
      endPara()
      out.push({ kind: 'h', text: h[1] })
      continue
    }
    const q = /^\s*>\s?(.*)$/.exec(line)
    if (q) {
      endPara()
      const prev = out[out.length - 1]
      if (prev?.kind === 'quote') prev.text += ` ${q[1]}`
      else out.push({ kind: 'quote', text: q[1] })
      continue
    }
    const item = ITEM.exec(line)
    if (item) {
      endPara()
      const ordered = /\d/.test(item[1])
      const prev = out[out.length - 1]
      if (prev?.kind === 'list' && prev.ordered === ordered) prev.items.push(item[2])
      else out.push({ kind: 'list', ordered, items: [item[2]] })
      continue
    }
    const prev = out[out.length - 1]
    // Indented continuation of a list item.
    if (!para.length && prev?.kind === 'list' && /^\s{2,}\S/.test(line)) {
      prev.items[prev.items.length - 1] += ` ${line.trim()}`
      continue
    }
    para.push(line.trim())
  }
  endPara()
  return out
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(\*[^*\s][^*\n]*\*)/g

export function Inline({ text }: { text: string }): ReactElement {
  const parts: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  INLINE.lastIndex = 0
  while ((m = INLINE.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const t = m[0]
    const k = parts.length
    if (m[1]) parts.push(<code key={k}>{t.slice(1, -1)}</code>)
    else if (m[2]) parts.push(<b key={k}>{t.slice(2, -2)}</b>)
    else if (m[3]) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!
      parts.push(
        <a key={k} href={lm[2]} target="_blank" rel="noreferrer">
          {lm[1]}
        </a>
      )
    } else parts.push(<i key={k}>{t.slice(1, -1)}</i>)
    last = m.index + t.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }): ReactElement {
  const [done, setDone] = useState(false)
  return (
    <button
      className="btn ghost small"
      title="Copy to the clipboard"
      onClick={() =>
        void api.copyText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }
    >
      <Icon name={done ? 'check' : 'copy'} size={12} /> {done ? 'Copied' : label}
    </button>
  )
}

export function CodeBlock({ info, code, actions }: { info: string; code: string; actions?: ReactNode }): ReactElement {
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{info || 'code'}</span>
        <span className="spacer" />
        {actions}
        <CopyButton text={code} />
      </div>
      <pre className="selectable">{code}</pre>
    </div>
  )
}

export interface MarkdownProps {
  text: string
  /** Custom rendering for fenced blocks; return undefined for the default. */
  renderCode?: (info: string, code: string, closed: boolean) => ReactNode | undefined
}

export function Markdown({ text, renderCode }: MarkdownProps): ReactElement {
  const blocks = parseBlocks(text)
  return (
    <div className="md selectable">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'p':
            return (
              <p key={i}>
                <Inline text={b.text} />
              </p>
            )
          case 'h':
            return (
              <p key={i} className="md-h">
                <Inline text={b.text} />
              </p>
            )
          case 'quote':
            return (
              <blockquote key={i}>
                <Inline text={b.text} />
              </blockquote>
            )
          case 'list': {
            const items = b.items.map((it, j) => (
              <li key={j}>
                <Inline text={it} />
              </li>
            ))
            return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>
          }
          case 'code':
            return <div key={i}>{renderCode?.(b.info, b.code, b.closed) ?? <CodeBlock info={b.info} code={b.code} />}</div>
        }
      })}
    </div>
  )
}
