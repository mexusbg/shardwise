import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { create } from 'zustand'
import { Icon } from './Icon'
import { isRecording, matches } from '../lib/commands'

interface ModalEntry {
  id: number
  node: ReactNode
}

const useModals = create<{ stack: ModalEntry[] }>(() => ({ stack: [] }))
let seq = 0

/** Open a modal; resolves with the value passed to `close`. */
export function openModal<T>(render: (close: (v: T) => void) => ReactNode): Promise<T> {
  return new Promise<T>((resolve) => {
    const id = ++seq
    const close = (v: T): void => {
      useModals.setState((s) => ({ stack: s.stack.filter((m) => m.id !== id) }))
      resolve(v)
    }
    useModals.setState((s) => ({ stack: [...s.stack, { id, node: render(close) }] }))
  })
}

export function ModalHost(): ReactElement {
  const stack = useModals((s) => s.stack)
  return (
    <>
      {stack.map((m) => (
        <div key={m.id}>{m.node}</div>
      ))}
    </>
  )
}

interface ModalProps {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number | string
  height?: number | string
  icon?: string
  /** Close on Escape (default true). */
  escape?: boolean
}

export function Modal({ title, onClose, children, footer, width = 520, height, icon, escape = true }: ModalProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (escape && !isRecording() && matches(e, 'dialog.close')) {
        // Escape first closes an editor's find panel (Ctrl+F); the dialog stays open.
        if (e.target instanceof Element && e.target.closest('.cm-editor')?.querySelector('.cm-search')) return
        // Only the top-most modal reacts.
        const all = document.querySelectorAll('.modal')
        if (all[all.length - 1] === ref.current) {
          e.stopPropagation()
          onClose()
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, escape])
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[autofocus], input:not([type=checkbox]), textarea, select')
    el?.focus()
  }, [])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" ref={ref} style={{ width, height }} role="dialog" aria-modal>
        <div className="modal-head">
          {icon && <Icon name={icon} />}
          <span className="grow ellipsis">{title}</span>
          <button className="btn ghost icon small" onClick={onClose} title="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function confirmDialog(o: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return openModal<boolean>((close) => (
    <Modal
      title={o.title}
      onClose={() => close(false)}
      width={460}
      icon={o.danger ? 'warn' : undefined}
      footer={
        <>
          <button className="btn" onClick={() => close(false)}>
            Cancel
          </button>
          <button className={`btn ${o.danger ? 'danger solid' : 'primary'}`} autoFocus onClick={() => close(true)}>
            {o.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <div style={{ lineHeight: 1.55 }} className="selectable">
        {o.message}
      </div>
    </Modal>
  ))
}

function PromptBody(props: {
  label: string
  initial: string
  placeholder?: string
  validate?: (v: string) => string | null
  onDone: (v: string | null) => void
  title: string
  confirmLabel?: string
}): ReactElement {
  const [v, setV] = useState(props.initial)
  const err = props.validate?.(v) ?? null
  const submit = (): void => {
    if (!err) props.onDone(v)
  }
  return (
    <Modal
      title={props.title}
      onClose={() => props.onDone(null)}
      width={440}
      footer={
        <>
          <button className="btn" onClick={() => props.onDone(null)}>
            Cancel
          </button>
          <button className="btn primary" disabled={!!err} onClick={submit}>
            {props.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <div className="col">
        <label className="muted">{props.label}</label>
        <input
          className={`input ${err && v ? 'invalid' : ''}`}
          value={v}
          placeholder={props.placeholder}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          onFocus={(e) => e.target.select()}
        />
        {err && v && <div className="error-text">{err}</div>}
      </div>
    </Modal>
  )
}

export function promptDialog(o: {
  title: string
  label: string
  initial?: string
  placeholder?: string
  confirmLabel?: string
  validate?: (v: string) => string | null
}): Promise<string | null> {
  return openModal<string | null>((close) => (
    <PromptBody {...o} initial={o.initial ?? ''} onDone={close} />
  ))
}
