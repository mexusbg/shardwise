// Captures the README screenshots: launches the built app against an in-memory MongoDB with sample shop data.
// Usage: npm run build && node scripts/readme-screens.mjs [outDir]   (default: screenshots/)
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { _electron as electron } from 'playwright'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, ObjectId, Decimal128, Int32, Double, BSON } from 'mongodb'

const outDir = resolve(process.argv[2] ?? 'screenshots')
mkdirSync(outDir, { recursive: true })
const only = (process.env.ONLY ?? '').split(',').filter(Boolean)
const W = 1440
const H = 900

// Deterministic pseudo-random numbers, so every run produces the same data.
let state = 42
const rnd = () => {
  state = (state + 0x6d2b79f5) | 0
  let t = Math.imul(state ^ (state >>> 15), 1 | state)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (a) => a[Math.floor(rnd() * a.length)]
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))

const first = ['Emma', 'Liam', 'Sofia', 'Noah', 'Mia', 'Lucas', 'Olivia', 'Mateo', 'Ava', 'Elias', 'Hannah', 'Leon', 'Chloe', 'Felix', 'Isabella', 'Jonas', 'Amelie', 'Hugo', 'Lena', 'Oscar', 'Nora', 'Theo', 'Clara', 'Marco', 'Julia', 'Viktor', 'Elena', 'David', 'Ines', 'Samuel']
const last = ['Müller', 'Rossi', 'García', 'Novak', 'Dubois', 'Jansen', 'Silva', 'Kowalski', 'Ivanova', 'Berg', 'Fischer', 'Romano', 'Martin', 'Petrov', 'Costa', 'Weber', 'Laurent', 'Horvat', 'Nielsen', 'Moreau']
const places = [
  ['Germany', 'Berlin'], ['Germany', 'Munich'], ['Germany', 'Hamburg'], ['France', 'Paris'], ['France', 'Lyon'], ['Italy', 'Milan'], ['Italy', 'Rome'],
  ['Spain', 'Madrid'], ['Spain', 'Barcelona'], ['Netherlands', 'Amsterdam'], ['Bulgaria', 'Sofia'], ['Poland', 'Warsaw'], ['Portugal', 'Lisbon'], ['Austria', 'Vienna']
]
const streets = ['Linden', 'Market', 'Station', 'Garden', 'River', 'Park', 'Church', 'Mill', 'Harbour', 'Castle']
const catalog = [
  ['KB-201', 'Mechanical keyboard', 'peripherals', 89.9], ['MS-110', 'Wireless mouse', 'peripherals', 24.5], ['MN-270', '27" 4K monitor', 'displays', 329],
  ['HD-050', 'Noise-cancelling headphones', 'audio', 179], ['DK-400', 'USB-C dock', 'accessories', 129], ['CM-020', 'HD webcam', 'peripherals', 59.9],
  ['SS-512', 'Portable SSD 1 TB', 'storage', 99], ['CH-300', 'Ergonomic chair', 'furniture', 349], ['LP-014', 'Laptop stand', 'accessories', 39.9],
  ['MC-090', 'USB microphone', 'audio', 119], ['LT-600', 'Desk lamp', 'furniture', 45], ['CB-002', 'USB-C cable 2 m', 'accessories', 12.9]
]
const day = 86400000
const now = Date.UTC(2026, 9, 20, 12)

