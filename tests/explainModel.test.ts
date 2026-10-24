import { describe, expect, it } from 'vitest'
import { findNode, parseExplain } from '../src/shared/explain'
import type { PlanNode } from '../src/shared/explain'

const stages = (n: PlanNode): string[] => [n.stage, ...n.children.flatMap(stages)]

const classicCollscan = {
  explainVersion: '1',
  queryPlanner: {
    namespace: 'shop.orders',
    indexFilterSet: false,
    parsedQuery: { status: { $eq: 'A' } },
    queryHash: '3D0B3A5F',
    planCacheKey: '9C1C7AF5',
    maxIndexedOrSolutionsReached: false,
    winningPlan: { stage: 'COLLSCAN', filter: { status: { $eq: 'A' } }, direction: 'forward' },
    rejectedPlans: []
  },
  executionStats: {
    executionSuccess: true,
    nReturned: 12,
    executionTimeMillis: 41,
    totalKeysExamined: 0,
    totalDocsExamined: 50000,
    executionStages: {
      stage: 'COLLSCAN',
      filter: { status: { $eq: 'A' } },
      nReturned: 12,
      executionTimeMillisEstimate: 38,
      works: 50002,
      advanced: 12,
      needTime: 49989,
      needYield: 0,
      saveState: 50,
      restoreState: 50,
      isEOF: 1,
      direction: 'forward',
      docsExamined: 50000
    }
  },
  command: { find: 'orders', filter: { status: 'A' }, $db: 'shop' },
  serverInfo: { host: 'db1', port: 27017, version: '4.4.29' },
  ok: 1
}

const ixscanFetchSort = {
  queryPlanner: {
    namespace: 'shop.orders',
    indexFilterSet: false,
    parsedQuery: { $and: [{ customerId: { $eq: 42 } }, { total: { $gt: 100 } }] },
    queryHash: 'A1B2C3D4',
    planCacheKey: 'E5F6A7B8',
    winningPlan: {
      isCached: true,
      stage: 'SORT',
      sortPattern: { createdAt: -1 },
      memLimit: 104857600,
      type: 'simple',
      inputStage: {
        stage: 'FETCH',
        filter: { total: { $gt: 100 } },
        inputStage: {
          stage: 'IXSCAN',
          keyPattern: { customerId: 1 },
          indexName: 'customerId_1',
          isMultiKey: false,
          multiKeyPaths: { customerId: [] },
          isUnique: false,
          isSparse: false,
          isPartial: false,
          indexVersion: 2,
          direction: 'forward',
          indexBounds: { customerId: ['[42, 42]'] }
        }
      }
    },
    rejectedPlans: [
      {
        stage: 'SORT',
        sortPattern: { createdAt: -1 },
        inputStage: {
          stage: 'FETCH',
          filter: { customerId: { $eq: 42 } },
          inputStage: { stage: 'IXSCAN', keyPattern: { total: 1 }, indexName: 'total_1', direction: 'forward', indexBounds: { total: ['(100, inf.0]'] } }
        }
      }
    ]
  },
  executionStats: {
    executionSuccess: true,
    nReturned: 30,
    executionTimeMillis: 3,
    totalKeysExamined: 400,
    totalDocsExamined: 400,
    executionStages: {
      stage: 'SORT',
      nReturned: 30,
      executionTimeMillisEstimate: 2,
      works: 432,
      advanced: 30,
      needTime: 401,
      needYield: 0,
      isEOF: 1,
      sortPattern: { createdAt: -1 },
      memLimit: 104857600,
      type: 'simple',
      totalDataSizeSorted: 9120,
      usedDisk: false,
      spills: 0,
      inputStage: {
        stage: 'FETCH',
        filter: { total: { $gt: 100 } },
        nReturned: 30,
        executionTimeMillisEstimate: 1,
        works: 401,
        advanced: 30,
        needTime: 370,
        isEOF: 1,
        docsExamined: 400,
        alreadyHasObj: 0,
        inputStage: {
          stage: 'IXSCAN',
          nReturned: 400,
          executionTimeMillisEstimate: 0,
          works: 401,
          advanced: 400,
          isEOF: 1,
          keyPattern: { customerId: 1 },
          indexName: 'customerId_1',
          direction: 'forward',
          indexBounds: { customerId: ['[42, 42]'] },
          keysExamined: 400,
          seeks: 1,
          dupsTested: 0,
          dupsDropped: 0
        }
      }
    }
  },
  ok: 1
}

