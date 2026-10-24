import { useState } from 'react'
import type { ReactElement } from 'react'
import { shellText } from '@shared/bsonValue'
import type { Doc } from '@shared/api'
import type { GridFsFile, GridFsUploadOptions } from '@shared/gridfsApi'
import { tryParse } from '../../lib/queryText'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'
import { Modal, openModal } from '../Modal'

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p

const parseDoc = (text: string): Doc | null | undefined => {
  if (!text.trim()) return null
  const v = tryParse('query', text)
  return v === undefined ? undefined : (v as Doc)
}

function UploadBody(props: { paths: string[]; bucket: string; db: string; done: (v: { bucket: string; options: GridFsUploadOptions } | null) => void }): ReactElement {
  const single = props.paths.length === 1
  const [bucket, setBucket] = useState(props.bucket)
  const [filename, setFilename] = useState(single ? baseName(props.paths[0]) : '')
  const [contentType, setContentType] = useState('')
  const [meta, setMeta] = useState('')
  const parsed = parseDoc(meta)
  const invalid = parsed === undefined
  const bucketErr = !bucket.trim() ? 'Enter a bucket name' : /[$\0]/.test(bucket) || bucket.startsWith('system.') ? 'Invalid bucket name' : null
  const ok = !invalid && !bucketErr && (!single || !!filename.trim())

  const submit = (): void => {
    if (!ok) return
    const options: GridFsUploadOptions = {}
    if (parsed) options.metadata = parsed
    if (contentType.trim()) options.contentType = contentType.trim()
    if (single) options.filename = filename.trim()
    props.done({ bucket: bucket.trim(), options })
  }

  return (
    <Modal
      title={single ? 'Upload file' : `Upload ${props.paths.length} files`}
      icon="import"
      width={560}
      onClose={() => props.done(null)}
      footer={
        <>
          <button className="btn" onClick={() => props.done(null)}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ok} onClick={submit}>
            <Icon name="import" size={13} /> Upload
          </button>
        </>
      }
    >
      <div className="gfs-form">
        <div className="gfs-upload-files">
          {props.paths.slice(0, 8).map((p) => (
            <div key={p} className="gfs-upload-file mono ellipsis" title={p}>
              <Icon name="files" size={12} /> {p}
            </div>
          ))}
          {props.paths.length > 8 && <div className="faint gfs-small">… and {props.paths.length - 8} more</div>}
        </div>
        <div className="field">
          <label>Bucket</label>
          <input className={`input mono ${bucketErr ? 'invalid' : ''}`} value={bucket} onChange={(e) => setBucket(e.target.value)} />
        </div>
        {single && (
          <div className="field">
            <label>File name</label>
            <input className="input" value={filename} onChange={(e) => setFilename(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label>Content type</label>
          <input className="input mono" value={contentType} placeholder="Detect from the extension" onChange={(e) => setContentType(e.target.value)} />
        </div>
        <div className="field top">
          <label>
            Metadata <span className="faint">(optional)</span>
          </label>
          <div className="gfs-meta-editor">
            <CodeEditor value={meta} onChange={setMeta} invalid={invalid} placeholder="{ owner: 'alice', tags: ['report'] }" minHeight={90} maxHeight={200} onSubmit={submit} />
            {invalid && <div className="error-text gfs-small">Metadata must be a document in shell syntax.</div>}
          </div>
        </div>
        <div className="faint gfs-small">
          Files are stored in <span className="mono">{props.db}.{bucket || '…'}.files</span> / <span className="mono">.chunks</span>; the content type goes into{' '}
          <span className="mono">metadata.contentType</span>.
        </div>
      </div>
    </Modal>
  )
}

/** Upload options for the chosen files; null when cancelled. */
export function openUploadDialog(o: { paths: string[]; bucket: string; db: string }): Promise<{ bucket: string; options: GridFsUploadOptions } | null> {
  return openModal((close) => <UploadBody {...o} done={close} />)
}

function MetadataBody({ file, done }: { file: GridFsFile; done: (v: Doc | null | undefined) => void }): ReactElement {
  const [text, setText] = useState(file.metadata ? shellText(file.metadata, 2) : '')
  const parsed = parseDoc(text)
  const invalid = parsed === undefined
  const save = (): void => {
    if (!invalid) done(parsed ?? null)
  }
  return (
    <Modal
      title={
        <>
          Metadata · <span className="mono">{file.filename}</span>
        </>
      }
      icon="json"
      width={600}
      onClose={() => done(undefined)}
      footer={
        <>
          <span className="faint gfs-small grow">Empty removes the metadata field.</span>
          <button className="btn" onClick={() => done(undefined)}>
            Cancel
          </button>
          <button className="btn primary" disabled={invalid} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="gfs-form">
        <CodeEditor value={text} onChange={setText} invalid={invalid} full minHeight={220} maxHeight={420} onSubmit={save} autoFocus />
        {invalid && <div className="error-text gfs-small">Metadata must be a document in shell syntax.</div>}
      </div>
    </Modal>
  )
}

/** New metadata (null = remove) or undefined when cancelled. */
export function openMetadataDialog(file: GridFsFile): Promise<Doc | null | undefined> {
  return openModal<Doc | null | undefined>((close) => <MetadataBody file={file} done={close} />)
}
