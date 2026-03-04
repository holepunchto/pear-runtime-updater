const test = require('brittle')
const { spawn, spawnSync } = require('child_process')
const helper = require('./helper')
const path = require('path')
const { env } = require('process')
const { isLinux, isMac, isWindows, platform, arch } = require('which-runtime')
const fs = require('fs')
const tmpDir = require('test-tmp')
const Localdrive = require('localdrive')
const host = platform + '-' + arch

const fixture = path.join(__dirname, 'fixtures', 'updater')
const npm = isWindows ? 'npm.cmd' : 'npm'
const powershell = 'pwsh.exe'

function getInstalledMsixExe(name) {
  const result = spawnSync(powershell, [
    '-Command',
    `(Get-AppxPackage -Name '${name}').InstallLocation`
  ])
  const installLocation = result.stdout.toString().trim()
  if (!installLocation) throw new Error('MSIX package not found: ' + name)
  return path.join(installLocation, 'app', name + '.exe')
}

function removeMsixPackage(name) {
  const child = spawn(
    powershell,
    ['-Command', `Get-AppxPackage -Name '${name}' | Remove-AppxPackage`],
    { stdio: 'ignore' }
  )
  return helper.waitForExit(child).catch(() => {})
}

function trustMsixCertificate(msixPath) {
  const child = spawn(
    powershell,
    [
      '-Command',
      `$sig=(Get-AuthenticodeSignature '${msixPath}').SignerCertificate; Export-Certificate -Cert $sig -FilePath "$env:TEMP\\msix-sign.cer" -Force | Out-Null; Import-Certificate -FilePath "$env:TEMP\\msix-sign.cer" -CertStoreLocation Cert:\\LocalMachine\\Root | Out-Null; Remove-Item "$env:TEMP\\msix-sign.cer" -Force;`
    ],
    { stdio: 'inherit' }
  )

  return helper.waitForExit(child)
}

