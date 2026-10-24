import type { FakeKind } from '@shared/maskingApi'

/** Uniform [0, 1) generator. */
export type Rng = () => number

/** sfc32 seeded from 16 bytes (e.g. the start of a SHA-256 digest). */
export function seededRng(seed: Uint8Array): Rng {
  const word = (i: number): number => (seed[i] | (seed[i + 1] << 8) | (seed[i + 2] << 16) | (seed[i + 3] << 24)) >>> 0
  let a = word(0)
  let b = word(4)
  let c = word(8)
  let d = word(12) | 1
  const next = (): number => {
    a >>>= 0
    b >>>= 0
    c >>>= 0
    d >>>= 0
    const t = (((a + b) | 0) + d) | 0
    d = (d + 1) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    c = (c + t) | 0
    return (t >>> 0) / 4294967296
  }
  for (let i = 0; i < 12; i++) next()
  return next
}

const FIRST = [
  'James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda', 'William', 'Elizabeth', 'David', 'Barbara',
  'Richard', 'Susan', 'Joseph', 'Jessica', 'Thomas', 'Sarah', 'Charles', 'Karen', 'Daniel', 'Nancy', 'Matthew', 'Lisa',
  'Anthony', 'Betty', 'Mark', 'Sandra', 'Paul', 'Ashley', 'Steven', 'Emily', 'Andrew', 'Donna', 'Joshua', 'Michelle',
  'Kevin', 'Carol', 'Brian', 'Amanda', 'George', 'Melissa', 'Timothy', 'Deborah', 'Ronald', 'Laura', 'Jason', 'Rebecca',
  'Lucas', 'Sofia', 'Mateo', 'Chloe', 'Noah', 'Olivia', 'Liam', 'Emma', 'Ethan', 'Ava', 'Hugo', 'Lea', 'Marco', 'Giulia',
  'Pierre', 'Camille', 'Jonas', 'Anna', 'Felix', 'Clara', 'Diego', 'Lucia', 'Arjun', 'Priya', 'Kenji', 'Yuki', 'Omar', 'Amira'
]
const LAST = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez',
  'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson',
  'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King', 'Wright',
  'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores', 'Green', 'Adams', 'Nelson', 'Baker', 'Hall', 'Rivera', 'Campbell',
  'Mitchell', 'Carter', 'Roberts', 'Rossi', 'Bianchi', 'Dubois', 'Moreau', 'Muller', 'Schmidt', 'Novak', 'Kowalski',
  'Jensen', 'Larsen', 'Silva', 'Santos', 'Tanaka', 'Sato', 'Kim', 'Park', 'Chen', 'Wang', 'Patel', 'Singh'
]
const STREETS = [
  'Maple', 'Oak', 'Pine', 'Cedar', 'Elm', 'Willow', 'Birch', 'Chestnut', 'Spruce', 'Walnut', 'Lake', 'Hill', 'River',
  'Park', 'Sunset', 'Highland', 'Meadow', 'Forest', 'Spring', 'Ridge', 'Valley', 'Washington', 'Lincoln', 'Franklin',
  'Jefferson', 'Madison', 'Church', 'Market', 'Mill', 'Bridge', 'Station', 'Harbor', 'Orchard', 'Garden', 'Prospect'
]
const SUFFIXES = ['Street', 'Avenue', 'Road', 'Lane', 'Drive', 'Court', 'Place', 'Boulevard', 'Way', 'Terrace']
const CITIES = [
  'Springfield', 'Riverton', 'Fairview', 'Greenville', 'Bristol', 'Clinton', 'Georgetown', 'Salem', 'Madison', 'Franklin',
  'Ashland', 'Oxford', 'Milton', 'Newport', 'Arlington', 'Burlington', 'Dayton', 'Lexington', 'Manchester', 'Kingston',
  'Clayton', 'Dover', 'Hudson', 'Lakewood', 'Marion', 'Oakland', 'Plymouth', 'Richmond', 'Shelby', 'Troy', 'Winchester',
  'Brookfield', 'Cedar Falls', 'Elmwood', 'Glendale', 'Harrison', 'Jackson', 'Maplewood', 'Northfield', 'Westbury'
]
const COMPANY_A = ['Blue', 'Bright', 'Silver', 'North', 'Summit', 'Prime', 'Apex', 'Clear', 'Green', 'Iron', 'Swift', 'Nova', 'Atlas', 'Golden', 'Red', 'Polar', 'Urban', 'Global']
const COMPANY_B = ['River', 'Peak', 'Field', 'Stone', 'Bridge', 'Harbor', 'Wave', 'Leaf', 'Point', 'Gate', 'Works', 'Labs', 'Path', 'Forge', 'Line', 'Grid']
const COMPANY_C = ['Inc.', 'LLC', 'Ltd.', 'Group', 'Corp.', 'Partners', 'Holdings', 'Solutions', 'Systems', 'Co.']
const LOREM = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna ' +
  'aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute ' +
  'irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non ' +
  'proident sunt culpa qui officia deserunt mollit anim id est laborum'
).split(' ')
const DOMAINS = ['example.com', 'example.org', 'example.net']

const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)]
const digits = (rng: Rng, n: number): string => Array.from({ length: n }, () => Math.floor(rng() * 10)).join('')

function lorem(rng: Rng, original: unknown): string {
  const words = typeof original === 'string' ? original.trim().split(/\s+/).filter(Boolean).length : 8
  const n = Math.max(3, Math.min(60, words || 8))
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(pick(rng, LOREM))
  const text = out.join(' ')
  return `${text[0].toUpperCase()}${text.slice(1)}.`
}

/** Hex UUID (version 4 layout) from the generator. */
export function fakeUuid(rng: Rng): string {
  const h = Array.from({ length: 32 }, () => Math.floor(rng() * 16).toString(16))
  h[12] = '4'
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  const s = h.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

/** A realistic-looking value of the given kind. */
export function fakeValue(kind: FakeKind, rng: Rng, original?: unknown): string {
  switch (kind) {
    case 'firstName':
      return pick(rng, FIRST)
    case 'lastName':
      return pick(rng, LAST)
    case 'fullName':
      return `${pick(rng, FIRST)} ${pick(rng, LAST)}`
    case 'email': {
      const first = pick(rng, FIRST).toLowerCase()
      const last = pick(rng, LAST).toLowerCase()
      const style = Math.floor(rng() * 3)
      const local = style === 0 ? `${first}.${last}` : style === 1 ? `${first[0]}${last}` : `${first}${last[0]}`
      return `${local}${digits(rng, 2)}@${pick(rng, DOMAINS)}`
    }
    case 'phone':
      return `+1 (${2 + Math.floor(rng() * 8)}${digits(rng, 2)}) 555-${digits(rng, 4)}`
    case 'street':
      return `${1 + Math.floor(rng() * 9899)} ${pick(rng, STREETS)} ${pick(rng, SUFFIXES)}`
    case 'city':
      return pick(rng, CITIES)
    case 'company': {
      const a = pick(rng, COMPANY_A)
      const b = pick(rng, COMPANY_B)
      return rng() < 0.5 ? `${a}${b.toLowerCase()} ${pick(rng, COMPANY_C)}` : `${a} ${b} ${pick(rng, COMPANY_C)}`
    }
    case 'lorem':
      return lorem(rng, original)
    case 'uuid':
      return fakeUuid(rng)
  }
}
