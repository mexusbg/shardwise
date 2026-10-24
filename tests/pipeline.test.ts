import { describe, expect, it } from 'vitest'
import type { ObjectId } from 'bson'
import {
  STAGE_TEMPLATES,
  StageError,
  hasOutputStage,
  keepIds,
  newStage,
  pipelineDocs,
  pipelineText,
  previewPipeline,
  shellCommand,
  stageError,
  stageSummary,
  stageValue,
  stagesFromFind,
  stagesFromText
} from '@shared/pipeline'
import type { Stage } from '@shared/pipeline'

const st = (op: string, body: string, enabled = true): Stage => newStage(op, body, enabled)
const shape = (stages: Stage[]): [string, string, boolean][] => stages.map((s) => [s.op, s.body, s.enabled])

describe('stage templates', () => {
  it('every template parses and passes validation', () => {
    for (const t of STAGE_TEMPLATES) expect(stageError({ op: t.op, body: t.body }), t.op).toBeNull()
  })
})

describe('stageValue / validation', () => {
  it('parses shell syntax bodies', () => {
    const v = stageValue({ op: '$match', body: "{ _id: ObjectId('650000000000000000000001'), d: ISODate('2024-01-01') }" })
    const m = v.$match as Record<string, unknown>
    expect((m._id as ObjectId)._bsontype).toBe('ObjectId')
    expect(m.d).toBeInstanceOf(Date)
  })

  it('checks stage shapes', () => {
    expect(stageError({ op: '$limit', body: '0' })).toMatch(/positive/)
    expect(stageError({ op: '$limit', body: "'x'" })).toMatch(/integer/)
    expect(stageError({ op: '$skip', body: '-1' })).toMatch(/non-negative/)
    expect(stageError({ op: '$count', body: '{}' })).toMatch(/name/)
    expect(stageError({ op: '$match', body: '[1]' })).toMatch(/object, not an array/)
    expect(stageError({ op: '$unset', body: "['a', 'b']" })).toBeNull()
    expect(stageError({ op: '$out', body: "'x'" })).toBeNull()
    expect(stageError({ op: '$merge', body: "'x'" })).toBeNull()
    expect(stageError({ op: '$unwind', body: "'$items'" })).toBeNull()
    expect(stageError({ op: '$unwind', body: "'items'" })).toMatch(/field path/)
    expect(stageError({ op: '$match', body: '' })).toMatch(/empty/)
    expect(stageError({ op: 'match', body: '{}' })).toMatch(/not a stage operator/)
  })

  it('reports syntax errors with a position in the body', () => {
    expect(stageError({ op: '$match', body: '{ a: 1 b: 2 }' })).toMatch(/Unexpected token \(line 1, column 8\)/)
    expect(stageError({ op: '$match', body: '{\n  a: 1\n  b: 2\n}' })).toMatch(/line 3/)
  })

  it('pipelineDocs skips disabled stages and names the bad stage', () => {
    const stages = [st('$match', '{ a: 1 }'), st('$limit', '5', false), st('$skip', '2')]
    expect(pipelineDocs(stages)).toEqual([{ $match: { a: 1 } }, { $skip: 2 }])
    expect(pipelineDocs(stages, true)).toHaveLength(3)
    try {
      pipelineDocs([st('$match', '{}'), st('$sort', '{ a: }')])
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(StageError)
      expect((e as StageError).index).toBe(1)
      expect((e as Error).message).toMatch(/^Stage 2 \(\$sort\)/)
    }
  })
})