async function seed(uri) {
  const client = await MongoClient.connect(uri)
  const db = client.db('shop')
  const customers = []
  for (let i = 0; i < 480; i++) {
    const fn = pick(first)
    const ln = pick(last)
    const [country, city] = pick(places)
    const plan = pick(['free', 'free', 'pro', 'pro', 'team'])
    const doc = {
      _id: new ObjectId(),
      name: `${fn} ${ln}`,
      email: `${fn}.${ln}${i}@example.com`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''),
      plan,
      country,
      address: { street: `${int(1, 120)} ${pick(streets)} Street`, city, postcode: String(int(10000, 99999)) },
      orders: new Int32(int(0, 24)),
      totalSpent: Decimal128.fromString((rnd() * 2400).toFixed(2)),
      signedUp: new Date(now - int(20, 900) * day),
      lastLogin: new Date(now - int(0, 60) * day - int(0, 86000) * 1000),
      tags: [plan === 'team' ? 'b2b' : 'b2c', ...(rnd() < 0.4 ? ['newsletter'] : []), ...(rnd() < 0.15 ? ['beta'] : [])],
      marketing: rnd() < 0.55
    }
    if (rnd() < 0.7) doc.phone = `+${int(30, 49)} ${int(100, 999)} ${int(100000, 999999)}`
    if (rnd() < 0.06) doc.orders = String(doc.orders) // a few legacy documents store the count as text
    customers.push(doc)
  }
  await db.collection('customers').insertMany(customers)
  await db.collection('customers').createIndex({ email: 1 }, { unique: true })
  await db.collection('customers').createIndex({ country: 1, plan: 1 })

  const orders = []
  for (let i = 0; i < 1800; i++) {
    const c = pick(customers)
    const items = Array.from({ length: int(1, 3) }, () => {
      const [sku, name, , price] = pick(catalog)
      return { sku, name, qty: new Int32(int(1, 3)), price: new Double(price) }
    })
    const total = Math.round(items.reduce((s, it) => s + it.qty.value * it.price.value, 0) * 100) / 100
    orders.push({
      number: `SO-${String(24000 + i)}`,
      customerId: c._id,
      status: pick(['new', 'paid', 'paid', 'shipped', 'shipped', 'delivered', 'delivered', 'delivered', 'cancelled']),
      items,
      total: new Double(total),
      currency: 'EUR',
      shipping: { method: pick(['standard', 'standard', 'express', 'pickup']), city: c.address.city, country: c.country },
      createdAt: new Date(now - int(0, 365) * day - int(0, 86000) * 1000)
    })
  }
  await db.collection('orders').insertMany(orders)
  await db.collection('orders').createIndex({ customerId: 1, createdAt: -1 })
  await db.collection('orders').createIndex({ status: 1, createdAt: -1 })

  await db.collection('products').insertMany(
    catalog.map(([sku, name, category, price], i) => ({ sku, name, category, price: new Double(price), stock: new Int32((i * 37) % 140), active: i !== 7 }))
  )
  await db.createCollection('vipCustomers', { viewOn: 'customers', pipeline: [{ $match: { plan: 'team' } }] })

  // A staging copy with a few differences, for Compare & sync.
  const staging = customers.slice(0, 460).map((c, i) => {
    const d = BSON.EJSON.deserialize(BSON.EJSON.serialize(c, { relaxed: false }), { relaxed: false })
    if (i % 41 === 3) d.plan = d.plan === 'pro' ? 'team' : 'pro'
    if (i % 57 === 5) d.address = { ...d.address, city: 'Sofia' }
    if (i % 73 === 9) delete d.phone
    return d
  })
  await client.db('staging').collection('customers').insertMany(staging)
  await client.db('analytics').collection('events').insertMany(Array.from({ length: 200 }, (_, i) => ({ type: pick(['view', 'click', 'search']), at: new Date(now - i * 60000) })))
  await client.close()
}

const server = await MongoMemoryServer.create()
const uri = server.getUri()
await seed(uri)
const port = Number(new URL(uri).port)

