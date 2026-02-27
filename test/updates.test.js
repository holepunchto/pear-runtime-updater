const test = require('brittle')
const { spawn } = require('bare-subprocess')
const Helper = require('./helper')
const path = require('bare-path')
const env = require('bare-env')
const { isLinux, isMac, platform, arch } = require('which-runtime')
const host = platform + '-' + arch

const fixture = Helper.fixture('updater')
let dir, testnet

test.hook('setup', async (t) => {
  t.timeout(180_000)
  ;({ testnet, dir } = await Helper.provisionPlatform())
})

const seedOpts = (id, dir, link) => ({
  channel: `test-${id}`,
  name: `test-${id}`,
  key: null,
  dir,
  link,
  cmdArgs: []
})
const stageOpts = (id, dir, link) => ({
  ...seedOpts(id, dir, link),
  dryRun: false,
  ignore: []
})
const releaseOpts = (link, key) => ({
  link,
  key
})

test('should receive and apply update', async (t) => {
  t.timeout(180_000)

  t.comment('connect to IPC')
  const ipc = await Helper.connect(dir)
  t.teardown(() => ipc.close())

  t.comment('touch pear link')
  const touch = ipc.touch()
  t.teardown(() => Helper.teardownStream(touch))
  const touched = await Helper.pick(touch, { tag: 'final' })
  t.ok(touched.success, `touched ${touched.link}`)
  const { key, link } = touched

  t.comment('prepare copy of fixture')
  const app = Helper.tmpDir('fixture')
  t.teardown(() => Helper.gc(app))
  await Helper.cp(fixture, app)

  t.comment('update app version and link')
  {
    const pkg = await Helper.readJSON(path.join(app, 'package.json'))
    pkg.version = '1.0.0'
    pkg.upgrade = link
    await Helper.writeJSON(path.join(app, 'package.json'), pkg)
  }

  t.comment('build app')
  {
    const child = spawn('npm', ['run', 'make'], { cwd: app })
    await t.execution(Helper.waitForExit(child), 'app built successfully')
  }

  t.comment('copy build to run dir')
  const runDir = Helper.tmpDir('run')
  let appBuildPath
  let appRunPath
  if (isLinux) {
    appBuildPath = path.join(app, 'out', 'make', `updater-1.0.0-${arch}.AppImage`)
    appRunPath = path.join(runDir, 'updater.AppImage')
    await Helper.cp(appBuildPath, appRunPath)
  }
  if (isMac) {
    appBuildPath = path.join(app, 'out', `updater-${host}`, 'updater.app')
    appRunPath = path.join(runDir, 'updater.app')
    await Helper.cp(appBuildPath, appRunPath)
  }

  t.comment('build app structure')
  // TODO: replace with pear-build when single file is supported
  const staging = Helper.tmpDir('staging')
  t.teardown(() => Helper.gc(staging))
  await Helper.cp(path.join(app, 'package.json'), path.join(staging, 'package.json'))
  if (isLinux) {
    await Helper.cp(appBuildPath, path.join(staging, 'by-arch', host, 'app', 'updater.AppImage'))
  }
  if (isMac) {
    await Helper.cp(appBuildPath, path.join(staging, 'by-arch', host, 'app', 'updater.app'))
  }

  t.comment('stage')
  const id = Helper.getRandomId()
  {
    const stage = await ipc.stage(stageOpts(id, staging, link))
    t.teardown(() => Helper.teardownStream(stage))
    const staged = await Helper.pick(stage, { tag: 'final' })
    t.ok(staged.success, 'staged successfully')
  }

  t.comment('release')
  {
    const release = await ipc.release(releaseOpts(link, key))
    t.teardown(() => Helper.teardownStream(release))
    const released = await Helper.pick(release, { tag: 'final' })
    t.ok(released.success, 'released successfully')
  }

  t.comment('seed')
  {
    const seed = ipc.seed(seedOpts(id, staging, link))
    t.teardown(() => Helper.teardownStream(seed))
    await Helper.pick(seed, { tag: 'announced' })
    t.pass('seed announced')
  }

  t.comment('run')
  const runParams = { args: [] }
  // TODO: Support Windows
  const appDir = Helper.tmpDir('appdir')
  t.teardown(() => Helper.gc(appDir))
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
  let exit = Helper.waitForExit(run)

  t.comment('update app version')
  {
    const pkg = await Helper.readJSON(path.join(app, 'package.json'))
    pkg.version = '1.0.1'
    pkg.upgrade = link
    await Helper.writeJSON(path.join(app, 'package.json'), pkg)
  }

  t.comment('rebuild app')
  {
    const child = spawn('npm', ['run', 'make'], { cwd: app })
    await t.execution(Helper.waitForExit(child), 'app rebuilt successfully')
  }

  t.comment('rebuild app structure')
  await Helper.cp(path.join(app, 'package.json'), path.join(staging, 'package.json'))
  if (isLinux) {
    appBuildPath = path.join(app, 'out', 'make', `updater-1.0.1-${arch}.AppImage`)
    await Helper.cp(appBuildPath, path.join(staging, 'by-arch', host, 'app', 'updater.AppImage'))
  }
  if (isMac) {
    await Helper.cp(appBuildPath, path.join(staging, 'by-arch', host, 'app', 'updater.app'))
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
  {
    const stage = await ipc.stage(stageOpts(id, staging, link))
    t.teardown(() => Helper.teardownStream(stage))
    const staged = await Helper.pick(stage, { tag: 'final' })
    t.ok(staged.success, 'restaged successfully')
  }

  t.comment('rerelease')
  {
    const release = await ipc.release(releaseOpts(link, key))
    t.teardown(() => Helper.teardownStream(release))
    const released = await Helper.pick(release, { tag: 'final' })
    t.ok(released.success, 'rereleased successfully')
  }

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
  exit = Helper.waitForExit(run)

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

test('should receive and apply update with delayed seeding', async (t) => {
  t.timeout(180_000)

  t.comment('connect to IPC')
  const ipc = await Helper.connect(dir)
  t.teardown(() => ipc.close())

  t.comment('touch pear link')
  const touch = ipc.touch()
  t.teardown(() => Helper.teardownStream(touch))
  const touched = await Helper.pick(touch, { tag: 'final' })
  t.ok(touched.success, `touched ${touched.link}`)
  const { key, link } = touched

  t.comment('prepare copy of fixture')
  const app = Helper.tmpDir('fixture')
  t.teardown(() => Helper.gc(app))
  await Helper.cp(fixture, app)

  t.comment('update app version and link')
  {
    const pkg = await Helper.readJSON(path.join(app, 'package.json'))
    pkg.version = '1.0.0'
    pkg.upgrade = link
    await Helper.writeJSON(path.join(app, 'package.json'), pkg)
  }

  t.comment('build app')
  {
    const child = spawn('npm', ['run', 'make'], { cwd: app })
    await t.execution(Helper.waitForExit(child), 'app built successfully')
  }

  t.comment('copy build to run dir')
  const runDir = Helper.tmpDir('run')
  let appBuildPath
  let appRunPath
  if (isLinux) {
    appBuildPath = path.join(app, 'out', 'make', `updater-1.0.0-${arch}.AppImage`)
    appRunPath = path.join(runDir, 'updater.AppImage')
    await Helper.cp(appBuildPath, appRunPath)
  }
  if (isMac) {
    appBuildPath = path.join(app, 'out', `updater-${host}`, 'updater.app')
    appRunPath = path.join(runDir, 'updater.app')
    await Helper.cp(appBuildPath, appRunPath)
  }

  t.comment('build app structure')
  // TODO: replace with pear-build when single file is supported
  const staging = Helper.tmpDir('staging')
  t.teardown(() => Helper.gc(staging))
  await Helper.cp(path.join(app, 'package.json'), path.join(staging, 'package.json'))
  if (isLinux) {
    await Helper.cp(appBuildPath, path.join(staging, 'by-arch', host, 'app', 'updater.AppImage'))
  }
  if (isMac) {
    await Helper.cp(appBuildPath, path.join(staging, 'by-arch', host, 'app', 'updater.app'))
  }

  t.comment('stage')
  const id = Helper.getRandomId()
  {
    const stage = await ipc.stage(stageOpts(id, staging, link))
    t.teardown(() => Helper.teardownStream(stage))
    const staged = await Helper.pick(stage, { tag: 'final' })
    t.ok(staged.success, 'staged successfully')
  }

  t.comment('release')
  {
    const release = await ipc.release(releaseOpts(link, key))
    t.teardown(() => Helper.teardownStream(release))
    const released = await Helper.pick(release, { tag: 'final' })
    t.ok(released.success, 'released successfully')
  }

  t.comment('run')
  const runParams = { args: [] }
  // TODO: Support Windows
  const appDir = Helper.tmpDir('appdir')
  t.teardown(() => Helper.gc(appDir))
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
  run.stdout.on('data', (data) => {
    console.log('stdout', data.toString())
  })
  run.stderr.on('data', (data) => {
    console.log('stderr', data.toString())
  })
  let exit = Helper.waitForExit(run)

  t.comment('update app version')
  {
    const pkg = await Helper.readJSON(path.join(app, 'package.json'))
    pkg.version = '1.0.1'
    pkg.upgrade = link
    await Helper.writeJSON(path.join(app, 'package.json'), pkg)
  }

  t.comment('rebuild app')
  {
    const child = spawn('npm', ['run', 'make'], { cwd: app })
    await t.execution(Helper.waitForExit(child), 'app rebuilt successfully')
  }

  t.comment('rebuild app structure')
  await Helper.cp(path.join(app, 'package.json'), path.join(staging, 'package.json'))
  if (isLinux) {
    appBuildPath = path.join(app, 'out', 'make', `updater-1.0.1-${arch}.AppImage`)
    await Helper.cp(appBuildPath, path.join(staging, 'by-arch', host, 'app', 'updater.AppImage'))
  }
  if (isMac) {
    await Helper.cp(appBuildPath, path.join(staging, 'by-arch', host, 'app', 'updater.app'))
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
  {
    const stage = await ipc.stage(stageOpts(id, staging, link))
    t.teardown(() => Helper.teardownStream(stage))
    const staged = await Helper.pick(stage, { tag: 'final' })
    t.ok(staged.success, 'restaged successfully')
  }

  t.comment('rerelease')
  {
    const release = await ipc.release(releaseOpts(link, key))
    t.teardown(() => Helper.teardownStream(release))
    const released = await Helper.pick(release, { tag: 'final' })
    t.ok(released.success, 'rereleased successfully')
  }

  t.comment('delaying seed')
  const result = await Promise.race([
    updated.then(() => 'got-update'),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 3000))
  ])
  t.is(result, 'timed-out', 'should not update before seed starts')

  t.comment('seed')
  {
    const seed = ipc.seed(seedOpts(id, staging, link))
    t.teardown(() => Helper.teardownStream(seed))
    await Helper.pick(seed, { tag: 'announced' })
    t.pass('seed announced')
  }

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
  exit = Helper.waitForExit(run)

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

test.hook('cleanup', async (t) => {
  const ipc = await Helper.connect(dir)
  t.teardown(() => ipc.close())
  await ipc.shutdown()
  await testnet.destroy()
  await Helper.gc(dir)
})
