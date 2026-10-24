import type { BsonTypeName } from './bsonValue'
import type { FakeKind, MaskKind, MaskProfile, MaskRule } from './maskingApi'

export const MASK_LABELS: Record<MaskKind, string> = {
  keep: 'Keep',
  remove: 'Remove field',
  redact: 'Redact',
  partial: 'Partial mask',
  hash: 'Hash (SHA-256)',
  fake: 'Fake value',
  number: 'Random number',
  noise: 'Numeric noise ±%',
  dateShift: 'Shift date ±days',
  nullify: 'Set null',
  constant: 'Set constant'
}

export const FAKE_LABELS: Record<FakeKind, string> = {
  fullName: 'Full name',
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  phone: 'Phone',
  street: 'Street address',
  city: 'City',
  company: 'Company',
  lorem: 'Lorem text',
  uuid: 'UUID'
}

/** Default options of a rule kind. */
export function ruleDefaults(path: string, kind: MaskKind): MaskRule {
  switch (kind) {
    case 'redact':
      return { path, kind, text: '***' }
    case 'partial':
      return { path, kind, partial: 'chars', keepStart: 0, keepEnd: 4, maskChar: '*', keepSeparators: true }
    case 'fake':
      return { path, kind, fake: 'fullName', consistent: true }
    case 'number':
      return { path, kind, min: 0, max: 1000, decimals: 0, consistent: false }
    case 'noise':
      return { path, kind, percent: 10, consistent: false }
    case 'dateShift':
      return { path, kind, days: 30, consistent: false }
    case 'constant':
      return { path, kind, value: '' }
    default:
      return { path, kind }
  }
}

const NUMERIC = new Set<BsonTypeName>(['int', 'long', 'double', 'decimal'])

type Suggestion = { test: RegExp; rule: (path: string) => MaskRule; types?: (t: BsonTypeName) => boolean }

const fake = (fk: FakeKind) => (path: string): MaskRule => ({ path, kind: 'fake', fake: fk, consistent: true })
const partial = (keepStart: number, keepEnd: number, mode: 'chars' | 'email' = 'chars') => (path: string): MaskRule => ({
  path,
  kind: 'partial',
  partial: mode,
  keepStart,
  keepEnd,
  maskChar: '*',
  keepSeparators: true
})
const textual = (t: BsonTypeName): boolean => t === 'string'

/** First match wins; tested against the last path segment with separators removed (`first_name` → `firstname`). */
const SUGGESTIONS: Suggestion[] = [
  { test: /^(password|passwd|pwd|pass|passhash|passwordhash|secret|clientsecret|pin|otp|cvv|cvc)$/, rule: (path) => ({ path, kind: 'redact', text: '********' }) },
  { test: /(token|apikey|accesskey|secretkey|privatekey|refreshkey|sessionid|salt)$/, rule: (path) => ({ path, kind: 'redact', text: '***' }) },
  { test: /(ssn|socialsecurity|nationalid|taxid|passport)|^(nin|sin)$/, rule: partial(0, 4), types: textual },
  { test: /(^card|cardnumber|creditcard|^ccnumber$|^cc$|^pan$|iban|accountnumber|bankaccount)/, rule: partial(0, 4), types: textual },
  { test: /^(ip|ipaddress|ipv4|ipv6|remoteaddr|remoteip|clientip|lastip|userip)$/, rule: (path) => ({ path, kind: 'hash' }) },
  { test: /e?mail(address)?$/, rule: fake('email'), types: textual },
  { test: /^(firstname|fname|givenname|forename)$/, rule: fake('firstName'), types: textual },
  { test: /^(lastname|lname|surname|familyname)$/, rule: fake('lastName'), types: textual },
  { test: /^(name|fullname|displayname|contactname|customername|username|owner|author)$/, rule: fake('fullName'), types: textual },
  { test: /(phone|mobile|^cell$|telephone|^tel$|^fax$|msisdn)/, rule: partial(0, 4), types: textual },
  { test: /(street|address(line)?\d?$|^addr$|line1|line2)/, rule: fake('street'), types: textual },
  { test: /^(city|town|locality)$/, rule: fake('city'), types: textual },
  { test: /(zip|postal|postcode)/, rule: partial(2, 0), types: textual },
  { test: /(company|employer|organi[sz]ation|^org$|businessname)/, rule: fake('company'), types: textual },
  { test: /(birth|dob|birthday)/, rule: (path) => ({ path, kind: 'dateShift', days: 30, consistent: true }), types: (t) => t === 'date' },
  { test: /(salary|income|wage|balance|amount|price|revenue)/, rule: (path) => ({ path, kind: 'noise', percent: 10, consistent: false }), types: (t) => NUMERIC.has(t) },
  { test: /(lat|latitude|lng|lon|longitude)$/, rule: (path) => ({ path, kind: 'noise', percent: 1, consistent: false }), types: (t) => NUMERIC.has(t) },
  { test: /(note|notes|comment|comments|description|bio|message|remarks)$/, rule: fake('lorem'), types: textual },
  { test: /^(uuid|guid)$/, rule: fake('uuid') }
]

/** Suggested rule for a field from its name and dominant type; `keep` when nothing matches. */
export function suggestRule(path: string, type?: BsonTypeName): MaskRule {
  const segs = path.split('.').map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''))
  const name = segs[segs.length - 1]
  if (path === '_id' || name === 'id') return { path, kind: 'keep' }
  // Generic names (`cards.number`, `contact.value`) are matched together with their parent.
  const names = segs.length > 1 && /^(number|num|no|nr|value|val|code|text|digits)$/.test(name) ? [name, `${segs[segs.length - 2]}${name}`] : [name]
  for (const n of names)
    for (const s of SUGGESTIONS) {
      if (!s.test.test(n)) continue
      if (s.types && type && !s.types(type)) continue
      return s.rule(path)
    }
  return { path, kind: 'keep' }
}

/** Profiles saved before the rename used 'mongoguru-mask-profile'. */
export const isProfile = (v: unknown): v is MaskProfile =>
  !!v &&
  typeof v === 'object' &&
  ((v as { format?: string }).format === 'shardwise-mask-profile' || (v as { format?: string }).format === 'mongoguru-mask-profile') &&
  Array.isArray((v as MaskProfile).rules)

/** Random salt for new masking setups. */
export function randomSalt(): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
