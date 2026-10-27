import { describe, expect, it } from 'vitest'
import { byUsage, parseUsage, recordUse } from '@shared/connectionUsage'

const conns = ['AMARANT', 'All Apps 1', 'Apolonia', 'Atletica'].map((name, i) => ({ id: `c${i}`, name }))
const names = (xs: { name: string }[]) => xs.map((x) => x.name)

describe('connection usage', () => {
  it('keeps the given order when nothing was opened', () => {
    expect(names(byUsage(conns, {}))).toEqual(['AMARANT', 'All Apps 1', 'Apolonia', 'Atletica'])
  })

  it('puts the most opened first, then the most recent, then the rest in order', () => {
    let u = recordUse({}, 'c3', 1)
    u = recordUse(u, 'c3', 2)
    u = recordUse(u, 'c1', 3)
    u = recordUse(u, 'c2', 4)
    expect(names(byUsage(conns, u))).toEqual(['Atletica', 'Apolonia', 'All Apps 1', 'AMARANT'])
  })

  it('ignores malformed stored data', () => {
    expect(parseUsage(null)).toEqual({})
    expect(parseUsage('[1]')).toEqual({})
    expect(parseUsage('{"a":{"count":2,"last":5},"b":{"count":"x"},"c":null}')).toEqual({ a: { count: 2, last: 5 } })
  })
})
