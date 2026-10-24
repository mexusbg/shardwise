import type { ReactElement } from 'react'
import type { ToolTab } from '../../state/store'
import { AggregationView } from '../aggregation/AggregationView'
import { IndexManagerView } from '../indexes/IndexManagerView'
import { ShellView } from '../shell/ShellView'
import { QueryManagerView } from '../history/QueryManagerView'
import { SchemaView } from '../schema/SchemaView'
import { SqlQueryView } from '../sql/SqlQueryView'
import { UsersView } from '../users/UsersView'
import { CompareView } from '../compare/CompareView'
import { MigrationView } from '../migration/MigrationView'
import { MaskingView } from '../masking/MaskingView'
import { ReschemaView } from '../masking/ReschemaView'
import { CollectionHistoryView } from '../changes/CollectionHistoryView'
import { TasksView } from '../tasks/TasksView'
import { GridFsView } from '../gridfs/GridFsView'
import { SearchView } from '../search/SearchView'
import { ServerStatusView } from '../server/ServerStatusView'
import { ValidationView } from '../server/ValidationView'

/** Renders a phase 2 tool tab. */
export function ToolView({ tab }: { tab: ToolTab }): ReactElement {
  switch (tab.kind) {
    case 'aggregation':
      return <AggregationView tab={tab} />
    case 'indexes':
      return <IndexManagerView tab={tab} />
    case 'shell':
      return <ShellView tab={tab} />
    case 'queries':
      return <QueryManagerView tab={tab} />
    case 'schema':
      return <SchemaView tab={tab} />
    case 'sql':
      return <SqlQueryView tab={tab} />
    case 'users':
      return <UsersView tab={tab} />
    case 'compare':
      return <CompareView tab={tab} />
    case 'migration':
      return <MigrationView tab={tab} />
    case 'masking':
      return <MaskingView tab={tab} />
    case 'reschema':
      return <ReschemaView tab={tab} />
    case 'history':
      return <CollectionHistoryView tab={tab} />
    case 'tasks':
      return <TasksView tab={tab} />
    case 'gridfs':
      return <GridFsView tab={tab} />
    case 'search':
      return <SearchView tab={tab} />
    case 'server':
      return <ServerStatusView tab={tab} />
    case 'validation':
      return <ValidationView tab={tab} />
  }
}
