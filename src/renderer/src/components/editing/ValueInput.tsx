import type { ReactElement } from 'react'
import { EDITABLE_TYPES, ObjectId, TYPE_LABELS } from '@shared/bsonValue'
import type { EditableType } from '@shared/bsonValue'
import { CodeEditor } from '../CodeEditor'
import { dataDateEditText, getDataDateDisplay, resolveZone } from '@shared/dateFormat'

const dateZone = (): string => resolveZone(getDataDateDisplay().zone)
const datePlaceholder = (): string => (dateZone() === 'UTC' ? 'YYYY-MM-DDTHH:mm:ss.sssZ' : `YYYY-MM-DD HH:mm:ss (${dateZone()})`)
const dateHint = (): string => `Dates without Z or an offset are read as ${dateZone()} time (Settings → Dates & time zones)`

export function TypeSelect({ value, onChange, small, exclude }: { value: EditableType; onChange: (t: EditableType) => void; small?: boolean; exclude?: EditableType[] }): ReactElement {
  return (
    <select className={`select ${small ? 'small' : ''}`} value={value} onChange={(e) => onChange(e.target.value as EditableType)} title="Value type">
      {EDITABLE_TYPES.filter((t) => !exclude?.includes(t)).map((t) => (
        <option key={t} value={t}>
          {TYPE_LABELS[t]}
        </option>
      ))}
    </select>
  )
}

interface Props {
  type: EditableType
  text: string
  onChange: (t: string) => void
  invalid?: boolean
  small?: boolean
  onSubmit?: () => void
  placeholder?: string
  multiline?: boolean
}

/** Text input adapted to a BSON type. */
export function ValueInput({ type, text, onChange, invalid, small, onSubmit, placeholder, multiline }: Props): ReactElement {
  const cls = `input grow mono ${small ? 'small' : ''} ${invalid ? 'invalid' : ''}`
  const key = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && onSubmit) onSubmit()
  }
  switch (type) {
    case 'bool':
      return (
        <select className={`select grow ${small ? 'small' : ''}`} value={/^true$/i.test(text) ? 'true' : 'false'} onChange={(e) => onChange(e.target.value)}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      )
    case 'null':
      return <input className={cls} value="null" disabled />
    case 'array':
    case 'object':
      return (
        <div className="grow" style={{ minWidth: 0 }}>
          <CodeEditor value={text} onChange={onChange} invalid={invalid} minHeight={small ? 26 : 120} maxHeight={small ? 120 : 360} placeholder={type === 'array' ? '[ … ]' : '{ … }'} onSubmit={onSubmit} />
        </div>
      )
    case 'date':
      return (
        <>
          <input className={cls} value={text} placeholder={placeholder ?? datePlaceholder()} onChange={(e) => onChange(e.target.value)} onKeyDown={key} title={dateHint()} />
          <button className={`btn ${small ? 'small' : ''}`} onClick={() => onChange(dataDateEditText(new Date()))} title="Current date and time">
            Now
          </button>
        </>
      )
    case 'objectId':
      return (
        <>
          <input className={cls} value={text} placeholder={placeholder ?? '24 hex characters'} onChange={(e) => onChange(e.target.value)} onKeyDown={key} />
          <button className={`btn ${small ? 'small' : ''}`} onClick={() => onChange(new ObjectId().toHexString())} title="Generate a new ObjectId">
            New
          </button>
        </>
      )
    case 'string':
      if (multiline || text.includes('\n'))
        return <textarea className={cls} rows={small ? 2 : 6} value={text} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      return <input className={cls} value={text} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={key} />
    default:
      return <input className={cls} value={text} placeholder={placeholder ?? (type === 'regex' ? '/pattern/flags' : '')} onChange={(e) => onChange(e.target.value)} onKeyDown={key} />
  }
}
