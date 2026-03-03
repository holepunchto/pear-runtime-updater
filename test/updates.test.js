const test = require('brittle')
const { spawn } = require('bare-subprocess')
const helper = require('./helper')
const path = require('bare-path')
const env = require('bare-env')
const { isLinux, isMac, platform, arch } = require('which-runtime')
const fs = require('bare-fs')
const host = platform + '-' + arch

const fixture = path.join(__dirname, 'fixtures', 'updater')

test('should receive and apply update when update happens while app is running', async (t) => {
  t.timeout(120_000)

  t.comment('create testnet')
  const testnet = await helper.createTestnet()
  t.teardown(() => testnet.destroy())

  const stagerDir = helper.tmpDir('platform')
  t.teardown(() => helper.gc(stagerDir))

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
  const app = helper.tmpDir('fixture')
  t.teardown(() => helper.gc(app))
  await helper.cp(fixture, app)

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
    const child = spawn('npm', ['run', 'make'], { cwd: app })
    await t.execution(helper.waitForExit(child), 'app built successfully')
  }

  t.comment('copy build to run dir')
  const runDir = helper.tmpDir('run')
  t.teardown(() => helper.gc(runDir))
  let appBuildPath
  let appRunPath
  if (isLinux) {
    appBuildPath = path.join(app, 'out', 'make', `updater-1.0.0-${arch}.AppImage`)
    appRunPath = path.join(runDir, 'updater.AppImage')
    await helper.cp(appBuildPath, appRunPath)
  }
  if (isMac) {
    appBuildPath = path.join(app, 'out', `updater-${host}`, 'updater.app')
    appRunPath = path.join(runDir, 'updater.app')
    await helper.cp(appBuildPath, appRunPath)
  }

  t.comment('build app structure')
  // TODO: replace with pear-build when single file is supported
  const staging = helper.tmpDir('staging')
  t.teardown(() => helper.gc(staging))
  await helper.cp(path.join(app, 'package.json'), path.join(staging, 'package.json'))
  if (isLinux) {
    await helper.cp(appBuildPath, path.join(staging, 'by-arch', host, 'app', 'updater.AppImage'))
  }
  if (isMac) {
    await helper.cp(appBuildPath, path.join(staging, 'by-arch', host, 'app', 'updater.app'))
  }

  t.comment('stage')
  await t.execution(stager.stage(staging), 'staged successfully')

  t.comment('seed')
  await t.execution(stager.seed(), 'seeded successfully')

  t.comment('run')
  const runParams = { args: [] }
  // TODO: Support Windows
  const appDir = helper.tmpDir('appdir')
  t.teardown(() => helper.gc(appDir))
  runParams.appDir = appDir

  if (isLinux) {
    // needed because GHA does not support FUSE and SUID sandboxing
    runParams.args = ['--appimage-extract-and-run', '--no-sandbox']
    runParams.execPath = path.join(appRunPath)
  }

  if (isMac) {
    runParams.args = []
    runParams.execPath = path.join(appRunPath, 'Contents', 'MacOS', 'updater')
  }

  runParams.env = {
    ...env,
    PEAR_BOOTSTRAP: JSON.stringify(testnet.nodes.map((e) => `${e.host}:${e.port}`)),
    PEAR_APPDIR: appDir,
    ...(isLinux ? { APPIMAGE: runParams.execPath } : {})
  }

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
    const child = spawn('npm', ['run', 'make'], { cwd: app })
    await t.execution(helper.waitForExit(child), 'app rebuilt successfully')
  }

  t.comment('rebuild app structure')
  await helper.cp(path.join(app, 'package.json'), path.join(staging, 'package.json'))
  if (isLinux) {
    appBuildPath = path.join(app, 'out', 'make', `updater-1.0.1-${arch}.AppImage`)
    await helper.cp(appBuildPath, path.join(staging, 'by-arch', host, 'app', 'updater.AppImage'))
  }
  if (isMac) {
    await helper.cp(appBuildPath, path.join(staging, 'by-arch', host, 'app', 'updater.app'))
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
  t.timeout(120_000)

  t.comment('create testnet')
  const testnet = await helper.createTestnet()
  t.teardown(() => testnet.destroy())

  const stagerDir = helper.tmpDir('platform')
  t.teardown(() => helper.gc(stagerDir))

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
  const app = helper.tmpDir('fixture')
  t.teardown(() => helper.gc(app))
  await helper.cp(fixture, app)

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
    const child = spawn('npm', ['run', 'make'], { cwd: app })
    await t.execution(helper.waitForExit(child), 'app built successfully')
  }

  t.comment('copy build to run dir')
  const runDir = helper.tmpDir('run')
  t.teardown(() => helper.gc(runDir))
  let appBuildPath
  let appRunPath
  if (isLinux) {
    appBuildPath = path.join(app, 'out', 'make', `updater-1.0.0-${arch}.AppImage`)
    appRunPath = path.join(runDir, 'updater.AppImage')
    await helper.cp(appBuildPath, appRunPath)
  }
  if (isMac) {
    appBuildPath = path.join(app, 'out', `updater-${host}`, 'updater.app')
    appRunPath = path.join(runDir, 'updater.app')
    await helper.cp(appBuildPath, appRunPath)
  }

  t.comment('build app structure')
  // TODO: replace with pear-build when single file is supported
  const staging = helper.tmpDir('staging')
  t.teardown(() => helper.gc(staging))
  await helper.cp(path.join(app, 'package.json'), path.join(staging, 'package.json'))
  if (isLinux) {
    await helper.cp(appBuildPath, path.join(staging, 'by-arch', host, 'app', 'updater.AppImage'))
  }
  if (isMac) {
    await helper.cp(appBuildPath, path.join(staging, 'by-arch', host, 'app', 'updater.app'))
  }

  t.comment('stage')
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
    const child = spawn('npm', ['run', 'make'], { cwd: app })
    await t.execution(helper.waitForExit(child), 'app rebuilt successfully')
  }

  t.comment('rebuild app structure')
  await helper.cp(path.join(app, 'package.json'), path.join(staging, 'package.json'))
  if (isLinux) {
    appBuildPath = path.join(app, 'out', 'make', `updater-1.0.1-${arch}.AppImage`)
    await helper.cp(appBuildPath, path.join(staging, 'by-arch', host, 'app', 'updater.AppImage'))
  }
  if (isMac) {
    await helper.cp(appBuildPath, path.join(staging, 'by-arch', host, 'app', 'updater.app'))
  }

  t.comment('restage')
  await t.execution(stager.stage(staging), 'restaged successfully')

  t.comment('run')
  const runParams = { args: [] }
  // TODO: Support Windows
  const appDir = helper.tmpDir('appdir')
  t.teardown(() => helper.gc(appDir))
  runParams.appDir = appDir

  if (isLinux) {
    // needed because GHA does not support FUSE and SUID sandboxing
    runParams.args = ['--appimage-extract-and-run', '--no-sandbox']
    runParams.execPath = path.join(appRunPath)
  }

  if (isMac) {
    runParams.args = []
    runParams.execPath = path.join(appRunPath, 'Contents', 'MacOS', 'updater')
  }

  runParams.env = {
    ...env,
    PEAR_BOOTSTRAP: JSON.stringify(testnet.nodes.map((e) => `${e.host}:${e.port}`)),
    PEAR_APPDIR: appDir,
    ...(isLinux ? { APPIMAGE: runParams.execPath } : {})
  }

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