const conn = (id, name, color, extra = {}) => ({
  id,
  name,
  color,
  mode: 'standalone',
  hosts: [{ host: '127.0.0.1', port }],
  auth: { mechanism: 'none', authSource: 'admin' },
  tls: { enabled: false },
  ssh: { enabled: false, port: 22, method: 'password' },
  options: {},
  ...extra
})
const userData = mkdtempSync(join(tmpdir(), 'shardwise-shots-'))
writeFileSync(
  join(userData, 'shardwise.json'),
  JSON.stringify({
    version: 1,
    connections: [
      conn('local', 'Local development', '#13aa52'),
      {
        ...conn('atlas', 'Production cluster', '#d1242f', { folder: 'Cloud', mode: 'srv', srvHost: 'cluster0.example.mongodb.net' }),
        auth: { mechanism: 'DEFAULT', username: 'app', authSource: 'admin', askPassword: true },
        tls: { enabled: true, useSystemCA: true },
        readOnly: true
      },
      { ...conn('staging', 'Staging', '#bf8700', { folder: 'Cloud' }), ssh: { enabled: true, host: 'bastion.example.com', port: 22, username: 'deploy', method: 'key' } }
    ],
    settings: { pageSize: 50, toolsPath: '', queryTimeoutMS: 0, theme: 'dark', checkUpdates: false }
  })
)
writeFileSync(join(userData, 'window-state.json'), JSON.stringify({ bounds: { width: W, height: H }, maximized: false }))