const sbe = {
  explainVersion: '2',
  queryPlanner: {
    namespace: 'shop.orders',
    indexFilterSet: false,
    parsedQuery: { customerId: { $eq: 42 } },
    planCacheShapeHash: '5F2AB1C9',
    planCacheKey: '0C77D0E2',
    optimizationTimeMillis: 0,
    winningPlan: {
      isCached: false,
      queryPlan: {
        stage: 'FETCH',
        planNodeId: 2,
        inputStage: {
          stage: 'IXSCAN',
          planNodeId: 1,
          keyPattern: { customerId: 1 },
          indexName: 'customerId_1',
          direction: 'forward',
          indexBounds: { customerId: ['[42, 42]'] }
        }
      },
      slotBasedPlan: { slots: '$$RESULT=s11 env: { s1 = Nothing }', stages: '[2] nlj inner [] [s4, s7] ...' }
    },
    rejectedPlans: []
  },
  executionStats: {
    executionSuccess: true,
    nReturned: 25,
    executionTimeMillis: 1,
    totalKeysExamined: 25,
    totalDocsExamined: 25,
    executionStages: {
      stage: 'nlj',
      planNodeId: 2,
      nReturned: 25,
      executionTimeMillisEstimate: 1,
      opens: 1,
      closes: 1,
      saveState: 0,
      restoreState: 0,
      isEOF: 1,
      totalDocsExamined: 25,
      totalKeysExamined: 25,
      outerStage: {
        stage: 'ixseek',
        planNodeId: 1,
        nReturned: 25,
        executionTimeMillisEstimate: 0,
        opens: 1,
        closes: 1,
        isEOF: 1,
        indexName: 'customerId_1',
        keysExamined: 25,
        seeks: 1,
        numReads: 26
      },
      innerStage: {
        stage: 'limit',
        planNodeId: 2,
        nReturned: 25,
        limit: 1,
        inputStage: { stage: 'seek', planNodeId: 2, nReturned: 25, numReads: 25 }
      }
    }
  },
  ok: 1
}

const sharded = {
  queryPlanner: {
    mongosPlannerVersion: 1,
    winningPlan: {
      stage: 'SHARD_MERGE',
      shards: [
        {
          shardName: 'rs0',
          connectionString: 'rs0/h1:27018',
          namespace: 'shop.orders',
          parsedQuery: { region: { $eq: 'EU' } },
          winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', keyPattern: { region: 1 }, indexName: 'region_1', indexBounds: { region: ['["EU", "EU"]'] } } },
          rejectedPlans: []
        },
        {
          shardName: 'rs1',
          connectionString: 'rs1/h2:27018',
          namespace: 'shop.orders',
          parsedQuery: { region: { $eq: 'EU' } },
          winningPlan: { stage: 'SHARDING_FILTER', inputStage: { stage: 'COLLSCAN', filter: { region: { $eq: 'EU' } }, direction: 'forward' } },
          rejectedPlans: [{ stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'other_1' } }]
        }
      ]
    }
  },
  executionStats: {
    nReturned: 70,
    executionTimeMillis: 9,
    totalKeysExamined: 40,
    totalDocsExamined: 1040,
    executionStages: {
      stage: 'SHARD_MERGE',
      nReturned: 70,
      executionTimeMillis: 9,
      totalKeysExamined: 40,
      totalDocsExamined: 1040,
      totalChildMillis: 10,
      shards: [
        {
          shardName: 'rs1',
          executionSuccess: true,
          nReturned: 30,
          executionTimeMillis: 8,
          totalKeysExamined: 0,
          totalDocsExamined: 1000,
          executionStages: {
            stage: 'SHARDING_FILTER',
            nReturned: 30,
            executionTimeMillisEstimate: 7,
            chunkSkips: 0,
            inputStage: { stage: 'COLLSCAN', filter: { region: { $eq: 'EU' } }, nReturned: 30, executionTimeMillisEstimate: 7, docsExamined: 1000, direction: 'forward' }
          }
        },
        {
          shardName: 'rs0',
          executionSuccess: true,
          nReturned: 40,
          executionTimeMillis: 2,
          totalKeysExamined: 40,
          totalDocsExamined: 40,
          executionStages: {
            stage: 'FETCH',
            nReturned: 40,
            executionTimeMillisEstimate: 1,
            docsExamined: 40,
            inputStage: { stage: 'IXSCAN', nReturned: 40, executionTimeMillisEstimate: 0, keyPattern: { region: 1 }, indexName: 'region_1', keysExamined: 40 }
          }
        }
      ]
    }
  },
  ok: 1
}

