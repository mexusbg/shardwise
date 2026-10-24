// electron-builder afterPack hook for macOS builds made on Linux: electron-builder can only sign on macOS, and
// Apple Silicon refuses to run unsigned arm64 code, so the .app gets an ad-hoc signature from rcodesign.
const { execFileSync } = require('child_process')
const { join } = require('path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin' || process.platform === 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync(process.env.RCODESIGN || 'rcodesign', ['sign', app], { stdio: 'inherit' })
}
