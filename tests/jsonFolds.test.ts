import { describe, expect, it } from 'vitest'
import { shellText } from '@shared/bsonValue'
import { inlineSingleValueArrays, nestedFieldFolds } from '@shared/jsonFolds'

describe('JSON view folds', () => {
  it("folds each top-level field's object or array, not the document", () => {
    const text = ['// 1', '{', "  _id: ObjectId('a'),", '  fond: {', '    a: 1,', '    b: { c: [', '      1', '    ] }', '  },', '  tags: [', "    'x'", '  ],', "  name: 'n'", '}'].join('\n')
    const folds = nestedFieldFolds(text)
    expect(folds.map((f) => text.slice(f.from, f.to))).toEqual(['\n    a: 1,\n    b: { c: [\n      1\n    ] }\n  ', "\n    'x'\n  "])
    // What is left visible: the field lines with their brackets.
    const shown = folds.reduceRight((t, f) => t.slice(0, f.from) + '…' + t.slice(f.to), text)
    expect(shown).toContain('  fond: {…},')
    expect(shown).toContain('  tags: […],')
  })

  it('works for Extended JSON and leaves one-line values alone', () => {
    const text = ['{', '  "_id": {', '    "$oid": "a"', '  },', '  "empty": {},', '  "n": 1', '}'].join('\n')
    expect(nestedFieldFolds(text).map((f) => text.slice(f.from, f.to))).toEqual(['\n    "$oid": "a"\n  '])
  })

  it('puts arrays of one plain value on one line', () => {
    const lines = ['{', '  tags: [', "    'general'", '  ],', '  ids: [', "    ObjectId('a')", '  ],', '  two: [', '    1,', '    2', '  ],', '  one: [', '    {', '      a: 1', '    }', '  ],', '  deep: [', '    [', '      1', '    ]', '  ]', '}']
    const text = inlineSingleValueArrays(lines.join('\n'))
    expect(text.split('\n')).toEqual(['{', "  tags: ['general'],", "  ids: [ObjectId('a')],", ...lines.slice(7, 16), '  deep: [', '    [1]', '  ]', '}'])
    expect(inlineSingleValueArrays(shellText({ categories: ['general'], n: [1, 2] }, 2))).toBe("{\n  categories: ['general'],\n  n: [\n    1,\n    2\n  ]\n}")
    // A one-line array is no longer folded.
    expect(nestedFieldFolds(text).map((f) => text.slice(f.from, f.to).trim().split('\n')[0])).toEqual(['1,', '{', '[1]'])
  })
})