const plannerOnly = {
  queryPlanner: {
    namespace: 'shop.orders',
    parsedQuery: { sku: { $eq: 'X1' } },
    winningPlan: {
      stage: 'PROJECTION_COVERED',
      transformBy: { sku: 1, _id: 0 },
      inputStage: { stage: 'IXSCAN', keyPattern: { sku: 1 }, indexName: 'sku_1', direction: 'forward', indexBounds: { sku: ['["X1", "X1"]'] } }
    },
    rejectedPlans: []
  },
  ok: 1
}

describe('parseExplain', () => {
  it('classic COLLSCAN', () => {
    const { summary, root } = parseExplain(classicCollscan)
    expect(root.stage).toBe('COLLSCAN')
    expect(root.id).toBe('0')
    expect(root.details.filter).toEqual({ status: { $eq: 'A' } })
    expect(root.details.nReturned).toBeUndefined()
    expect(root.stats).toMatchObject({ nReturned: 12, timeMs: 38, works: 50002, advanced: 12, docsExamined: 50000, isEOF: true })
    expect(summary).toMatchObject({ hasStats: true, engine: 'classic', nReturned: 12, docsExamined: 50000, keysExamined: 0, timeMs: 41, collscan: true, filtered: true, indexes: [], queryHash: '3D0B3A5F', rejectedPlans: 0 })
    expect(summary.ratio).toBeCloseTo(4166.67, 1)
    expect(summary.warnings.map((w) => w.kind)).toEqual(['collscan', 'ratio'])
  })

  it('classic IXSCAN + FETCH + SORT', () => {
    const { summary, root, rejected } = parseExplain(ixscanFetchSort)
    expect(stages(root)).toEqual(['SORT', 'FETCH', 'IXSCAN'])
    const ix = findNode(root, '0.0.0')!
    expect(ix.details).toMatchObject({ indexName: 'customerId_1', keyPattern: { customerId: 1 }, indexBounds: { customerId: ['[42, 42]'] } })
    expect(ix.stats).toMatchObject({ nReturned: 400, keysExamined: 400, timeMs: 0 })
    expect(findNode(root, '0.0')!.stats?.docsExamined).toBe(400)
    expect(root.stats).toMatchObject({ usedDisk: false, memUsage: 9120 })
    expect(summary).toMatchObject({ indexes: ['customerId_1'], collscan: false, inMemorySort: true, covered: false, isCached: true, rejectedPlans: 1 })
    expect(summary.ratio).toBeCloseTo(13.33, 1)
    expect(summary.warnings.map((w) => w.kind)).toEqual(['sort', 'ratio'])
    expect(rejected).toHaveLength(1)
    expect(stages(rejected[0])).toEqual(['SORT', 'FETCH', 'IXSCAN'])
    expect(rejected[0].id).toBe('r0')
  })

  it('SBE queryPlan with stats merged by planNodeId', () => {
    const { summary, root } = parseExplain(sbe)
    expect(stages(root)).toEqual(['FETCH', 'IXSCAN'])
    expect(root.stats).toMatchObject({ nReturned: 25, timeMs: 1, docsExamined: 25 })
    expect(root.stats?.keysExamined).toBeUndefined()
    expect(root.stats?.raw.sbeStages).toEqual(['nlj', 'limit', 'seek'])
    expect(root.children[0].stats).toMatchObject({ nReturned: 25, keysExamined: 25 })
    expect(summary).toMatchObject({ engine: 'sbe', indexes: ['customerId_1'], queryHash: '5F2AB1C9', isCached: false, inMemorySort: false, collscan: false, warnings: [] })
  })

  it('SBE execution tree without a logical plan is shown as is', () => {
    const { root, summary } = parseExplain({ explainVersion: '2', queryPlanner: { winningPlan: { slotBasedPlan: { stages: '' } } }, executionStats: { nReturned: 25, executionStages: sbe.executionStats.executionStages } })
    expect(stages(root)).toEqual(['nlj', 'ixseek', 'limit', 'seek'])
    expect(root.stats?.nReturned).toBe(25)
    expect(summary.engine).toBe('sbe')
  })

  it('sharded', () => {
    const { summary, root, rejected } = parseExplain(sharded)
    expect(root.stage).toBe('SHARD_MERGE')
    expect(root.stats).toMatchObject({ nReturned: 70, timeMs: 9 })
    expect(root.children.map((c) => [c.stage, c.label])).toEqual([
      ['SHARD', 'rs0'],
      ['SHARD', 'rs1']
    ])
    const rs0 = root.children[0]
    expect(rs0.stats).toMatchObject({ nReturned: 40, keysExamined: 40 })
    expect(stages(rs0.children[0])).toEqual(['FETCH', 'IXSCAN'])
    expect(rs0.children[0].children[0].stats?.keysExamined).toBe(40)
    const rs1 = root.children[1]
    expect(stages(rs1.children[0])).toEqual(['SHARDING_FILTER', 'COLLSCAN'])
    expect(rs1.children[0].children[0].stats?.docsExamined).toBe(1000)
    expect(summary).toMatchObject({ sharded: true, shardCount: 2, nReturned: 70, docsExamined: 1040, indexes: ['region_1'], collscan: true, filtered: true, rejectedPlans: 1 })
    expect(rejected).toHaveLength(1)
    expect(summary.warnings.map((w) => w.kind)).toEqual(['collscan', 'ratio'])
  })

  it('queryPlanner verbosity: structure only', () => {
    const { summary, root } = parseExplain(plannerOnly)
    expect(stages(root)).toEqual(['PROJECTION_COVERED', 'IXSCAN'])
    expect(root.stats).toBeUndefined()
    expect(root.children[0].stats).toBeUndefined()
    expect(summary).toMatchObject({ hasStats: false, indexes: ['sku_1'], covered: true, warnings: [] })
    expect(summary.nReturned).toBeUndefined()
    expect(summary.ratio).toBeUndefined()
  })

  it('aggregation stages array renders linearly with the cursor plan at the bottom', () => {
    const { root, summary } = parseExplain({
      stages: [
        { $cursor: { queryPlanner: plannerOnly.queryPlanner, executionStats: { nReturned: 5, totalDocsExamined: 0, totalKeysExamined: 5, executionTimeMillis: 1 } } },
        { $group: { _id: '$sku', n: { $sum: 1 } }, nReturned: 1, executionTimeMillisEstimate: 0 },
        { $sort: { sortKey: { n: -1 } }, nReturned: 1 }
      ]
    })
    expect(stages(root)).toEqual(['$sort', '$group', 'PROJECTION_COVERED', 'IXSCAN'])
    expect(root.id).toBe('0')
    expect(findNode(root, '0.0.0.0')?.stage).toBe('IXSCAN')
    expect(summary).toMatchObject({ hasStats: true, nReturned: 1, inMemorySort: true, indexes: ['sku_1'] })
  })

  it('unfiltered COLLSCAN is not flagged; failed execution is', () => {
    const doc = structuredClone(classicCollscan) as typeof classicCollscan & { executionStats: { executionSuccess: boolean; errorMessage?: string } }
    doc.queryPlanner.parsedQuery = {} as typeof doc.queryPlanner.parsedQuery
    doc.executionStats.nReturned = 50000
    doc.executionStats.executionSuccess = false
    doc.executionStats.errorMessage = 'operation exceeded time limit'
    const { summary } = parseExplain(doc)
    expect(summary.filtered).toBe(false)
    expect(summary.warnings.map((w) => w.kind)).toEqual(['failed'])
  })
})
