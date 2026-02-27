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

test('updates', async (t) => {
  t.timeout(180_000)
  t.comment(`running tests on ${host}`)

  t.comment('connect')
  const ipc = await Helper.connect(dir)
  t.teardown(() => ipc.close())

  t.comment('touch')
  const touch = ipc.touch({})
  t.teardown(() => Helper.teardownStream(touch))
  const touched = await Helper.pick(touch, { tag: 'final' })
  t.ok(touched.success, `successfully touched ${touched.link}`)
  const { key, link } = touched

  t.comment('prepare')
  const app = Helper.tmpDir()
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
    await Helper.waitForExit(child)
  }

  t.comment('build app structure')
  const staging = Helper.tmpDir()
  t.teardown(() => Helper.gc(staging))
  {
    await Helper.cp(path.join(app, 'package.json'), path.join(staging, 'package.json'))
    if (isLinux) {
      await Helper.cp(
        path.join(app, 'out', 'make', 'updater-1.0.0-x64.AppImage'),
        path.join(staging, 'by-arch', host, 'app', 'updater.AppImage')
      )
    }
    if (isMac) {
      await Helper.cp(
        path.join(app, 'out', `updater-${host}`, 'updater.app'),
        path.join(staging, 'by-arch', host, 'app', 'updater.app')
      )
    }
  }

  t.comment('stage')
  const id = Helper.getRandomId()
  {
    const stage = await ipc.stage(stageOpts(id, staging, link))
    t.teardown(() => Helper.teardownStream(stage))
    const staged = await Helper.pick(stage, { tag: 'final' })
    t.ok(staged.success, 'stage succeeded')
  }

  t.comment('release')
  {
    const release = await ipc.release(releaseOpts(link, key))
    t.teardown(() => Helper.teardownStream(release))
    const released = await Helper.pick(release, { tag: 'final' })
    t.ok(released.success, 'release succeeded')
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
  let run
  let exit
  {
    // TODO: support Windows/MacOS
    const appDir = Helper.tmpDir(`appdir-${Helper.getRandomId()}`)
    runParams.appDir = appDir
    t.teardown(() => Helper.gc(appDir))

    if (isLinux) {
      runParams.args = ['--appimage-extract-and-run', '--no-sandbox']
      runParams.execPath = path.join(app, 'out', 'make', 'updater-1.0.0-x64.AppImage')
    }
    if (isMac) {
      runParams.args = []
      runParams.execPath = path.join(
        app,
        'out',
        `updater-${host}`,
        'updater.app',
        'Contents',
        'MacOS',
        'updater'
      )
    }

    runParams.env = {
      ...env,
      PEAR_BOOTSTRAP: JSON.stringify(testnet.nodes.map((e) => `${e.host}:${e.port}`)),
      PEAR_APPDIR: appDir,
      ...(isLinux ? { APPIMAGE: runParams.execPath } : {})
    }

    run = spawn(runParams.execPath, runParams.args, {
      cwd: app,
      env: runParams.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    run.stdout.on('data', (data) => {
      console.log('APP STDOUT', data.toString())
    })
    run.stderr.on('data', (data) => {
      console.log('APP STDERR', data.toString())
    })
    exit = Helper.waitForExit(run)
  }

  t.comment('update app version')
  {
    const pkg = await Helper.readJSON(path.join(app, 'package.json'))
    pkg.version = '1.0.1'
    pkg.upgrade = link
    await Helper.writeJSON(path.join(app, 'package.json'), pkg)
  }

  t.comment('rebuild')
  {
    const child = spawn('npm', ['run', 'make'], { cwd: app })
    await Helper.waitForExit(child)
  }

  // TODO: replace with pear-build when single file is supported
  t.comment('rebuild app structure')
  {
    await Helper.cp(path.join(app, 'package.json'), path.join(staging, 'package.json'))
    if (isLinux) {
      await Helper.cp(
        path.join(app, 'out', 'make', 'updater-1.0.1-x64.AppImage'),
        path.join(staging, 'by-arch', host, 'app', 'updater.AppImage')
      )
    }
    if (isMac) {
      await Helper.cp(
        path.join(app, 'out', `updater-${host}`, 'updater.app'),
        path.join(staging, 'by-arch', host, 'app', 'updater')
      )
    }
  }

  t.comment('restage')
  const updated = new Promise((resolve) =>
    run.stdout.on('data', (data) => {
      if (data.toString().includes('updated')) resolve()
    })
  )
  const applied = isMac
    ? new Promise((resolve) =>
        run.stdout.on('data', (data) => {
          if (data.toString().includes('applied')) resolve()
        })
      )
    : Promise.resolve()

  {
    const stage = await ipc.stage(stageOpts(id, staging, link))
    t.teardown(() => Helper.teardownStream(stage))
    const staged = await Helper.pick(stage, { tag: 'final' })
    t.ok(staged.success, 'stage succeeded')
  }

  t.comment('rerelease')
  {
    const release = await ipc.release(releaseOpts(link, key))
    t.teardown(() => Helper.teardownStream(release))
    const released = await Helper.pick(release, { tag: 'final' })
    t.ok(released.success, 'rerelease succeeded')
  }

  t.comment('check for update message')
  await updated
  t.pass('updated')

  if (isMac) {
    t.comment('check for update applied message')
    await applied
    t.pass('update applied')
  }

  t.comment('exit')
  await exit

  // TODO: rerun the app
  // TODO: check for update applied
  // - assert that the app has printed an update applied message

  if (isMac) {
    t.comment('rerunning app')
    run = spawn(runParams.execPath, runParams.args, {
      cwd: app,
      env: runParams.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    run.stdout.on('data', (data) => {
      console.log('APP STDOUT', data.toString())
    })
    run.stderr.on('data', (data) => {
      console.log('APP STDERR', data.toString())
    })
    exit = Helper.waitForExit(run)

    t.comment('waiting for version')
    const startedVersion = new Promise((resolve) => {
      run.stdout.on('data', (data) => {
        const dataStr = data.toString()
        if (dataStr.startsWith('running')) {
          resolve(dataStr.split(' ')[1])
        }
      })
    })

    t.is(await startedVersion, '1.0.1', 'version matches updated value')

    await exit
  }

  t.comment('done')
})

test.hook('cleanup', async (t) => {
  const ipc = await Helper.connect(dir)
  t.teardown(() => ipc.close())
  await ipc.shutdown()
  await testnet.destroy()
  await Helper.gc(dir)
})