test('should receive and apply update when update happens while app is running', async (t) => {
  t.timeout(180_000)

  t.comment('create testnet')
  const testnet = await helper.createTestnet()
  t.teardown(() => testnet.destroy())

  const stagerDir = await tmpDir(t, { name: `platform-${helper.getRandomId()}` })

  t.comment('prepare stager')
  const stager = new helper.Stager({
    dir: stagerDir,
    bootstrap: testnet.nodes.map((e) => `${e.host}:${e.port}`)
  })
  await stager.ready()
  t.teardown(() => stager.close())
  const link = stager.link
  t.ok(link, `prepared ${link}`)

  t.comment('prepare copy of fixture')
  const app = await tmpDir(t, { name: `fixture-${helper.getRandomId()}` })
  await new Localdrive(fixture).mirror(new Localdrive(app)).done()

  t.comment('update app version and link')
  {
    const pkg = require(path.join(app, 'package.json'))
    pkg.version = '1.0.0'
    pkg.upgrade = link
    await fs.promises.writeFile(
      path.join(app, 'package.json'),
      JSON.stringify(pkg, null, 2),
      'utf8'
    )
  }

  t.comment('build app')
  {
    const child = spawn(npm, ['run', 'make'], { cwd: app })
    await t.execution(helper.waitForExit(child), 'app built successfully')
  }

  t.comment('copy build to run dir')
  const runDir = await tmpDir(t, { name: `run-${helper.getRandomId()}` })
  let appBuildPath
  let appRunPath
  if (isLinux) {
    appBuildPath = path.join(app, 'out', 'make', `updater-1.0.0-${arch}.AppImage`)
    appRunPath = path.join(runDir, 'updater.AppImage')
    await fs.promises.mkdir(path.dirname(appRunPath), { recursive: true })
    await fs.promises.cp(appBuildPath, appRunPath)
  }
  if (isMac) {
    appBuildPath = path.join(app, 'out', `updater-${host}`, 'updater.app')
    appRunPath = path.join(runDir, 'updater.app')
    await new Localdrive(appBuildPath).mirror(new Localdrive(appRunPath)).done()
  }
  if (isWindows) {
    appBuildPath = path.join(app, 'out', 'make', 'msix', arch, 'updater.msix')
    await t.execution(trustMsixCertificate(appBuildPath), 'trusted MSIX certificate successfully')

    const MSIXManager = require('msix-manager')
    const manager = new MSIXManager()
    await t.execution(manager.addPackage(appBuildPath), 'installed app successfully')
    t.teardown(() => removeMsixPackage('updater'))

    appRunPath = getInstalledMsixExe('updater')
  }

  t.comment('build app structure')
  // TODO: replace with pear-build when single file is supported
  const staging = await tmpDir(t, { name: `staging-${helper.getRandomId()}` })
  await new Localdrive(app).mirror(new Localdrive(staging), { prefix: 'package.json' }).done()
  if (isLinux) {
    const dst = path.join(staging, 'by-arch', host, 'app', 'updater.AppImage')
    await fs.promises.mkdir(path.dirname(dst), { recursive: true })
    await fs.promises.cp(appBuildPath, dst)
  }
  if (isMac) {
    const dst = path.join(staging, 'by-arch', host, 'app', 'updater.app')
    await new Localdrive(appBuildPath).mirror(new Localdrive(dst)).done()
  }
  if (isWindows) {
    const dst = path.join(staging, 'by-arch', host, 'app', 'updater.msix')
    await fs.promises.mkdir(path.dirname(dst), { recursive: true })
    await fs.promises.cp(appBuildPath, dst)
  }

  t.comment('stage')
  await t.execution(stager.stage(staging), 'staged successfully')

  t.comment('seed')
  await t.execution(stager.seed(), 'seeded successfully')

  t.comment('run')
  const runParams = { args: [] }
  const appDir = await tmpDir(t, { name: `appdir-${helper.getRandomId()}` })
  runParams.appDir = appDir
  const bootstrap = JSON.stringify(testnet.nodes.map((e) => `${e.host}:${e.port}`))
  const baseArgs = [appDir, bootstrap]

  if (isLinux) {
    // needed because GHA does not support FUSE and SUID sandboxing
    runParams.args = ['--appimage-extract-and-run', '--no-sandbox', ...baseArgs]
    runParams.execPath = path.join(appRunPath)
  }

  if (isMac) {
    runParams.args = [...baseArgs]
    runParams.execPath = path.join(appRunPath, 'Contents', 'MacOS', 'updater')
  }

  if (isWindows) {
    runParams.args = [...baseArgs]
    runParams.execPath = appRunPath
  }

  runParams.env = { ...env, ...(isLinux ? { APPIMAGE: runParams.execPath } : {}) }

  let run = spawn(runParams.execPath, runParams.args, {
    cwd: app,
    env: runParams.env,
    stdio: 'pipe'
  })
  let exit = helper.waitForExit(run)

  t.comment('update app version')
  {
    const pkg = require(path.join(app, 'package.json'))
    pkg.version = '1.0.1'
    pkg.upgrade = link
    await fs.promises.writeFile(
      path.join(app, 'package.json'),
      JSON.stringify(pkg, null, 2),
      'utf8'
    )
  }

  t.comment('rebuild app')
  {
    await t.execution(fs.promises.unlink(path.join(app, 'out')), 'removed old build successfully')
    const child = spawn(npm, ['run', 'make'], { cwd: app })
    await t.execution(helper.waitForExit(child), 'app rebuilt successfully')
  }

  t.comment('rebuild app structure')
  await new Localdrive(app).mirror(new Localdrive(staging), { prefix: 'package.json' }).done()
  if (isLinux) {
    appBuildPath = path.join(app, 'out', 'make', `updater-1.0.1-${arch}.AppImage`)
    const dst = path.join(staging, 'by-arch', host, 'app', 'updater.AppImage')
    await fs.promises.mkdir(path.dirname(dst), { recursive: true })
    await fs.promises.cp(appBuildPath, dst)
  }
  if (isMac) {
    const dst = path.join(staging, 'by-arch', host, 'app', 'updater.app')
    await new Localdrive(appBuildPath).mirror(new Localdrive(dst)).done()
  }
  if (isWindows) {
    appBuildPath = path.join(app, 'out', 'make', 'msix', arch, 'updater.msix')
    const dst = path.join(staging, 'by-arch', host, 'app', 'updater.msix')
    await fs.promises.mkdir(path.dirname(dst), { recursive: true })
    await fs.promises.cp(appBuildPath, dst)
  }

  t.comment('restage')
  const updated = new Promise((resolve) =>
    run.stdout.on('data', (data) => {
      if (data.toString().includes('updated')) resolve()
    })
  )
  const applied = new Promise((resolve) =>
    run.stdout.on('data', (data) => {
      if (data.toString().includes('applied')) resolve()
    })
  )
  await t.execution(stager.stage(staging), 'restaged successfully')

  t.comment('check for update message')
  await t.execution(updated, 'got updated message')

  t.comment('check for update applied message')
  await t.execution(applied, 'got applied message')

  t.comment('wait for exit')
  await t.execution(await exit, 'app exited successfully')

  t.comment('rerun app')
  if (isWindows) {
    appRunPath = getInstalledMsixExe('updater')
    runParams.execPath = appRunPath
  }
  run = spawn(runParams.execPath, runParams.args, {
    cwd: app,
    env: runParams.env,
    stdio: 'pipe'
  })
  exit = helper.waitForExit(run)

  t.comment('wait for version')
  const startedVersion = new Promise((resolve) => {
    run.stdout.on('data', (data) => {
      const dataStr = data.toString()
      if (dataStr.startsWith('running')) {
        resolve(dataStr.split(' ')[1])
      }
    })
  })

  t.is(await startedVersion, '1.0.1', 'version matches updated value (1.0.1)')

  await t.execution(await exit, 'app exited successfully')
})

