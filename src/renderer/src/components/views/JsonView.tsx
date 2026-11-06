import { memo, useMemo } from 'react'
import type { ReactElement } from 'react'
import { docText } from '@shared/docText'
import { inlineSingleValueArrays, nestedFieldFolds } from '@shared/jsonFolds'
import type { QueryTab } from '../../state/store'
import { useStore } from '../../state/store'
import { CodeEditor } from '../CodeEditor'
import { useDateSettingsKey } from '../../lib/datetime'
import { sameResultTab } from './common'
import { NestedBar, useNestedCollapsed } from './NestedBar'

const MAX_CHARS = 3 * 1024 * 1024

export const JsonView = memo(function JsonView({ tab }: { tab: QueryTab }): ReactElement {
  const docs = tab.docs
  const style = useStore((s) => s.settings.jsonStyle)
  const numbers = useStore((s) => s.settings.jsonNumbers)
  // Shell syntax writes dates in the zone of the date settings.
  const dates = useDateSettingsKey()
  const [collapsed, choose] = useNestedCollapsed('shardwise.jsonView.nested')
  const text = useMemo(() => {
    if (!docs) return ''
    const parts: string[] = []
    let size = 0
    for (let i = 0; i < docs.length; i++) {
      const s = inlineSingleValueArrays(docText(docs[i], style, 2, numbers))
      size += s.length + 2
      if (size > MAX_CHARS) return null
      parts.push(s)
    }
    return parts.join('\n\n')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs, tab.rev, style, numbers, dates])

  const folds = useMemo(() => (collapsed && text ? nestedFieldFolds(text) : []), [collapsed, text])

  if (!docs?.length) return <div className="result-empty">No documents</div>
  if (text === null) {
    return (
      <div style={{ padding: 12 }}>
        <div className="notice">Current page is too large for JSON view. Reduce the page size or use the Table or List view.</div>
      </div>
    )
  }
  return (
    <div className="col" style={{ flex: 1, minHeight: 0, gap: 0 }}>
      <NestedBar collapsed={collapsed} onChange={choose} />
      <CodeEditor value={text} readOnly full className="cm-json-view" folds={folds} />
    </div>
  )
}, sameResultTab)