describe('pipeline text', () => {
  it('round-trips stages, keeping comments, formatting and disabled stages', () => {
    const stages = [
      st('$match', "{\n  // paid only\n  status: 'paid'\n}"),
      st('$limit', '10', false),
      st('$group', "{ _id: '$customer', total: { $sum: '$amount' } }"),
      st('$project', '{ a: 1 } // trailing')
    ]
    const text = pipelineText(stages, true)
    expect(text).toContain('/* disabled */ { $limit: 10 }')
    expect(text).toContain("    $match: {\n      // paid only\n      status: 'paid'\n    }")
    const back = stagesFromText(text)
    expect(shape(back)).toEqual(shape(stages))
    expect(pipelineText(stages)).not.toContain('$limit')
  })

  it('parses hand-written text', () => {
    const back = stagesFromText(`[
      { "$match": { a: /x,y/i } }, // first
      {
        $sort: { a: -1, b: 1 },
      },
      { $count: 'n' },
    ]`)
    expect(shape(back)).toEqual([
      ['$match', '{ a: /x,y/i }', true],
      ['$sort', '{ a: -1, b: 1 }', true],
      ['$count', "'n'", true]
    ])
  })

  it('falls back to formatted values when the source cannot be split', () => {
    const back = stagesFromText('[{ $match: { a: 1 } }].concat([{ $limit: 3 }])')
    expect(shape(back)).toEqual([
      ['$match', '{ a: 1 }', true],
      ['$limit', '3', true]
    ])
  })

  it('rejects invalid pipelines', () => {
    expect(() => stagesFromText('{ $match: {} }')).toThrow(/array/)
    expect(() => stagesFromText('[{ $match: {}, $limit: 1 }]')).toThrow(/exactly one/)
    expect(() => stagesFromText('[{ a: 1 }]')).toThrow(/exactly one \$operator/)
    expect(() => stagesFromText('[{ $match: { a: } }]')).toThrow(/Unexpected/)
    expect(() => stagesFromText('[1]')).toThrow(/not an object/)
    expect(stagesFromText('  ')).toEqual([])
    expect(pipelineText([])).toBe('[]')
  })

  it('keepIds preserves ids by position', () => {
    const a = [st('$match', '{}'), st('$limit', '1')]
    const b = stagesFromText('[{ $match: { x: 1 } }, { $limit: 2 }, { $skip: 1 }]')
    const k = keepIds(a, b)
    expect(k.map((s) => s.id).slice(0, 2)).toEqual(a.map((s) => s.id))
    expect(k[2].id).toBe(b[2].id)
  })
})

describe('stagesFromFind', () => {
  it('converts query bar texts', () => {
    const s = stagesFromFind({ query: "{ status: 'paid' }", projection: '{ name: 1 }', sort: '{ at: -1 }', skip: '20', limit: '10' })
    expect(shape(s)).toEqual([
      ['$match', "{ status: 'paid' }", true],
      ['$sort', '{ at: -1 }', true],
      ['$skip', '20', true],
      ['$limit', '10', true],
      ['$project', '{ name: 1 }', true]
    ])
  })

  it('skips empty parts', () => {
    expect(stagesFromFind({ query: '{}', projection: '', sort: ' ', skip: '0', limit: '0' })).toEqual([])
    expect(shape(stagesFromFind({ query: '', limit: -5 }))).toEqual([['$limit', '5', true]])
  })
})

describe('previewPipeline', () => {
  const stages = [st('$match', '{ a: 1 }'), st('$out', "'x'"), st('$sort', '{ b: 1 }', false), st('$group', "{ _id: '$a' }")]

  it('samples first and caps the output', () => {
    expect(previewPipeline(stages, 0, 20, 'input')).toEqual([{ $limit: 20 }])
    expect(previewPipeline(stages, 0, 20, 'output')).toEqual([{ $limit: 20 }, { $match: { a: 1 } }, { $limit: 20 }])
    expect(previewPipeline(stages, 3, 5, 'output')).toEqual([{ $limit: 5 }, { $match: { a: 1 } }, { $group: { _id: '$a' } }, { $limit: 5 }])
  })

  it('skips $out / $merge and disabled stages', () => {
    expect(previewPipeline(stages, 1, 10, 'output')).toEqual([{ $limit: 10 }, { $match: { a: 1 } }, { $limit: 10 }])
    expect(previewPipeline(stages, 3, 10, 'input')).toEqual([{ $limit: 10 }, { $match: { a: 1 } }, { $limit: 10 }])
  })

  it('keeps stages that must be first ahead of the sample limit', () => {
    const geo = [st('$geoNear', "{ near: [0, 0], distanceField: 'd' }"), st('$match', '{}')]
    expect(previewPipeline(geo, 1, 10, 'output')).toEqual([{ $geoNear: { near: [0, 0], distanceField: 'd' } }, { $limit: 10 }, { $match: {} }, { $limit: 10 }])
  })

  it('throws StageError for an invalid stage in the prefix', () => {
    const bad = [st('$match', '{ a: }'), st('$limit', '3')]
    expect(() => previewPipeline(bad, 1, 10, 'output')).toThrow(StageError)
    expect(previewPipeline(bad, 0, 10, 'input')).toEqual([{ $limit: 10 }])
  })
})

describe('misc', () => {
  it('summaries drop comments and whitespace', () => {
    expect(stageSummary({ body: "{\n  // note\n  status: 'paid',\n  n: { }\n}" })).toBe("{ status: 'paid', n: {} }")
  })

  it('shell command and output detection', () => {
    const stages = [st('$match', '{ a: 1 }'), st('$out', "'x'", false)]
    expect(hasOutputStage(stages)).toBe(false)
    expect(hasOutputStage([...stages, st('$merge', "{ into: 'y' }")])).toBe(true)
    expect(shellCommand("o'k", stages, { allowDiskUse: true, maxTimeMS: 0 })).toBe("db.getCollection('o\\'k').aggregate([\n  { $match: { a: 1 } }\n], { allowDiskUse: true })")
  })
})