test('should receive and apply update when update happens while app is not running', async (t) => {
  t.timeout(180_000)

  t.comment('create testnet')
  const testnet = await helper.createTestnet()
  t.teardown(() => testnet.destroy())

  const stagerDir = await tmpDir(t, { name: `platform-${helper.getRandomId()}` })

  t.comment('prepare stager')
  const stager = new helper.Stager({
    dir: stagerDir,
    bootstrap: testnet.nodes.map((e) => `${e.host}:${e.port}`)
  })
  await stager.ready()
  t.teardown(() => stager.close())
  const link = stager.link
  t.ok(link, `prepared ${link}`)

  t.comment('prepare copy of fixture')
  const app = await tmpDir(t, { name: `fixture-${helper.getRandomId()}` })
  await new Localdrive(fixture).mirror(new Localdrive(app)).done()

  t.comment('update app version and link')
  {
    const pkg = require(path.join(app, 'package.json'))
    pkg.version = '1.0.0'
    pkg.upgrade = link
    await fs.promises.writeFile(
      path.join(app, 'package.json'),
      JSON.stringify(pkg, null, 2),
      'utf8'
    )
  }

  t.comment('build app')
  {
    const child = spawn(npm, ['run', 'make'], { cwd: app })
    await t.execution(helper.waitForExit(child), 'app built successfully')
  }

  t.comment('copy build to run dir')
  const runDir = await tmpDir(t, { name: `run-${helper.getRandomId()}` })
  let appBuildPath
  let appRunPath
  if (isLinux) {
    appBuildPath = path.join(app, 'out', 'make', `updater-1.0.0-${arch}.AppImage`)
    appRunPath = path.join(runDir, 'updater.AppImage')
    await fs.promises.mkdir(path.dirname(appRunPath), { recursive: true })
    await fs.promises.cp(appBuildPath, appRunPath)
  }
  if (isMac) {
    appBuildPath = path.join(app, 'out', `updater-${host}`, 'updater.app')
    appRunPath = path.join(runDir, 'updater.app')
    await new Localdrive(appBuildPath).mirror(new Localdrive(appRunPath)).done()
  }
  if (isWindows) {
    appBuildPath = path.join(app, 'out', 'make', 'msix', arch, 'updater.msix')
    await t.execution(trustMsixCertificate(appBuildPath), 'trusted MSIX certificate successfully')

    const MSIXManager = require('msix-manager')
    const manager = new MSIXManager()
    await t.execution(manager.addPackage(appBuildPath), 'installed app successfully')
    t.teardown(() => removeMsixPackage('updater'))

    appRunPath = getInstalledMsixExe('updater')
  }

  t.comment('build app structure')
  // TODO: replace with pear-build when single file is supported
  const staging = await tmpDir(t, { name: `staging-${helper.getRandomId()}` })
  await new Localdrive(app).mirror(new Localdrive(staging), { prefix: 'package.json' }).done()
  if (isLinux) {
    const dst = path.join(staging, 'by-arch', host, 'app', 'updater.AppImage')
    await fs.promises.mkdir(path.dirname(dst), { recursive: true })
    await fs.promises.cp(appBuildPath, dst)
  }
  if (isMac) {
    const dst = path.join(staging, 'by-arch', host, 'app', 'updater.app')
    await new Localdrive(appBuildPath).mirror(new Localdrive(dst)).done()
  }
  if (isWindows) {
    const dst = path.join(staging, 'by-arch', host, 'app', 'updater.msix')
    await fs.promises.mkdir(path.dirname(dst), { recursive: true })
    await fs.promises.cp(appBuildPath, dst)
  }
  await t.execution(stager.stage(staging), 'staged successfully')

  t.comment('seed')
  await t.execution(stager.seed(), 'seeded successfully')

  t.comment('update app version')
  {
    const pkg = require(path.join(app, 'package.json'))
    pkg.version = '1.0.1'
    pkg.upgrade = link
    await fs.promises.writeFile(
      path.join(app, 'package.json'),
      JSON.stringify(pkg, null, 2),
      'utf8'
    )
  }

  t.comment('rebuild app')
  {
    await t.execution(fs.promises.unlink(path.join(app, 'out')), 'removed old build successfully')
    const child = spawn(npm, ['run', 'make'], { cwd: app })
    await t.execution(helper.waitForExit(child), 'app rebuilt successfully')
  }

  t.comment('rebuild app structure')
  await new Localdrive(app).mirror(new Localdrive(staging), { prefix: 'package.json' }).done()
  if (isLinux) {
    appBuildPath = path.join(app, 'out', 'make', `updater-1.0.1-${arch}.AppImage`)
    const dst = path.join(staging, 'by-arch', host, 'app', 'updater.AppImage')
    await fs.promises.mkdir(path.dirname(dst), { recursive: true })
    await fs.promises.cp(appBuildPath, dst)
  }
  if (isMac) {
    const dst = path.join(staging, 'by-arch', host, 'app', 'updater.app')
    await new Localdrive(appBuildPath).mirror(new Localdrive(dst)).done()
  }
  if (isWindows) {
    appBuildPath = path.join(app, 'out', 'make', 'msix', arch, 'updater.msix')
    const dst = path.join(staging, 'by-arch', host, 'app', 'updater.msix')
    await fs.promises.mkdir(path.dirname(dst), { recursive: true })
    await fs.promises.cp(appBuildPath, dst)
  }

  t.comment('restage')
  await t.execution(stager.stage(staging), 'restaged successfully')

  t.comment('run')
  const runParams = { args: [] }
  const appDir = await tmpDir(t, { name: `appdir-${helper.getRandomId()}` })
  runParams.appDir = appDir
  const bootstrap = JSON.stringify(testnet.nodes.map((e) => `${e.host}:${e.port}`))
  const baseArgs = [appDir, bootstrap]

  if (isLinux) {
    // needed because GHA does not support FUSE and SUID sandboxing
    runParams.args = ['--appimage-extract-and-run', '--no-sandbox', ...baseArgs]
    runParams.execPath = path.join(appRunPath)
  }

  if (isMac) {
    runParams.args = [...baseArgs]
    runParams.execPath = path.join(appRunPath, 'Contents', 'MacOS', 'updater')
  }

  if (isWindows) {
    runParams.args = [...baseArgs]
    runParams.execPath = appRunPath
  }

  runParams.env = { ...env, ...(isLinux ? { APPIMAGE: runParams.execPath } : {}) }

  let run = spawn(runParams.execPath, runParams.args, {
    cwd: app,
    env: runParams.env,
    stdio: 'pipe'
  })
  let exit = helper.waitForExit(run)
  const updated = new Promise((resolve) =>
    run.stdout.on('data', (data) => {
      if (data.toString().includes('updated')) resolve()
    })
  )
  const applied = new Promise((resolve) =>
    run.stdout.on('data', (data) => {
      if (data.toString().includes('applied')) resolve()
    })
  )

  t.comment('check for update message')
  await t.execution(updated, 'got updated message')

  t.comment('check for update applied message')
  await t.execution(applied, 'got applied message')

  t.comment('wait for exit')
  await t.execution(await exit, 'app exited successfully')

  t.comment('rerun app')
  if (isWindows) {
    appRunPath = getInstalledMsixExe('updater')
    runParams.execPath = appRunPath
  }
  run = spawn(runParams.execPath, runParams.args, {
    cwd: app,
    env: runParams.env,
    stdio: 'pipe'
  })
  exit = helper.waitForExit(run)

  t.comment('wait for version')
  const startedVersion = new Promise((resolve) => {
    run.stdout.on('data', (data) => {
      const dataStr = data.toString()
      if (dataStr.startsWith('running')) {
        resolve(dataStr.split(' ')[1])
      }
    })
  })

  t.is(await startedVersion, '1.0.1', 'version matches updated value (1.0.1)')

  await t.execution(await exit, 'app exited successfully')
})
