// Renders build/icon.svg to build/icon.png (1024x1024) with Electron. Run: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('fs')
const { join } = require('path')

app.whenReady().then(async () => {
  const svg = readFileSync(join(__dirname, '../build/icon.svg'), 'utf8')
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } })
  const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="1024" height="1024" ')}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 300))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  writeFileSync(join(__dirname, '../build/icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG())
  app.quit()
})
