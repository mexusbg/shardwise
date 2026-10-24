// electron-builder afterPack hook for macOS builds without a Developer ID certificate: Apple Silicon refuses to run
// unsigned arm64 code, so the .app gets an ad-hoc signature — from Apple's codesign on macOS (CI), from rcodesign on
// Linux (scripts/mac-from-linux.sh). With a certificate configured, electron-builder signs again after this hook.
const { execFileSync } = require('child_process')
const { join } = require('path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (process.platform === 'darwin') execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  else execFileSync(process.env.RCODESIGN || 'rcodesign', ['sign', app], { stdio: 'inherit' })
}
