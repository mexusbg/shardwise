import { memo, useMemo } from 'react'
import type { ReactElement } from 'react'
import { docText } from '@shared/docText'
import type { QueryTab } from '../../state/store'
import { useStore } from '../../state/store'
import { CodeEditor } from '../CodeEditor'
import { sameResultTab } from './common'

const MAX_CHARS = 3 * 1024 * 1024

export const JsonView = memo(function JsonView({ tab }: { tab: QueryTab }): ReactElement {
  const docs = tab.docs
  const style = useStore((s) => s.settings.jsonStyle)
  const text = useMemo(() => {
    if (!docs) return ''
    const parts: string[] = []
    let size = 0
    for (let i = 0; i < docs.length; i++) {
      const s = `// ${i + 1}\n${docText(docs[i], style, 2)}`
      size += s.length + 2
      if (size > MAX_CHARS) return null
      parts.push(s)
    }
    return parts.join('\n\n')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs, tab.rev, style])

  if (!docs?.length) return <div className="result-empty">No documents</div>
  if (text === null) {
    return (
      <div style={{ padding: 12 }}>
        <div className="notice">Current page is too large for JSON view. Reduce the page size or use the Table/Tree view.</div>
      </div>
    )
  }
  return <CodeEditor value={text} readOnly full className="cm-json-view" />
}, sameResultTab)