const launch = process.env.E2E_EXE ? { executablePath: process.env.E2E_EXE } : { args: ['.'] }
const app = await electron.launch({ ...launch, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')), SHARDWISE_USER_DATA: userData } })
const win = await app.firstWindow()
await win.setViewportSize({ width: W, height: H }).catch(() => {})

const shot = async (name) => {
  await win.waitForTimeout(500)
  await win.screenshot({ path: join(outDir, `${name}.png`) })
  console.log('shot', name)
}
const step = async (name, fn) => {
  if (only.length && !only.includes(name)) return
  try {
    await fn()
    await shot(name)
  } catch (e) {
    console.log(`${name} failed: ${e.message.split('\n')[0]}`)
    await win.screenshot({ path: join(outDir, `${name}-failed.png`) })
    process.exitCode = 1
  }
}
const setEditor = async (locator, text) => {
  await locator.click()
  await win.keyboard.press('Control+A')
  await win.keyboard.insertText(text)
}
const menu = async (row, item) => {
  await win.locator('.tree-row', { hasText: row }).first().click({ button: 'right' })
  await win.locator('.ctx-item', { hasText: item }).first().click()
  await win.waitForTimeout(1500)
}
const dismissJobs = async () => {
  while (await win.locator('[title="Dismiss"]').count()) await win.locator('[title="Dismiss"]').first().click()
}
const toggleBuilder = () => win.locator('.qtab:visible [title="Toggle Filter Builder"]').click()
const closeTabs = async () => {
  while (await win.locator('.tab .close').count()) {
    await win.locator('.tab .close').first().click()
    await win.waitForTimeout(100)
  }
}
const openColl = async (coll) => {
  await win.locator('.tree-row', { hasText: new RegExp(`^${coll}`) }).first().dblclick()
  await win.waitForSelector('.qtab:visible .grid tbody tr td, .qtab:visible .tv-row')
}

try {
  await win.waitForSelector('.app')
  await win.waitForSelector('.modal', { timeout: 8000 })
  await step('connections', async () => {
    await win.locator('.list-row', { hasText: 'Local development' }).click()
  })
  await win.locator('.list-row', { hasText: 'Local development' }).dblclick()
  await win.waitForSelector('.modal', { state: 'detached' })
  await win.waitForSelector('.tree-row:has-text("shop")')
  await win.locator('.tree-row', { hasText: 'shop' }).first().dblclick()
  await win.waitForSelector('.tree-row:has-text("customers")')

  // Table view with the Filter Builder: the query typed in shell syntax shows up as builder rules.
  await step('query', async () => {
    await openColl('customers')
    const q = win.locator('.qtab:visible .querybar .cm-content')
    await setEditor(q.nth(0), "{ country: 'Germany', plan: { $in: ['pro', 'team'] }, totalSpent: { $gte: 500 } }")
    await setEditor(q.nth(1), '{ _id: 0, name: 1, plan: 1, orders: 1, totalSpent: 1 }')
    await setEditor(q.nth(2), '{ totalSpent: -1 }')
    await win.keyboard.press('Control+Enter')
    await win.waitForTimeout(1200)
    await win.locator('.qtab:visible .grid tbody tr').nth(1).locator('td').nth(2).click()
  })

  await step('tree', async () => {
    await setEditor(win.locator('.qtab:visible .querybar .cm-content').nth(1), '')
    await win.keyboard.press('Control+Enter')
    await win.waitForTimeout(800)
    await win.locator('.qtab:visible .segmented button', { hasText: 'Tree' }).click()
    await win.waitForSelector('.qtab:visible .tv-row')
    await win.locator('.qtab:visible .tv-row').first().dblclick()
    await win.waitForTimeout(300)
    const addr = win.locator('.qtab:visible .tv-row', { hasText: 'address' }).first()
    await addr.dblclick().catch(() => {})
    const tags = win.locator('.qtab:visible .tv-row', { hasText: 'tags' }).first()
    await tags.dblclick().catch(() => {})
  })

  await step('edit-document', async () => {
    await win.locator('.qtab:visible .segmented button', { hasText: 'Table' }).click()
    await win.locator('.qtab:visible .grid tbody tr').first().locator('td.rownum').click({ button: 'right' })
    await win.locator('.ctx-item', { hasText: 'Edit as JSON' }).click()
    await win.waitForSelector('.modal .cm-editor')
  })
  if (await win.locator('.modal').count()) await win.keyboard.press('Escape')

  await step('explain', async () => {
    await closeTabs()
    await openColl('orders')
    const q = win.locator('.qtab:visible .querybar .cm-content')
    await setEditor(q.nth(0), "{ status: 'shipped', 'shipping.country': 'Germany' }")
    await setEditor(q.nth(2), '{ createdAt: -1 }')
    await win.keyboard.press('Control+Enter')
    await win.waitForTimeout(800)
    await toggleBuilder()
    await win.locator('.qtab:visible .segmented button', { hasText: 'Explain' }).last().click()
    await win.waitForTimeout(1800)
  })

  await step('aggregation', async () => {
    await closeTabs()
    await menu('orders', 'Pipeline Editor')
    await win.locator('button', { hasText: 'Pipeline as text' }).click()
    await setEditor(
      win.locator('.agg-editor.text .cm-content'),
      [
        '[',
        "  { $match: { status: { $ne: 'cancelled' } } },",
        "  { $unwind: '$items' },",
        "  { $group: { _id: '$items.name', units: { $sum: '$items.qty' }, revenue: { $sum: { $multiply: ['$items.qty', '$items.price'] } } } },",
        "  { $set: { revenue: { $round: ['$revenue', 2] } } },",
        '  { $sort: { revenue: -1 } }',
        ']'
      ].join('\n')
    )
    await win.waitForTimeout(500)
    await win.locator('button', { hasText: 'Pipeline as text' }).click()
    await win.locator('.agg-left .stage, .agg-left [class*="stage"]', { hasText: '$group' }).first().click().catch(() => {})
    await win.keyboard.press('Control+Enter')
    await win.waitForTimeout(2000)
  })

  await step('schema', async () => {
    await closeTabs()
    await menu('customers', 'Schema Analysis')
    await win.waitForSelector('.sx-row')
    await win.locator('.sx-row', { hasText: /^\s*orders/ }).first().click()
    await win.waitForTimeout(500)
  })

  await step('playground', async () => {
    await closeTabs()
    await menu('shop', 'Open Playground')
    await win.waitForSelector('.cm-editor:visible')
    const code = [
      '// Mongoose models are created on the fly from the collection names.',
      "const since = new Date(Date.now() - 90 * 24 * 3600 * 1000)",
      '',
      'const top = await Order.aggregate([',
      "  { $match: { createdAt: { $gte: since }, status: { $ne: 'cancelled' } } },",
      "  { $group: { _id: '$customerId', orders: { $sum: 1 }, spent: { $sum: '$total' } } },",
      '  { $sort: { spent: -1 } },',
      '  { $limit: 10 },',
      "  { $lookup: { from: 'customers', localField: '_id', foreignField: '_id', as: 'customer' } },",
      '  { $project: {',
      "    _id: 0, name: { $first: '$customer.name' }, country: { $first: '$customer.country' },",
      "    orders: 1, spent: { $round: ['$spent', 2] }",
      '  } }',
      '])',
      "console.log(`${top.length} best customers since ${since.toDateString()}`)",
      'top'
    ].join('\n')
    await setEditor(win.locator('.cm-editor:visible .cm-content').first(), code)
    await win.keyboard.press('Escape')
    await win.keyboard.press('Control+Enter')
    await win.waitForTimeout(4500)
  })

  await step('shell', async () => {
    await closeTabs()
    await menu('shop', 'Open Shell')
    const input = win.locator('.cm-editor:visible .cm-content').last()
    for (const cmd of ['show collections', "db.orders.countDocuments({ status: 'delivered' })", "db.customers.find({ plan: 'team', country: 'France' }, { name: 1, email: 1, totalSpent: 1 }).limit(3)"]) {
      await input.click()
      await win.keyboard.insertText(cmd)
      await win.keyboard.press('Enter')
      await win.waitForTimeout(1200)
    }
  })

  await step('code', async () => {
    await closeTabs()
    await openColl('customers')
    const q = win.locator('.qtab:visible .querybar .cm-content')
    await setEditor(q.nth(0), "{ country: 'Germany', plan: { $in: ['pro', 'team'] }, totalSpent: { $gte: 500 } }")
    await setEditor(q.nth(2), '{ totalSpent: -1 }')
    await win.keyboard.press('Control+Enter')
    await win.waitForTimeout(800)
    await toggleBuilder()
    await win.locator('.qtab:visible .segmented button', { hasText: 'Code' }).first().click()
    await win.locator('.qtab:visible select').filter({ has: win.locator('option[value="python"]') }).first().selectOption('python')
    await win.waitForTimeout(600)
  })

  await step('indexes', async () => {
    await closeTabs()
    await menu('orders', 'Manage Indexes')
    await win.waitForTimeout(800)
  })

  await step('compare', async () => {
    await closeTabs()
    await menu('customers', 'Diff & Sync')
    const selects = win.locator('.cmp-target-pick select')
    await selects.nth(1).selectOption('staging')
    await win.waitForTimeout(600)
    await selects.nth(2).selectOption('customers')
    await win.locator('.cmp-head .btn.primary').click()
    await win.waitForTimeout(3000)
    await dismissJobs()
    await win.locator('.cmp-list-row, [class*="cmp-row"]', { hasText: 'plan' }).first().click().catch(() => {})
  })

  await step('migrate', async () => {
    await closeTabs()
    await menu('shop', 'Migrate to SQL')
    for (const c of ['customers', 'orders']) await win.locator('.mig-item', { hasText: c }).first().locator('input[type=checkbox]').check()
    await win.waitForTimeout(2500)
    await win.locator('.mig-foot button', { hasText: '.sql file' }).click()
    await win.locator('.mig-foot select[title="SQL dialect of the script"]').selectOption('postgres')
    await win.locator('.mig-item', { hasText: 'orders' }).first().click()
    await win.waitForTimeout(2500)
  })

  await step('light', async () => {
    await closeTabs()
    await win.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    await openColl('orders')
    await toggleBuilder()
    const q = win.locator('.qtab:visible .querybar .cm-content')
    await setEditor(q.nth(1), '{ _id: 0, number: 1, status: 1, total: 1, items: 1, shipping: 1, createdAt: 1 }')
    await setEditor(q.nth(2), '{ createdAt: -1 }')
    await win.keyboard.press('Control+Enter')
    await win.waitForTimeout(1200)
    await win.locator('.qtab:visible .grid tbody tr').nth(2).locator('td').nth(2).click()
  })
} catch (e) {
  console.error('FAILED:', e)
  await win.screenshot({ path: join(outDir, 'failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await app.close().catch(() => {})
  await server.stop()
}
