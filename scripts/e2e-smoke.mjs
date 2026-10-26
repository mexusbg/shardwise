// Launches the built app against a seeded in-memory MongoDB and captures screenshots of the main screens.
// Usage: npm run build && node scripts/e2e-smoke.mjs [outDir]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { _electron as electron } from 'playwright'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { GridFSBucket, MongoClient, ObjectId, Decimal128, Long, Int32, Double } from 'mongodb'

const outDir = resolve(process.argv[2] ?? '.e2e/screens')
mkdirSync(outDir, { recursive: true })

const cities = ['Rome', 'Paris', 'Berlin', 'Madrid', 'Lisbon', 'Vienna', 'Prague', 'Athens']
const names = ['Ada', 'Linus', 'Grace', 'Alan', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Frances', 'Edsger', 'Radia', 'Tim']

async function seed(uri) {
  const client = await MongoClient.connect(uri)
  const db = client.db('shop')
  const customers = []
  for (let i = 0; i < 240; i++) {
    customers.push({
      _id: new ObjectId(),
      name: `${names[i % names.length]} ${String.fromCharCode(65 + (i % 26))}.`,
      email: `${names[i % names.length].toLowerCase()}${i}@example.com`,
      age: new Int32(18 + ((i * 7) % 60)),
      vip: i % 5 === 0,
      balance: Decimal128.fromString((i * 13.37).toFixed(2)),
      visits: Long.fromNumber(i * 1000 + 7),
      score: new Double(Math.round((i % 17) * 5.75 * 100) / 100),
      signedUp: new Date(Date.UTC(2023, i % 12, (i % 27) + 1, 9, 30)),
      address: { street: `${i + 1} Main St`, city: cities[i % cities.length], zip: String(10000 + i), geo: { lat: 41.9 + i / 1000, lng: 12.5 - i / 1000 } },
      tags: ['newsletter', i % 2 ? 'mobile' : 'web', ...(i % 5 === 0 ? ['vip'] : [])],
      lastOrder: i % 4 === 0 ? null : new Date(Date.UTC(2026, 9, (i % 20) + 1))
    })
  }
  await db.collection('customers').insertMany(customers)
  const orders = []
  for (let i = 0; i < 120; i++) {
    orders.push({
      customerId: customers[i % customers.length]._id,
      status: ['new', 'paid', 'shipped', 'delivered'][i % 4],
      items: [
        { sku: `SKU-${100 + (i % 9)}`, qty: new Int32((i % 3) + 1), price: new Double(9.99 + (i % 5)) },
        { sku: `SKU-${200 + (i % 7)}`, qty: new Int32(1), price: new Double(24.5) }
      ],
      total: new Double(35.48 + (i % 5)),
      createdAt: new Date(Date.UTC(2026, 8, (i % 28) + 1, i % 24))
    })
  }
  await db.collection('orders').insertMany(orders)
  await db.collection('products').insertMany(
    Array.from({ length: 30 }, (_, i) => ({ sku: `SKU-${100 + i}`, title: `Product ${i}`, stock: new Int32(i * 3), active: i % 3 !== 0 }))
  )
  await db.createCollection('vipCustomers', { viewOn: 'customers', pipeline: [{ $match: { vip: true } }] })
  // One document with a 200,000-character string (document editor with very long lines).
  await client.db('analytics').collection('notes').insertOne({ title: 'long', body: 'Ж'.repeat(200000) })
  await client.db('analytics').collection('events').insertMany(Array.from({ length: 50 }, (_, i) => ({ type: 'click', at: new Date(), n: i })))
  // A GridFS bucket for the file browser screen.
  const bucket = new GridFSBucket(client.db('analytics'))
  const upload = (name, data, contentType) =>
    new Promise((resolve, reject) => bucket.openUploadStream(name, { metadata: { contentType } }).on('finish', resolve).on('error', reject).end(data))
  await upload('logo.png', readFileSync(resolve('build/icon.png')), 'image/png')
  const rows = Array.from({ length: 31 }, (_, i) => `${i + 1},${(i * 37) % 500}`)
  await upload('report-2026-10.csv', ['day,clicks', ...rows].join('\n'), 'text/csv')
  await upload('notes.txt', 'Quarterly numbers are in report-2026-10.csv.', 'text/plain')
  await client.close()
}

const server = await MongoMemoryServer.create()
const uri = server.getUri()
await seed(uri)
const port = Number(new URL(uri).port)

const userData = mkdtempSync(join(tmpdir(), 'shardwise-e2e-'))
writeFileSync(
  join(userData, 'shardwise.json'),
  JSON.stringify({
    version: 1,
    connections: [
      {
        id: 'demo',
        name: 'Local demo',
        color: '#13aa52',
        mode: 'standalone',
        hosts: [{ host: '127.0.0.1', port }],
        auth: { mechanism: 'none', authSource: 'admin' },
        tls: { enabled: false },
        ssh: { enabled: false, port: 22, method: 'password' },
        options: {}
      },
      {
        id: 'atlas',
        name: 'Production (Atlas)',
        color: '#d1242f',
        folder: 'Cloud',
        mode: 'srv',
        srvHost: 'cluster0.example.mongodb.net',
        hosts: [{ host: 'localhost', port: 27017 }],
        auth: { mechanism: 'DEFAULT', username: 'app', authSource: 'admin', askPassword: true },
        tls: { enabled: true, useSystemCA: true },
        ssh: { enabled: false, port: 22, method: 'password' },
        options: {
          readPreference: 'nearest',
          readPreferenceTags: ['region:eu-west', ''],
          maxPoolSize: 20,
          retryWrites: true,
          compressors: ['zlib'],
          writeConcern: { w: 'majority', wtimeoutMS: 5000 }
        }
      },
      {
        id: 'reporting',
        name: 'Reporting (read-only)',
        color: '#bf8700',
        mode: 'standalone',
        hosts: [{ host: '127.0.0.1', port }],
        auth: { mechanism: 'none', authSource: 'admin' },
        tls: { enabled: false },
        ssh: { enabled: false, port: 22, method: 'password' },
        options: {},
        readOnly: true,
        databases: { mode: 'auto', names: ['archive'] },
        overrides: { pageSize: 20, changeHistory: false }
      }
    ],
    settings: { pageSize: 50, toolsPath: '', queryTimeoutMS: 0, theme: process.env.THEME ?? 'dark' }
  })
)
writeFileSync(join(userData, 'window-state.json'), JSON.stringify({ bounds: { width: 1500, height: 920 }, maximized: false }))

// E2E_EXE=path/to/Shardwise.exe runs the packaged app instead of the dev build; E2E_ARGS adds switches
// (e.g. --no-sandbox for an unpacked Linux build, whose chrome-sandbox is not setuid root).
const extraArgs = (process.env.E2E_ARGS ?? '').split(' ').filter(Boolean)
const launch = process.env.E2E_EXE ? { executablePath: process.env.E2E_EXE, args: extraArgs } : { args: ['.', ...extraArgs] }
const app = await electron.launch({ ...launch, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')), SHARDWISE_USER_DATA: userData } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.stack ?? String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 1500)))
await win.setViewportSize({ width: 1500, height: 920 }).catch(() => {})
// Visible controls that end within EDGE_PX of the window's right edge (cramped against it), per screen.
const EDGE_PX = Number(process.env.E2E_EDGE_PX) || 8
const edgeReport = new Map()
const checkRightEdge = async (name) => {
  const hits = await win
    .evaluate((edge) => {
      const w = document.documentElement.clientWidth
      const out = []
      for (const el of document.querySelectorAll('button, input, select, .btn, .badge, .chip, [role="button"]')) {
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height || r.right <= 0) continue
        const cs = window.getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none') continue
        if (r.right > w - edge && r.left < w) {
          const label = (el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.tagName).trim().slice(0, 40)
          const parent = el.parentElement?.className?.toString().split(' ')[0] ?? ''
          out.push(`${label} [${parent}] right=${Math.round(w - r.right)}px`)
        }
      }
      return out
    }, EDGE_PX)
    .catch(() => [])
  if (hits.length) edgeReport.set(name, hits)
}
const shot = async (name) => {
  await win.waitForTimeout(350)
  await checkRightEdge(name)
  await win.screenshot({ path: join(outDir, `${name}.png`) })
  console.log('shot', name)
}

try {
  await win.waitForSelector('.app')
  // Settings → Workspace → Connection Manager at launch (on by default, no session to restore here).
  const startupManager = await win.waitForSelector('.modal', { timeout: 8000 }).then(
    () => true,
    () => false
  )
  console.log('connection manager opened at launch:', startupManager)
  if (!startupManager) throw new Error('The Connection Manager did not open at launch')
  await win.keyboard.press('Escape')
  await win.waitForSelector('.modal', { state: 'detached' })
  await shot('01-welcome')

  await win.getByRole('button', { name: 'Connect', exact: true }).first().click()
  await win.waitForSelector('.modal')
  await shot('02-connection-manager')
  await win.locator('.list-row', { hasText: 'Production (Atlas)' }).click()
  await win.getByRole('button', { name: 'Edit' }).click()
  await win.waitForSelector('text=Import from URI')
  await shot('03-connection-editor')
  await win.getByRole('button', { name: 'SSH tunnel' }).click()
  await shot('03b-connection-editor-ssh')
  await win.locator('.modal .side-tabs button', { hasText: 'Driver' }).click()
  await shot('03c-connection-editor-driver')
  await win.locator('.modal .side-tabs button', { hasText: 'Behavior' }).click()
  await shot('03d-connection-editor-behavior')
  await win.locator('.modal .side-tabs button', { hasText: 'Proxy' }).click()
  await win.locator('.modal .segmented button', { hasText: 'Custom' }).click()
  await win.locator('.modal input[aria-label="Proxy host"]').fill('proxy.corp.example')
  await win.locator('.modal input[aria-label="Proxy port"]').fill('3128')
  await shot('03f-connection-editor-proxy')
  await win.locator('.modal .side-tabs button', { hasText: 'Authentication' }).click()
  await shot('03e-connection-editor-ask-password')
  await win.keyboard.press('Escape')
  // "Ask each time": connecting prompts for the password (cancelled here; the host does not exist).
  await win.locator('.list-row', { hasText: 'Production (Atlas)' }).dblclick()
  await win.waitForSelector('.modal input[data-secret="password"]')
  await shot('02b-password-prompt')
  await win.locator('.modal .btn', { hasText: 'Cancel' }).click()
  await win.waitForSelector('.modal', { state: 'detached' })
  await win.getByRole('button', { name: 'Connect', exact: true }).first().click()
  await win.waitForSelector('.modal .list-row')
  await win.locator('.list-row', { hasText: 'Local demo' }).dblclick()

  await win.waitForSelector('.tree-row:has-text("shop")')
  await win.locator('.tree-row', { hasText: 'shop' }).dblclick()
  await win.waitForSelector('.tree-row:has-text("customers")')
  await win.locator('.tree-row', { hasText: 'customers' }).first().dblclick()
  await win.waitForSelector('.grid tbody tr td')
  await shot('04-table-view')

  // Tree type-to-jump: from "customers", p → products; after a pause o → orders, o again wraps back to
  // orders (orders_copy only appears after the import further down).
  const treeSelected = async () => {
    await win.waitForTimeout(120)
    return ((await win.locator('.tree-row.selected .label').textContent().catch(() => '')) ?? '').trim()
  }
  await win.locator('.tree-row', { hasText: 'customers' }).first().click()
  await win.keyboard.press('p')
  const jumpP = await treeSelected()
  await win.waitForTimeout(800)
  await win.keyboard.press('o')
  const jumpO = await treeSelected()
  await win.keyboard.press('o')
  const jumpOO = await treeSelected()
  console.log('tree type-ahead:', jumpP === 'products' && jumpO === 'orders' && jumpOO === 'orders', `(${jumpP}, ${jumpO}, ${jumpOO})`)
  if (jumpP !== 'products' || jumpO !== 'orders' || jumpOO !== 'orders') throw new Error('Tree type-ahead did not select the expected collections')

  // Filter Builder: shown when a collection opens (Settings → Browsing data); add rules via context menus on cells.
  const builderOnOpen = (await win.locator('.qtab:visible .vqb').count()) > 0
  console.log('filter builder open by default:', builderOnOpen)
  if (!builderOnOpen) throw new Error('The Filter Builder was not shown in a new collection tab')
  await win.waitForSelector('.vqb')
  // Drag a cell value (name) into the builder, then add 'vip' from the column header menu.
  await win.locator('.grid tbody tr').nth(1).locator('td').nth(2).dragTo(win.locator('.vqb-drop').first())
  await win.locator('.grid th', { hasText: 'age' }).first().click({ button: 'right' })
  await win.locator('.ctx-item', { hasText: 'Add to Filter Builder' }).click()
  await shot('05-vqb')
  const ageRule = win.locator('.vqb-rule').nth(1)
  await ageRule.locator('.vqb-op select').selectOption('gte').catch(() => {})
  await ageRule.locator('input.input').last().fill('30').catch(() => {})
  // Enter in a value box runs the query (only Linus B. aged 37 matches).
  await ageRule.locator('input.input').last().press('Enter')
  await win.waitForTimeout(600)
  const enterRan = (await win.locator('.grid tbody tr').count()) === 1
  console.log('enter in value runs query:', enterRan)
  if (!enterRan) throw new Error('Enter in a builder value did not run the query')
  await shot('05b-vqb-run')

  await win.locator('.segmented button', { hasText: 'Tree' }).click()
  await win.waitForSelector('.tv-row')
  await win.locator('.tv-row').first().dblclick()
  await shot('06-tree-view')
  await win.locator('.segmented button', { hasText: 'JSON' }).click()
  await shot('07-json-view')
  await win.locator('.segmented button', { hasText: 'Table' }).click()

  // Drag column headers into the builder sections: filter adds a condition, Fields a projection, Order a sort.
  const vqbSection = (id) => win.locator(`.vqb-card[data-section="${id}"]`)
  const header = (path) => win.locator(`.grid th[title="${path}"]`).first()
  const rulesBefore = await win.locator('.vqb-rule').count()
  await header('vip').dragTo(vqbSection('filter').locator('.vqb-drop').last())
  await win.waitForTimeout(200)
  const filterDrop = (await win.locator('.vqb-rule').count()) === rulesBefore + 1
  console.log('drag header → filter:', filterDrop)
  if (!filterDrop) throw new Error('Dragging the vip header onto the filter did not add a condition')
  const barText = async (i) => ((await win.locator('.qrow2 .cm-content').nth(i).textContent()) ?? '').trim()
  await header('email').dragTo(vqbSection('fields').locator('.vqb-drop').last())
  await win.waitForTimeout(200)
  const projectionDrop = (await barText(0)).includes('email')
  console.log('drag header → fields:', projectionDrop, await barText(0))
  if (!projectionDrop) throw new Error('Dragging the email header onto Fields did not update the projection')
  await header('age').dragTo(vqbSection('order').locator('.vqb-drop').last())
  await win.waitForTimeout(200)
  const sortDrop = (await barText(1)).includes('age')
  console.log('drag header → order:', sortDrop, await barText(1))
  if (!sortDrop) throw new Error('Dragging the age header onto Order did not update the sort')
  await shot('05c-vqb-drag-headers')

  // Header click sorting (asc, then desc) after clearing the builder query.
  await win.locator('.vqb').getByRole('button', { name: 'Clear' }).click()
  const ageHeader = win.locator('.grid th', { hasText: /^age/ }).first()
  await ageHeader.click()
  await win.waitForTimeout(400)
  await ageHeader.click()
  await win.waitForTimeout(500)
  await shot('13-header-sort')

  // Collation: Bulgarian, case-insensitive (strength 2), from the query bar chip; header sorting keeps it.
  await win.locator('.qtab:visible [data-testid="collation-chip"]').click()
  await win.waitForSelector('[data-testid="collation-popover"]')
  await win.locator('[data-testid="collation-locale"]').selectOption('bg')
  await win.locator('[data-testid="collation-strength"]').selectOption('2')
  await shot('13b-collation')
  await win.locator('[data-testid="collation-popover"] .btn.primary', { hasText: 'Run' }).click()
  await win.waitForTimeout(600)
  const chipText = (await win.locator('.qtab:visible [data-testid="collation-chip"]').textContent())?.trim()
  const runError = await win.locator('.qtab:visible .qerr, .qtab:visible .notice.error').count()
  console.log('collation chip:', chipText, 'errors:', runError)
  if (chipText !== 'bg · 2' || runError) throw new Error(`Collation was not applied (chip "${chipText}", ${runError} errors)`)

  // Save the query as the collection default and open the collection again: the default is applied.
  await win.locator('[title^="Default query"]').first().click()
  await win.locator('.ctx-item', { hasText: 'Save as default for collection' }).click()
  await win.locator('.tree-row', { hasText: 'customers' }).first().dblclick()
  await win.waitForTimeout(1000)
  const sortApplied = await win.evaluate(() => [...document.querySelectorAll('.qtab')].some((q) => q.getBoundingClientRect().width > 0 && (q.textContent ?? '').includes('age: -1')))
  console.log('default query applied in new tab:', sortApplied)
  if (!sortApplied) throw new Error('Default query was not applied to the new tab')
  const defaultChip = (await win.locator('.qtab:visible [data-testid="collation-chip"]').textContent())?.trim()
  console.log('default query collation:', defaultChip)
  if (defaultChip !== 'bg · 2') throw new Error(`The default query did not restore its collation (chip "${defaultChip}")`)
  await shot('14-default-query')
  await win.locator('.tab.active .close').click()

  // Step into address
  await win.locator('.grid th', { hasText: 'address' }).first().dblclick()
  await shot('08-step-into')

  // Edit document dialog via row context menu
  await win.locator('.grid tbody tr').first().locator('td.rownum').click({ button: 'right' })
  await shot('09-context-menu')
  await win.locator('.ctx-item', { hasText: 'Edit as JSON' }).click()
  await win.waitForSelector('.modal .cm-editor')
  await shot('10-edit-document')
  // Ctrl+F in the document editor: find panel with highlighted matches; Escape closes the panel, not the dialog.
  await win.locator('.modal .cm-content').click()
  await win.keyboard.press('Control+f')
  await win.waitForSelector('.modal .cm-search input[name=search]')
  await win.keyboard.insertText('address')
  await win.keyboard.press('Enter')
  const findHits = await win.locator('.modal .cm-searchMatch').count()
  await shot('10-edit-document-find')
  await win.keyboard.press('Escape')
  await win.waitForTimeout(200)
  const findClosed = (await win.locator('.modal .cm-search').count()) === 0 && (await win.locator('.modal').count()) > 0
  console.log('find in document:', findHits > 0 && findClosed, `(${findHits} matches)`)
  if (!(findHits > 0 && findClosed)) throw new Error('Ctrl+F in the document editor did not find, or Escape closed the dialog')
  // Save a real change (recorded by Change History, shown later in 37-change-history).
  await win.locator('.modal .cm-content').click()
  await win.keyboard.press('Control+Home')
  await win.keyboard.press('End')
  await win.keyboard.press('Enter')
  await win.keyboard.insertText('vip: true,')
  await win.locator('.modal .btn.primary', { hasText: 'Update' }).click()
  await win.waitForTimeout(800)
  if (await win.locator('.modal').count()) await win.keyboard.press('Escape')

  // Show as JSON (Ctrl+Shift+J) is read-only but focusable: Ctrl+F opens the find panel in it.
  await win.locator('.qtab:visible .grid tbody tr').nth(1).locator('td.rownum').click()
  await win.keyboard.press('Control+Shift+J')
  await win.waitForSelector('.modal .cm-editor')
  await win.keyboard.press('Control+f')
  const showJsonFind = await win
    .waitForSelector('.modal .cm-search', { timeout: 3000 })
    .then(() => true)
    .catch(() => false)
  console.log('show as json + find:', showJsonFind)
  await win.keyboard.press('Escape')
  await win.keyboard.press('Escape')
  if (!showJsonFind) throw new Error('Ctrl+Shift+J / Ctrl+F did not open the find panel in Show as JSON')

  // Update Documents dialog on the selected row: $set a new field (the table is stepped into `address` here,
  // so the result is read from the success message).
  await win.locator('.qtab:visible .grid tbody tr').first().locator('td.rownum').click()
  await win.locator('.qtab:visible [title^="Update documents"]').click()
  await win.waitForSelector('.modal .cm-editor')
  await win.locator('.modal .cm-content').click()
  await win.keyboard.press('Control+a')
  await win.keyboard.insertText("{ $set: { tier: 'gold' } }")
  await win.waitForSelector('.modal .ud-affected:has-text("1 document will be updated")', { timeout: 5000 })
  await shot('10c-update-documents')
  await win.locator('.modal .btn.primary', { hasText: 'Update' }).click()
  await win.waitForSelector('.modal', { state: 'detached' })
  const updated = await win
    .waitForSelector('.toast.success:has-text("1 document matched, 1 modified")', { timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  console.log('update documents dialog:', updated)
  if (!updated) throw new Error('The Update Documents dialog did not update the selected document')

  // The Filter Builder is wider after dragging its left edge.
  const vqbWidth = async () => (await win.locator('.qtab:visible .vqb').boundingBox())?.width ?? 0
  const w0 = await vqbWidth()
  const edge = await win.locator('.qtab:visible .vqb-splitter').boundingBox()
  await win.mouse.move(edge.x + 3, edge.y + 200)
  await win.mouse.down()
  await win.mouse.move(edge.x - 117, edge.y + 200, { steps: 5 })
  await win.mouse.up()
  const w1 = await vqbWidth()
  console.log('filter builder resized:', w1 - w0 > 100, `(${Math.round(w0)} → ${Math.round(w1)})`)
  if (w1 - w0 <= 100) throw new Error('Dragging the Filter Builder edge did not resize it')
  await win.locator('.qtab:visible .vqb-splitter').dblclick()

  // Ctrl+P: go to a collection by name.
  await win.keyboard.press('Control+p')
  await win.waitForSelector('.modal .qo-row')
  await win.keyboard.insertText('prod')
  await shot('10d-go-to-collection')
  await win.keyboard.press('Enter')
  await win.waitForSelector('.modal', { state: 'detached' })
  const quickOpened = ((await win.locator('.tab.active').textContent()) ?? '').includes('products')
  console.log('ctrl+p go to collection:', quickOpened)
  if (!quickOpened) throw new Error('Ctrl+P did not open the products collection')
  await win.locator('.tab.active .close').click()
  await win.locator('.tab', { hasText: 'customers' }).first().click()

  // Export orders to JSON and to a BSON archive (bundled mongodump), then import the JSON into a new collection.
  const exportDir = mkdtempSync(join(tmpdir(), 'shardwise-export-'))
  const waitFile = async (f) => {
    for (let i = 0; i < 60; i++) {
      if (existsSync(f) && statSync(f).size > 0) return
      await win.waitForTimeout(500)
    }
    throw new Error(`Export did not produce ${f}`)
  }
  const openExport = async () => {
    await win.locator('.tree-row', { hasText: 'orders' }).first().click({ button: 'right' })
    await win.locator('.ctx-item', { hasText: 'Export' }).first().click()
    await win.waitForSelector('.modal')
  }
  await openExport()
  const jsonFile = join(exportDir, 'orders.json')
  await win.locator('.modal input.mono').last().fill(jsonFile)
  await shot('11-export')
  await win.getByRole('button', { name: 'Start export' }).click()
  await waitFile(jsonFile)
  await openExport()
  await win.locator('.modal button', { hasText: 'BSON archive' }).click()
  const archive = join(exportDir, 'shop.archive')
  await win.locator('.modal input.mono').last().fill(archive)
  await win.waitForTimeout(800)
  await shot('11b-export-bson')
  await win.getByRole('button', { name: 'Start export' }).click()
  await waitFile(archive)
  await win.waitForTimeout(1500)
  await shot('15-jobs')

  await win.locator('.toolbar button', { hasText: 'Import' }).click()
  await win.waitForSelector('.modal')
  const src = win.locator('.modal input.mono').first()
  await src.fill(jsonFile)
  await src.press('Enter')
  await win.waitForTimeout(1200)
  await win.locator('.modal input[placeholder="Existing or new collection"]').fill('orders_copy')
  await shot('16-import')
  await win.getByRole('button', { name: 'Start import' }).click()
  let imported = false
  for (let i = 0; i < 40 && !imported; i++) {
    await win.waitForTimeout(500)
    imported = (await win.locator('.tree-row', { hasText: 'orders_copy' }).count()) > 0
  }
  console.log('import created orders_copy:', imported)
  if (!imported) throw new Error('Import did not create orders_copy')
  await shot('17-after-import')

  // Export from a document's context menu: the query result, this page, the selection or the whole collection.
  {
    await win.locator('.tree-row', { hasText: 'orders' }).first().dblclick()
    await win.waitForSelector('.qtab:visible .grid tbody tr td')
    const q = win.locator('.qtab:visible .querybar .cm-content')
    await q.nth(0).click()
    await win.keyboard.press('Control+A')
    await win.keyboard.insertText("{ status: 'paid' }")
    await win.keyboard.press('Control+Enter')
    await win.waitForTimeout(800)
    await win.locator('.qtab:visible .grid tbody tr').first().locator('td.rownum').click({ button: 'right' })
    await win.locator('.ctx-item', { hasText: 'Export…' }).click()
    await win.waitForSelector('.modal .tr-scopes')
    await win.waitForSelector('.modal .tr-scopes button:has-text("Query result (30)")', { timeout: 5000 }).catch(() => {})
    const scopes = await win.locator('.modal .tr-scopes button').allTextContents()
    const preselected = ((await win.locator('.modal .tr-scopes button.on').textContent()) ?? '').trim()
    await win.locator('.modal .tr-format', { hasText: 'CSV' }).click()
    await win.locator('.modal .tr-scopes button', { hasText: 'This page' }).click()
    const pageFile = join(exportDir, 'paid-page.csv')
    await win.locator('.modal input.mono').last().fill(pageFile)
    await shot('17b-export-from-document')
    await win.getByRole('button', { name: 'Start export' }).click()
    await waitFile(pageFile)
    await win.waitForTimeout(500)
    const rows = readFileSync(pageFile, 'utf8').trim().split(/\r?\n/)
    const paidOnly = rows.slice(1).every((r) => r.includes('paid'))
    const ok = scopes.length === 4 && preselected.startsWith('Query result') && rows.length === 31 && paidOnly
    console.log('export from document menu:', ok, `(scopes: ${scopes.join(' | ')}; preselected: ${preselected}; ${rows.length - 1} rows)`)
    if (!ok) throw new Error('Export from the document menu did not write this page of the query result')
    await win.locator('.tab.active .close').click()
  }

  // Explain plan of the current query
  await win.locator('.tree-row', { hasText: 'customers' }).first().dblclick()
  await win.waitForSelector('.grid tbody tr td')
  await win.locator('.segmented button', { hasText: 'Explain' }).last().click()
  await win.waitForTimeout(1500)
  await shot('18-explain')

  // Query profiler: enable for all operations, run a query, look at the entries
  await win.locator('.tree-row', { hasText: 'shop' }).first().click({ button: 'right' })
  await win.locator('.ctx-item', { hasText: 'Query Profiler' }).click()
  await win.waitForTimeout(1200)
  await win.locator('button:visible', { hasText: /^All$/ }).first().click().catch(() => {})
  await win.locator('button:visible', { hasText: 'Apply' }).first().click().catch(() => {})
  await win.waitForTimeout(800)
  await win.locator('.tab', { hasText: 'customers' }).first().click()
  await win.locator('.querybar:visible button', { hasText: 'Run' }).first().click()
  await win.waitForTimeout(800)
  await win.locator('.tab', { hasText: 'Profiler' }).first().click()
  await win.locator('button:visible', { hasText: 'Refresh' }).first().click().catch(() => {})
  await win.waitForTimeout(1200)
  await shot('19-profiler')
  await win.locator('button:visible', { hasText: 'Index suggestions' }).first().click()
  await win.waitForTimeout(1200)
  await shot('19b-index-suggestions')

  // Playground: Mongoose auto-model + TypeScript
  await win.locator('.tree-row', { hasText: 'shop' }).first().click({ button: 'right' })
  await win.locator('.ctx-item', { hasText: 'Open Playground' }).click()
  await win.waitForSelector('.pg-root .cm-editor, .cm-editor:visible')
  await win.waitForTimeout(500)
  const code = [
    'const vip = await Customer.find({ vip: true }).sort({ age: -1 }).limit(5).lean()',
    "console.log('vip customers:', vip.length)",
    'db.orders.aggregate([{ $group: { _id: "$status", n: { $sum: 1 }, total: { $sum: "$total" } } }, { $sort: { n: -1 } }])'
  ].join('\n')
  await win.locator('.cm-editor:visible .cm-content').first().click()
  await win.keyboard.press('Control+A')
  await win.keyboard.insertText(code)
  await win.keyboard.press('Control+Enter')
  await win.waitForTimeout(4000)
  await shot('20-playground')

  // Phase 2 / 3 tools, one screenshot each (opened from the collection / database context menus).
  const collMenu = async (coll, item) => {
    await win.locator('.tree-row', { hasText: coll }).first().click({ button: 'right' })
    await win.locator('.ctx-item', { hasText: item }).first().click()
    await win.waitForTimeout(2500)
  }
  const dbMenu = async (db, item) => {
    await win.locator('.tree-row', { hasText: db }).first().click({ button: 'right' })
    await win.locator('.ctx-item', { hasText: item }).first().click()
    await win.waitForTimeout(2500)
  }
  const tool = async (name, fn) => {
    try {
      await fn()
      await shot(name)
    } catch (e) {
      console.log(`tool ${name} failed: ${e.message.split('\n')[0]}`)
      await shot(`${name}-failed`)
      await win.keyboard.press('Escape').catch(() => {})
    }
  }
  await tool('21-aggregation', () => collMenu('orders', 'Pipeline Editor'))
  await tool('22-indexes', () => collMenu('customers', 'Manage Indexes'))
  await tool('23-schema', () => collMenu('customers', 'Schema Analysis'))
  await tool('24-sql', async () => {
    await collMenu('orders', 'SQL Query')
    await win.keyboard.press('Control+Enter')
    await win.waitForTimeout(1500)
  })
  await tool('25-shell', async () => {
    await dbMenu('shop', 'Open Shell')
    await win.locator('.cm-editor:visible .cm-content').last().click()
    await win.keyboard.insertText('db.orders.find({ status: "paid" }).limit(3)')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(1500)
  })
  // Destructive shell commands wait for approval (Settings → Shell & Playground → Ask before running).
  await tool('25b-shell-confirm', async () => {
    await win.locator('.cm-editor:visible .cm-content').last().click()
    await win.keyboard.insertText('db.products.drop()')
    await win.keyboard.press('Enter')
    await win.waitForSelector('[data-testid="shell-confirm-deny"]', { timeout: 8000 })
  })
  {
    const deny = win.locator('[data-testid="shell-confirm-deny"]')
    const asked = await deny.isVisible().catch(() => false)
    console.log('shell asked before db.products.drop():', asked)
    if (!asked) throw new Error('The shell did not ask before dropping a collection')
    await deny.click()
    const declined = await win
      .waitForSelector('.sh-error-head:has-text("was declined")', { timeout: 8000 })
      .then(() => true)
      .catch(() => false)
    console.log('declined drop reported:', declined)
    if (!declined) throw new Error('The declined drop was not reported in the shell')
  }
  await tool('26-users', () => dbMenu('shop', 'Users & Roles'))
  await tool('27-query-manager', () => collMenu('customers', 'Query Library'))
  await tool('28-compare', () => collMenu('orders', 'Diff & Sync'))
  await tool('30-migrate-to-sql', () => dbMenu('shop', 'Migrate to SQL'))
  await tool('31-import-from-sql', () => dbMenu('shop', 'Import from SQL'))
  await tool('32-masking', () => collMenu('customers', 'Data Masking'))
  await tool('33-reschema', () => collMenu('customers', 'Restructure Fields'))
  await tool('34-assistant', async () => {
    await win.locator('.toolbar button', { hasText: 'Assistant' }).click()
    await win.waitForTimeout(800)
  })
  await tool('35-prefs-ai', async () => {
    await win.locator('.toolbar button', { hasText: 'Assistant' }).click()
    await win.locator('[title="Settings"]').click()
    await win.locator('.modal .pref-nav button', { hasText: 'AI & automation' }).click()
    await win.waitForTimeout(600)
  })
  // Other AI providers: OpenAI-compatible service (Ollama on this computer needs no key), then back to Claude.
  await tool('35b-prefs-ai-compatible', async () => {
    await win.locator('.modal .ai-settings .segmented button', { hasText: 'OpenAI-compatible' }).click()
    await win.locator('.modal .ai-settings select').first().selectOption('ollama')
    await win.waitForTimeout(600)
  })
  {
    const address = await win.locator('.modal .ai-settings input.mono').first().inputValue()
    const keyHint = await win.locator('.modal .ai-settings input[type=password]').getAttribute('placeholder')
    const ok = address === 'http://localhost:11434/v1' && /Not needed/.test(keyHint ?? '')
    console.log('ai provider ollama:', ok, `(${address})`)
    await win.locator('.modal .ai-settings .segmented button', { hasText: 'Claude (Anthropic)' }).click()
    await win.waitForTimeout(300)
    if (!ok) throw new Error('Choosing an OpenAI-compatible provider (Ollama) did not set its address')
  }
  await tool('36-prefs-mcp', async () => {
    await win.locator('.modal .pref-nav button', { hasText: 'AI & automation' }).click()
    await win.locator('.modal .pref-group-title', { hasText: 'MCP server' }).scrollIntoViewIfNeeded()
    await win.waitForTimeout(600)
  })
  await tool('36a-settings-about', async () => {
    await win.locator('.modal .pref-nav button', { hasText: 'About' }).click()
    await win.waitForSelector('.modal .about-card img')
    await win.waitForTimeout(300)
  })
  {
    const links = await win.locator('.modal .about-card').evaluateAll((as) => as.map((a) => a.getAttribute('href')))
    const logo = await win.locator('.modal .about-card img').evaluate((img) => img.complete && img.naturalWidth > 0)
    const ok = links.includes('https://fidweb.net') && links.includes('https://ko-fi.com/mexus') && logo
    console.log('about: fidweb + ko-fi + logo:', ok)
    if (!ok) throw new Error('About does not show the Fidweb logo and the Fidweb / Ko-fi links')
    // Update check: any clear answer (latest / available / not set up / GitHub unreachable) — no network assumptions.
    await win.locator('.modal .about button', { hasText: 'Check now' }).click()
    const updateText = (await win.locator('.modal .about-update').textContent({ timeout: 20000 })) ?? ''
    const updateOk = /latest version|is available|public repository|Could not reach GitHub|GitHub answered/.test(updateText)
    console.log('update check answers:', updateOk, `(${updateText})`)
    if (!updateOk) throw new Error(`Unexpected update check result: ${updateText}`)
  }
  await tool('36b-prefs-shell', async () => {
    await win.locator('.modal .pref-nav button', { hasText: 'Shell & Playground' }).click()
    await win.waitForSelector('.modal [data-pref="shellConfirm"]')
    await win.waitForTimeout(800)
  })
  await win.keyboard.press('Escape')

  // Phase 6 tools
  await tool('37-change-history', () => collMenu('customers', 'Change History'))
  await tool('38-validation', () => collMenu('customers', 'Validation Rules'))
  await tool('39-edit-view', () => collMenu('vipCustomers', 'Edit View'))
  await tool('40-find-in-database', async () => {
    await dbMenu('shop', 'Find in Database')
    await win.locator('.fs-input:visible input').first().fill('Linus')
    await win.locator('.fs-go:visible').first().click()
    await win.waitForTimeout(2500)
  })
  await tool('41-gridfs', async () => {
    await dbMenu('analytics', 'GridFS Files')
    await win.locator('tr, .gf-row', { hasText: 'logo.png' }).first().click()
    await win.waitForTimeout(1200)
  })
  await tool('42-server-status', async () => {
    await win.locator('.tree-row', { hasText: 'Local demo' }).first().click({ button: 'right' })
    await win.locator('.ctx-item', { hasText: 'Server Status' }).first().click()
    await win.waitForTimeout(6000)
  })
  await tool('43-tasks', async () => {
    await win.locator('.tree-row', { hasText: 'Local demo' }).first().click({ button: 'right' })
    await win.locator('.ctx-item', { hasText: 'Tasks' }).first().click()
    await win.waitForTimeout(1500)
  })
  await tool('44-paste-collection', async () => {
    await collMenu('products', 'Copy Collection')
    await dbMenu('analytics', 'Paste Collection')
    await win.waitForTimeout(1000)
  })
  await win.keyboard.press('Escape')
  // A 200,000-character string opens in the document editor at once (wrapping switches off for very long lines).
  {
    if (!(await win.locator('.tree-row', { hasText: 'notes' }).count())) await win.locator('.tree-row', { hasText: 'analytics' }).first().dblclick()
    await win.locator('.tree-row', { hasText: 'notes' }).first().dblclick()
    await win.waitForSelector('.qtab:visible .grid tbody tr td')
    await win.locator('.qtab:visible .grid tbody tr').first().locator('td.rownum').click({ button: 'right' })
    const t0 = Date.now()
    await win.locator('.ctx-item', { hasText: 'Edit as JSON' }).click()
    await win.waitForSelector('.modal .cm-editor')
    await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())))
    const longLineMs = Date.now() - t0
    console.log('long line editor:', longLineMs < 3000, `(${longLineMs} ms)`)
    await win.keyboard.press('Escape')
    if (longLineMs >= 3000) throw new Error('The document editor took too long to open a document with a very long line')

    // Delete Documents dialog: the tab's (empty) query matches the one note; an empty query asks again.
    await win.locator('.qtab:visible [title^="Delete documents"]').click()
    await win.locator('.modal .segmented button', { hasText: "The tab's query" }).click()
    await win.waitForSelector('.modal .ud-affected:has-text("1 document will be deleted")', { timeout: 5000 })
    await shot('10e-delete-documents')
    await win.locator('.modal .btn.danger', { hasText: 'Delete 1 document' }).click()
    await win.locator('.modal .btn', { hasText: 'Delete all' }).click()
    const deleted = await win
      .waitForSelector('.toast.success:has-text("1 document deleted")', { timeout: 5000 })
      .then(() => true)
      .catch(() => false)
    console.log('delete documents dialog:', deleted)
    if (!deleted) throw new Error('The Delete Documents dialog did not delete the matching document')
    await win.locator('.tab.active .close').click()
  }
  await tool('45-prefs-history', async () => {
    await win.locator('[title="Settings"]').click()
    await win.locator('.modal .pref-nav button', { hasText: 'Safety & undo' }).click()
    await win.waitForTimeout(600)
  })
  await tool('45b-prefs-network', async () => {
    await win.locator('.modal .pref-nav button', { hasText: 'Network & tools' }).click()
    await win.locator('.modal .segmented button', { hasText: 'Manual' }).click()
    await win.locator('.modal input[aria-label="Proxy host"]').fill('proxy.corp.example')
    await win.locator('.modal input[aria-label="Proxy port"]').fill('3128')
    await win.locator('.modal [data-pref="proxyBypass"] textarea').fill('.internal.example.com, 10.0.0.0/8')
    // Loopback is never proxied: the test reaches the local demo server directly.
    await win.locator('.modal input[aria-label="Address to test"]').fill(`127.0.0.1:${new URL(server.getUri()).port}`)
    await win.locator('.modal [data-pref="proxyTest"] button', { hasText: 'Test' }).click()
    await win.waitForSelector('.modal .proxy-test')
    const result = ((await win.locator('.modal .proxy-test').textContent()) ?? '').trim()
    console.log('proxy test →', result)
    if (!result.includes('direct (local address)')) throw new Error(`Unexpected proxy test result: ${result}`)
  })
  await win.keyboard.press('Escape')
  await tool('48-prefs-results', async () => {
    await win.locator('[title="Settings"]').click()
    await win.locator('.modal .pref-nav button', { hasText: 'Browsing data' }).click()
    await win.waitForTimeout(300)
  })
  await tool('49-prefs-editor', async () => {
    await win.locator('.modal .pref-nav button', { hasText: 'Writing code' }).click()
    await win.waitForTimeout(300)
  })
  await tool('50-prefs-search', async () => {
    await win.locator('.modal .pref-search').fill('ejson')
    await win.waitForSelector('.modal .pref-result')
    const first = ((await win.locator('.modal .pref-result').first().textContent()) ?? '').trim()
    console.log('preferences search "ejson" →', first)
    if (!first.includes('JSON style')) throw new Error('Settings search did not find JSON style')
  })
  await win.keyboard.press('Escape')
  await tool('46-prefs-dates', async () => {
    await win.locator('[title="Settings"]').click()
    await win.locator('.modal .pref-nav button', { hasText: 'Dates & time zones' }).click()
    await win.locator('.modal button', { hasText: 'Time zone…' }).click()
    await win.locator('.modal input[list="tz-names"]').fill('Europe/Sofia')
    await win.locator('.modal button', { hasText: 'Interface format' }).click()
    await win.waitForTimeout(400)
  })
  await win.locator('.modal .btn.primary', { hasText: 'Save' }).click().catch(() => {})
  await tool('47-dates-in-sofia', () => collMenu('orders', 'Open'))
  // Import a Studio 3T "Export connections → URI" file (synthetic hosts and credentials).
  await tool('58-import-studio3t', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'shardwise-s3t-')), 'Studio_3T_Connection_URI_Export.uri')
    writeFileSync(
      file,
      [
        '// Connections Exported from Studio 3T -- https://studio3t.com/',
        '// Exported on 22.10.2026 9:06:40',
        '',
        '// Atlas Demo',
        'mongodb+srv://demo:not-a-real-pw@demo-cluster.example.net/admin?retryWrites=true&srvServiceName=mongodb&authSource=admin&authMechanism=SCRAM-SHA-1&3t.uriVersion=3&3t.connection.name=Atlas+Demo&3t.databases=admin,demo-prod&3t.alwaysShowAuthDB=true&3t.alwaysShowDBFromUserRole=true&3t.sslTlsVersion=TLS',
        '',
        '// Tunnelled Demo',
        'mongodb://ops@10.0.0.9:27017/?authSource=admin&authMechanism=SCRAM-SHA-256&3t.uriVersion=3&3t.connection.name=Tunnelled+Demo&3t.ssh=true&3t.sshAddress=bastion.example.net&3t.sshUser=jump&3t.sshAuthMode=privateKey&3t.sshPKPath=id_ed25519',
        ''
      ].join('\r\n')
    )
    await win.getByRole('button', { name: 'Connect', exact: true }).first().click()
    await win.waitForSelector('.modal')
    await win.locator('.modal button[title^="Import connections"]').click()
    const input = win.locator('.modal input[placeholder="Choose a file…"]').last()
    await input.fill(file)
    await input.press('Enter')
    await win.waitForTimeout(800)
  })
  const importBtn = win.locator('.modal .btn.primary', { hasText: 'Import' }).last()
  await importBtn.click().catch(() => {})
  await win.waitForTimeout(800)
  const importedText = await win.locator('.modal').last().textContent().catch(() => '')
  console.log('studio 3t import:', /Atlas Demo/.test(importedText ?? '') && /Tunnelled Demo/.test(importedText ?? ''))
  while (await win.locator('.modal').count()) {
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)
  }
  // Value colours: change the dark-theme string colour, check a string cell uses it, then reset.
  await tool('59-prefs-colours', async () => {
    await win.locator('[title="Settings"]').click()
    await win.locator('.modal .pref-nav button', { hasText: 'Workspace' }).click()
    await win.locator('.modal [data-pref="valueColors"]').scrollIntoViewIfNeeded()
    await win.locator('.modal input[aria-label="String, dark theme"]').fill('#ff5a1f')
    await win.waitForTimeout(300)
  })
  await win.locator('.modal .btn.primary', { hasText: 'Save' }).click().catch(() => {})
  await win.waitForTimeout(400)
  await win.locator('.tab', { hasText: 'customers' }).first().click().catch(() => {})
  await win.waitForTimeout(400)
  const stringColour = await win
    .evaluate(() => {
      const el = document.querySelector('.grid td .t-string, .grid .t-string')
      return el ? window.getComputedStyle(el).color : null
    })
    .catch(() => null)
  console.log('string value colour after change:', stringColour, stringColour === 'rgb(255, 90, 31)')
  await win.locator('[title="Settings"]').click()
  await win.locator('.modal .pref-nav button', { hasText: 'Workspace' }).click()
  await win.locator('.modal button', { hasText: 'Reset all colours' }).click()
  await win.locator('.modal .btn.primary', { hasText: 'Save' }).click()
  await win.waitForTimeout(300)
  await tool('29-code', async () => {
    await win.locator('.tab', { hasText: 'customers' }).first().click()
    await win.locator('.segmented button:visible', { hasText: 'Code' }).first().click()
    await win.waitForTimeout(800)
  })

  // Settings: collections open without running, editor font size applies to open editors.
  await win.locator('[title="Settings"]').click()
  await win.locator('.modal .pref-search').fill('run the query')
  await win.keyboard.press('Enter')
  await win.waitForSelector('.modal [data-pref="runQueryOnOpen"]')
  await win.locator('.modal [data-pref="runQueryOnOpen"] input[type=checkbox]').uncheck()
  await shot('51-prefs-search-jump')
  await win.locator('.modal .pref-nav button', { hasText: 'Writing code' }).click()
  await win.locator('.modal [data-pref="editorFontSize"] select').selectOption('16')
  await win.locator('.modal .btn.primary', { hasText: 'Save' }).click()
  await win.waitForSelector('.modal', { state: 'detached' })
  await win.locator('.tree-row', { hasText: 'products' }).first().dblclick()
  await win.waitForTimeout(1200)
  const idle = await win.evaluate(() => {
    const q = [...document.querySelectorAll('.qtab')].find((x) => x.getBoundingClientRect().width > 0)
    return !!q && !q.querySelector('.grid tbody tr, .tv-row') && (q.textContent ?? '').includes('Press Run')
  })
  console.log('collection opened without running:', idle)
  if (!idle) throw new Error('The collection ran its query although "Run on open" is off')
  const fontSize = await win.evaluate(() => {
    const el = [...document.querySelectorAll('.qtab .cm-content')].find((x) => x.getBoundingClientRect().width > 0)
    return el ? el.ownerDocument.defaultView.getComputedStyle(el).fontSize : ''
  })
  console.log('editor font size:', fontSize)
  if (fontSize !== '16px') throw new Error(`Editor font size preference not applied (${fontSize})`)
  await shot('52-open-without-run')
  await win.locator('.qtab:visible .querybar .btn.primary', { hasText: 'Run' }).click()
  await win.waitForSelector('.qtab:visible .grid tbody tr, .qtab:visible .tv-row')

  // Settings → Shortcuts: rebind "Run query" (Ctrl+Enter → Ctrl+Shift+K), run with the new key, then restore the default.
  {
    const visibleRows = () => win.evaluate(() => [...document.querySelectorAll('.qtab')].find((x) => x.getBoundingClientRect().width > 0)?.querySelectorAll('.grid tbody tr').length ?? 0)
    const setQuery = async (text) => {
      await win.locator('.qtab:visible .querybar .cm-content').first().click()
      await win.keyboard.press('Control+A')
      await win.keyboard.insertText(text)
    }
    const runRow = win.locator('.modal .kb-row[data-command="query.run"]')
    await win.locator('[title="Settings"]').click()
    await win.locator('.modal .pref-nav button', { hasText: 'Shortcuts' }).click()
    await win.waitForSelector('.modal .kb-row')
    await shot('56-prefs-keyboard')
    await win.locator('.modal .kb-search').fill('run query')
    await runRow.locator('.kb-chip-key').first().click()
    await win.waitForSelector('[data-testid="kb-recorder"]')
    await win.keyboard.press('Control+Shift+K')
    const chips = await runRow.locator('.kb-chip-key').allTextContents()
    console.log('run query shortcuts after recording:', chips)
    if (chips.length !== 3 || !/K$/.test(chips[0]) || !(await win.locator('.modal').count())) throw new Error(`Recording a shortcut failed (${chips.join(', ')})`)
    await shot('57-prefs-keyboard-recorded')
    await win.locator('.modal .btn.primary', { hasText: 'Save' }).click()
    await win.waitForSelector('.modal', { state: 'detached' })
    // New key from the query editor runs the query; the old one no longer does.
    await setQuery('{ active: true }')
    await win.keyboard.press('Control+Shift+K')
    await win.waitForTimeout(900)
    const newKeyRan = (await visibleRows()) === 20
    await setQuery('{}')
    await win.keyboard.press('Control+Enter')
    await win.waitForTimeout(900)
    const oldKeyIgnored = (await visibleRows()) === 20
    // And from the results grid (window-level shortcut).
    await win.locator('.qtab:visible .grid tbody tr td').nth(1).click()
    await win.keyboard.press('Control+Shift+K')
    await win.waitForTimeout(900)
    const gridRan = (await visibleRows()) === 30
    console.log('rebound run query: new key ran', newKeyRan, '· old key ignored', oldKeyIgnored, '· from the grid', gridRan)
    if (!newKeyRan || !oldKeyIgnored || !gridRan) throw new Error('The rebound "Run query" shortcut did not behave as configured')
    // Reset to the default and check Ctrl+Enter runs again.
    await win.locator('[title="Settings"]').click()
    await win.locator('.modal .pref-nav button', { hasText: 'Shortcuts' }).click()
    await runRow.locator('button[aria-label="Reset Run query"]').click()
    const restored = await runRow.locator('.kb-chip-key').allTextContents()
    await win.locator('.modal .btn.primary', { hasText: 'Save' }).click()
    await win.waitForSelector('.modal', { state: 'detached' })
    await setQuery('{ active: true }')
    await win.keyboard.press('Control+Enter')
    await win.waitForTimeout(900)
    const defaultBack = (await visibleRows()) === 20
    console.log('run query shortcuts restored:', restored, '· Ctrl+Enter runs again', defaultBack)
    if (!defaultBack || restored.some((k) => /K$/.test(k))) throw new Error('Resetting the "Run query" shortcut did not restore the default')
    await setQuery('{}')
    await win.keyboard.press('Control+Enter')
    await win.waitForTimeout(600)
  }

  // Read-only connection: badge in the tree, locked tab, write menu items disabled, extra database listed.
  await win.getByRole('button', { name: 'Connect', exact: true }).first().click()
  await win.waitForSelector('.modal .list-row')
  await win.locator('.list-row', { hasText: 'Reporting (read-only)' }).dblclick()
  await win.waitForSelector('.tree-row .ro-badge')
  await win.waitForSelector('.tree-row:has-text("archive")')
  await win.locator('.tree-row', { hasText: /^shop$/ }).last().dblclick()
  await win.waitForTimeout(800)
  await win.locator('.tree-row', { hasText: /^customers/ }).last().dblclick()
  await win.waitForSelector('.tab.active .ro-lock')
  const roLocked = await win.evaluate(() => {
    const q = [...document.querySelectorAll('.qtab')].find((x) => x.getBoundingClientRect().width > 0)
    const lock = q && [...q.querySelectorAll('button[title]')].find((b) => (b.getAttribute('title') ?? '').startsWith('Read-only connection'))
    return !!lock && lock.disabled
  })
  console.log('read-only connection tab locked:', roLocked)
  if (!roLocked) throw new Error('The tab of a read-only connection can be unlocked')
  await win.locator('.segmented button:visible', { hasText: 'Table' }).first().click()
  await win.locator('.qtab:visible .querybar .btn.primary', { hasText: 'Run' }).click()
  await win.waitForSelector('.qtab:visible .grid tbody tr')
  await win.waitForTimeout(400)
  const roPage = await win.evaluate(() => [...document.querySelectorAll('.qtab')].find((x) => x.getBoundingClientRect().width > 0)?.querySelectorAll('.grid tbody tr').length ?? 0)
  console.log('read-only connection page size override (20):', roPage)
  if (roPage !== 20) throw new Error(`Per-connection page size not applied (${roPage} rows)`)
  await shot('53-read-only-connection')
  await win.locator('.tree-row', { hasText: /^shop$/ }).last().click({ button: 'right' })
  const dropDisabled = await win.locator('.ctx-item', { hasText: 'Drop database' }).evaluate((el) => el.classList.contains('disabled'))
  console.log('drop database disabled on read-only connection:', dropDisabled)
  if (!dropDisabled) throw new Error('Drop database is enabled on a read-only connection')
  await shot('54-read-only-menu')
  await win.keyboard.press('Escape')
  // The shell of a read-only connection shows the banner and refuses writes.
  await win.locator('.tree-row', { hasText: /^shop$/ }).last().click({ button: 'right' })
  await win.locator('.ctx-item', { hasText: 'Open Shell' }).first().click()
  await win.waitForSelector('.ro-banner:visible')
  await win.waitForTimeout(1500)
  await win.locator('.cm-editor:visible .cm-content').last().click()
  await win.keyboard.insertText('db.orders.insertOne({ blocked: true })')
  await win.keyboard.press('Enter')
  const shellRefused = await win
    .locator('text=is a read-only connection')
    .first()
    .waitFor({ timeout: 10000 })
    .then(
      () => true,
      () => false
    )
  console.log('shell write refused on read-only connection:', shellRefused)
  if (!shellRefused) throw new Error('The shell of a read-only connection did not refuse a write')
  await shot('55-read-only-shell')

  // Light theme check
  await win.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await shot('12-light-theme')
} catch (e) {
  console.error('E2E FAILED:', e)
  await win.screenshot({ path: join(outDir, 'failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  if (edgeReport.size) {
    console.log(`Controls within ${EDGE_PX} px of the right edge:\n` + [...edgeReport].map(([s, h]) => `  ${s}: ${h.join(' · ')}`).join('\n'))
  }
  if (errors.length) console.log('Renderer errors:\n' + errors.join('\n'))
  await app.close().catch(() => {})
  await server.stop()
}
