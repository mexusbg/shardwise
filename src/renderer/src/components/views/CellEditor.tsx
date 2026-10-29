import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Modal, openModal } from '../Modal'
import { Icon } from '../Icon'

function TextValueDialog({ title, initial, close }: { title: string; initial: string; close: (v: string | null) => void }): ReactElement {
  const [text, setText] = useState(initial)
  const lines = text ? text.split('\n').length : 0
  return (
    <Modal
      title={`Edit Value — ${title}`}
      icon="edit"
      width={760}
      onClose={() => close(null)}
      footer={
        <>
          <span className="faint grow" style={{ fontSize: 12 }}>
            {text.length.toLocaleString()} characters · {lines.toLocaleString()} {lines === 1 ? 'line' : 'lines'} · Ctrl+Enter saves
          </span>
          <button className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => close(text)}>
            Save
          </button>
        </>
      }
    >
      <textarea
        className="input mono text-value-edit"
        autoFocus
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            close(text)
          }
        }}
      />
    </Modal>
  )
}

/** A string value in a large multi-line text box; null when cancelled. */
export function editTextValue(title: string, initial: string): Promise<string | null> {
  return openModal<string | null>((close) => <TextValueDialog title={title} initial={initial} close={close} />)
}

/**
 * Inline editor of a table or tree cell. Strings get a button (and Shift+Enter) that opens them in a large text box;
 * multi-line strings open there directly, since a one-line input would drop their line breaks.
 */
export function CellEditor({ initial, path, text: isText, onDone }: { initial: string; path: string; text: boolean; onDone: (text: string | null) => void }): ReactElement {
  const [v, setV] = useState(initial)
  const done = useRef(false)
  const expanding = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const multiline = isText && /[\r\n]/.test(initial)
  const finish = (text: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(text)
  }
  const expand = async (from: string): Promise<void> => {
    expanding.current = true
    const r = await editTextValue(path, from)
    expanding.current = false
    if (r !== null || multiline) finish(r)
    else input.current?.focus()
  }

  useEffect(() => {
    if (multiline) void expand(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (multiline) return <span className="faint">Editing…</span>
  return (
    <span className="cell-edit-wrap">
      <input
        ref={input}
        className="cell-edit"
        autoFocus
        value={v}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && e.shiftKey && isText) {
            e.preventDefault()
            void expand(v)
          } else if (e.key === 'Enter') finish(v)
          else if (e.key === 'Escape') finish(null)
        }}
        onBlur={() => {
          if (!expanding.current) finish(v)
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      />
      {isText && (
        <button
          className="cell-edit-more"
          title="Edit in a larger text box (Shift+Enter)"
          tabIndex={-1}
          // Keeps the focus in the input, so opening the text box does not first save the value.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            void expand(v)
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Icon name="more" size={12} />
        </button>
      )}
    </span>
  )
}
