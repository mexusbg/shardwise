import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { toJsonSchema, validatorCommand } from '@shared/schema'
import type { SchemaReport } from '@shared/schema'
import { api } from '../../lib/api'
import { errorText, toast } from '../../state/store'
import { CodeEditor } from '../CodeEditor'
import { Modal, openModal } from '../Modal'

function JsonSchemaDialog({ report, coll, onClose }: { report: SchemaReport; coll: string; onClose: () => void }): ReactElement {
  const [required, setRequired] = useState(true)
  const schema = useMemo(() => toJsonSchema(report, { required: required ? 'always-present' : 'none' }), [report, required])
  const text = useMemo(() => JSON.stringify(schema, null, 2), [schema])
  const copy = (s: string, what: string): void => {
    api
      .copyText(s)
      .then(() => toast(`${what} copied`, 'success'))
      .catch((e) => toast(errorText(e), 'error'))
  }
  return (
    <Modal
      title={`JSON Schema — ${coll}`}
      icon="schema"
      onClose={onClose}
      width={780}
      footer={
        <>
          <label className="check">
            <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
            Require fields present in every sampled document
          </label>
          <span className="spacer" />
          <button className="btn" onClick={() => copy(text, 'JSON Schema')}>
            Copy
          </button>
          <button className="btn" onClick={() => copy(validatorCommand(coll, schema), 'Validator command')}>
            Copy validator command
          </button>
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="col">
        <div className="muted">
          MongoDB <span className="mono">$jsonSchema</span> inferred from {report.docCount.toLocaleString()} sampled documents. Review it before
          using it as a validator: rare variants may be missing from the sample.
        </div>
        <CodeEditor value={text} readOnly full minHeight={340} maxHeight={520} />
      </div>
    </Modal>
  )
}

export function showJsonSchema(report: SchemaReport, coll: string): void {
  void openModal<void>((close) => <JsonSchemaDialog report={report} coll={coll} onClose={() => close()} />)
}
