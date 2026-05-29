const test = require('brittle')
const path = require('path')
const fs = require('fs')
const tmpDir = require('test-tmp')
const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const Localdrive = require('localdrive')
const { platform, arch, isWindows } = require('which-runtime')
const pearBuild = require('pear-build')
const bareBuild = require('bare-build')
const helper = require('./helper')
const Updater = require('..')

const host = platform + '-' + arch
const windowsHost = 'win32-' + arch
const windowsAppOption = 'win32' + arch.charAt(0).toUpperCase() + arch.slice(1) + 'App'

test('should prefetch the latest version on first run', async function (t) {
  t.timeout(120_000)

  const testnet = await helper.createTestnet()
  t.teardown(() => testnet.destroy())
  const bootstrap = testnet.nodes.map((e) => `${e.host}:${e.port}`)

  const stagerDir = await tmpDir(t)
  const stager = new helper.Stager({ dir: stagerDir, bootstrap })
  await stager.ready()
  t.teardown(() => stager.close())

  const staged = await tmpDir(t)
  const appName = `updater-${host}`
  const prefix = `/by-arch/${host}/app/${appName}`
  const prefixDir = path.join(staged, 'by-arch', host, 'app', appName)

  await fs.promises.mkdir(prefixDir, { recursive: true })
  await fs.promises.writeFile(
    path.join(staged, 'package.json'),
    JSON.stringify({ version: '1.0.0' }, null, 2),
    'utf8'
  )
  await fs.promises.writeFile(path.join(prefixDir, 'bundle.txt'), 'first run payload', 'utf8')

  await stager.stage(staged)
  await stager.seed()

  const dir = await tmpDir(t)
  const store = new Corestore(path.join(dir, 'pear-runtime/corestore'))
  t.teardown(() => store.close())

  const updater = new Updater({
    bundled: true,
    dir,
    name: appName,
    store,
    upgrade: stager.link,
    version: '1.0.0',
    delay: 0
  })
  await updater.ready()
  t.teardown(() => updater.close())

  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (connection) => store.replicate(connection))
  t.teardown(() => swarm.destroy())

  const discovery = swarm.join(updater.drive.core.discoveryKey, {
    client: true,
    server: false
  })
  await discovery.flushed()
  t.teardown(() => discovery.destroy())

  await helper.waitFor(async () => {
    if (updater.drive.core.length < stager.drive.version) return false
    return await updater.drive.has(prefix)
  })
})

test('should prefetch the latest version after partial metadata sync', async function (t) {
  t.timeout(120_000)

  const testnet = await helper.createTestnet()
  t.teardown(() => testnet.destroy())
  const bootstrap = testnet.nodes.map((e) => `${e.host}:${e.port}`)

  const stagerDir = await tmpDir(t)
  const stager = new helper.Stager({ dir: stagerDir, bootstrap })
  await stager.ready()
  t.teardown(() => stager.close())

  const staged = await tmpDir(t)
  const appName = `updater-${host}`
  const prefix = `/by-arch/${host}/app/${appName}`
  const prefixDir = path.join(staged, 'by-arch', host, 'app', appName)

  await fs.promises.mkdir(prefixDir, { recursive: true })
  await fs.promises.writeFile(
    path.join(staged, 'package.json'),
    JSON.stringify({ version: '1.0.0' }, null, 2),
    'utf8'
  )
  await fs.promises.writeFile(path.join(prefixDir, 'bundle.txt'), 'partial sync payload', 'utf8')

  await stager.stage(staged)
  await stager.seed()

  const dir = await tmpDir(t)
  {
    const store = new Corestore(path.join(dir, 'pear-runtime/corestore'))
    const drive = new Hyperdrive(store, stager.drive.key)
    await drive.ready()

    const swarm = new Hyperswarm({ bootstrap })
    swarm.on('connection', (connection) => store.replicate(connection))

    const discovery = swarm.join(drive.core.discoveryKey, {
      client: true,
      server: false
    })
    await discovery.flushed()

    await drive.update()
    await drive.db.core.download({ start: 0, length: 1 }).done()

    await discovery.destroy()
    await swarm.destroy()
    await drive.close()
    await store.close()
  }

  const store = new Corestore(path.join(dir, 'pear-runtime/corestore'))
  t.teardown(() => store.close())

  const updater = new Updater({
    bundled: true,
    dir,
    name: appName,
    store,
    upgrade: stager.link,
    version: '1.0.0',
    delay: 0
  })
  await updater.ready()
  t.teardown(() => updater.close())

  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (connection) => store.replicate(connection))
  t.teardown(() => swarm.destroy())

  const discovery = swarm.join(updater.drive.core.discoveryKey, {
    client: true,
    server: false
  })
  await discovery.flushed()
  t.teardown(() => discovery.destroy())

  await helper.waitFor(async () => {
    if (updater.drive.core.length < stager.drive.version) return false
    return await updater.drive.has(prefix)
  })
})

test('should continue updating when prefetch fails', async function (t) {
  t.timeout(60_000)

  const testnet = await helper.createTestnet()
  t.teardown(() => testnet.destroy())
  const bootstrap = testnet.nodes.map((e) => `${e.host}:${e.port}`)

  const stagerDir = await tmpDir(t)
  const stager = new helper.Stager({ dir: stagerDir, bootstrap })
  await stager.ready()
  t.teardown(() => stager.close())

  const staging = await tmpDir(t)
  const local = new Localdrive(staging)
  await local.put('/package.json', Buffer.from(JSON.stringify({ version: '1.0.1' })))
  await local.put(`/by-arch/${host}/app/test.txt`, Buffer.from('v2'))
  await local.close()
  await stager.stage(staging)
  await stager.seed()

  const dir = await tmpDir(t)
  const store = new Corestore(path.join(dir, 'corestore'))
  const updater = new Updater({
    dir,
    bundled: true,
    version: '1.0.0',
    upgrade: stager.link,
    name: 'test.txt',
    store,
    delay: 0
  })
  await updater.ready()
  t.teardown(() => updater.close())

  const prefetchError = new Error('prefetch failed')
  updater._prefetchLatest = async function () {
    throw prefetchError
  }

  updater.on('error', noop)
  const updated = new Promise((resolve) => updater.once('updated', resolve))

  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (c) => store.replicate(c))
  swarm.join(updater.drive.core.discoveryKey, { client: true, server: false })
  await swarm.flush()
  t.teardown(() => swarm.destroy())

  await updated

  t.is(updater.updated, true, 'update still completed')
})

test('should not prefetch before updating to a newer version', async function (t) {
  t.timeout(60_000)

  const testnet = await helper.createTestnet()
  t.teardown(() => testnet.destroy())
  const bootstrap = testnet.nodes.map((e) => `${e.host}:${e.port}`)

  const stagerDir = await tmpDir(t)
  const stager = new helper.Stager({ dir: stagerDir, bootstrap })
  await stager.ready()
  t.teardown(() => stager.close())

  const staging = await tmpDir(t)
  const local = new Localdrive(staging)
  await local.put('/package.json', Buffer.from(JSON.stringify({ version: '1.0.1' })))
  await local.put(`/by-arch/${host}/app/test.txt`, Buffer.from('v2'))
  await local.close()
  await stager.stage(staging)
  await stager.seed()

  const dir = await tmpDir(t)
  const store = new Corestore(path.join(dir, 'corestore'))
  const updater = new Updater({
    dir,
    bundled: true,
    version: '1.0.0',
    upgrade: stager.link,
    name: 'test.txt',
    store,
    delay: 0
  })
  await updater.ready()
  t.teardown(() => updater.close())

  let prefetched = false
  updater._prefetchLatest = async function () {
    prefetched = true
  }

  const updated = new Promise((resolve) => updater.once('updated', resolve))

  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (c) => store.replicate(c))
  swarm.join(updater.drive.core.discoveryKey, { client: true, server: false })
  await swarm.flush()
  t.teardown(() => swarm.destroy())

  await updated

  t.is(prefetched, false, 'prefetch was skipped')
  t.is(updater.updated, true, 'update still completed')
})

test('should detect update when remote version is newer', async function (t) {
  t.timeout(60_000)

  const testnet = await helper.createTestnet()
  t.teardown(() => testnet.destroy())
  const bootstrap = testnet.nodes.map((e) => `${e.host}:${e.port}`)

  const stagerDir = await tmpDir(t)
  const stager = new helper.Stager({ dir: stagerDir, bootstrap })
  await stager.ready()
  t.teardown(() => stager.close())

  const staging = await tmpDir(t)
  const local = new Localdrive(staging)
  await local.put('/package.json', Buffer.from(JSON.stringify({ version: '1.0.0' })))
  await local.put(`/by-arch/${host}/app/test.txt`, Buffer.from('v1'))
  await local.close()
  await stager.stage(staging)
  await stager.seed()

  const dir = await tmpDir(t)
  const appFile = path.join(dir, 'test.txt')
  await fs.promises.writeFile(appFile, 'v1')

  const store = new Corestore(path.join(dir, 'corestore'))
  const updater = new Updater({
    dir,
    app: appFile,
    version: '1.0.0',
    upgrade: stager.link,
    name: 'test.txt',
    store,
    delay: 0
  })
  await updater.ready()
  t.teardown(() => updater.close())

  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (c) => store.replicate(c))
  swarm.join(updater.drive.core.discoveryKey, { client: true, server: false })
  await swarm.flush()
  t.teardown(() => swarm.destroy())

  t.is(updater.updated, false)

  const updated = new Promise((resolve) => updater.on('updated', resolve))

  const staging2 = await tmpDir(t)
  const local2 = new Localdrive(staging2)
  await local2.put('/package.json', Buffer.from(JSON.stringify({ version: '1.0.1' })))
  await local2.put(`/by-arch/${host}/app/test.txt`, Buffer.from('v2'))
  await local2.close()
  await stager.stage(staging2)

  await updated
  t.is(updater.updated, true)

  if (!isWindows) {
    await updater.applyUpdate()
    const content = await fs.promises.readFile(appFile, 'utf8')
    t.is(content, 'v2', 'file was swapped to new version')
  }
})

test('should apply update for Windows exe build', { skip: !isWindows }, async function (t) {
  t.timeout(120_000)

  const testnet = await helper.createTestnet()
  t.teardown(() => testnet.destroy())
  const bootstrap = testnet.nodes.map((e) => `${e.host}:${e.port}`)

  const stagerDir = await tmpDir(t)
  const stager = new helper.Stager({ dir: stagerDir, bootstrap })
  await stager.ready()
  t.teardown(() => stager.close())

  const appName = 'updater-bare'
  const exeName = appName + '.exe'
  const app = await tmpDir(t)

  const v1Exe = await buildWindowsExe(app, appName, '1.0.0')
  const runDir = await tmpDir(t)
  const appFile = path.join(runDir, exeName)
  await fs.promises.copyFile(v1Exe, appFile)
  const v1 = await fs.promises.readFile(appFile)

  const staging = await tmpDir(t)
  await pearBuild({
    package: path.join(app, 'package.json'),
    [windowsAppOption]: v1Exe,
    target: staging
  }).done()
  await stager.stage(staging)
  await stager.seed()

  const dir = await tmpDir(t)
  const store = new Corestore(path.join(dir, 'corestore'))
  t.teardown(() => store.close())

  const updater = new Updater({
    dir,
    app: appFile,
    version: '1.0.0',
    upgrade: stager.link,
    name: exeName,
    store,
    delay: 0
  })
  await updater.ready()
  t.teardown(() => updater.close())

  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (connection) => store.replicate(connection))
  swarm.join(updater.drive.core.discoveryKey, { client: true, server: false })
  await swarm.flush()
  t.teardown(() => swarm.destroy())

  t.is(updater.updated, false, 'initial matching version did not update')

  const updated = new Promise((resolve, reject) => {
    updater.once('updated', resolve)
    updater.once('error', reject)
  })

  const v2Exe = await buildWindowsExe(app, appName, '1.0.1')
  const v2 = await fs.promises.readFile(v2Exe)
  await fs.promises.rm(staging, { recursive: true, force: true })
  await pearBuild({
    package: path.join(app, 'package.json'),
    [windowsAppOption]: v2Exe,
    target: staging
  }).done()
  await stager.stage(staging)

  await updated
  t.is(updater.nextIsBin, true, 'bin manifest selected executable update path')

  await updater.applyUpdate()

  t.alike(await fs.promises.readFile(appFile), v2, 'exe was replaced with v2 build')
  t.alike(
    await fs.promises.readFile(path.join(runDir, `${appName}-1.0.0.exe`)),
    v1,
    'v1 exe was kept as versioned backup'
  )
  t.absent(await exists(path.join(runDir, `${appName}-1.0.1.exe`)), 'incoming exe was moved')
})

test('should detect update when appling is folder (MacOS)', async function (t) {
  t.timeout(60_000)

  const testnet = await helper.createTestnet()
  t.teardown(() => testnet.destroy())
  const bootstrap = testnet.nodes.map((e) => `${e.host}:${e.port}`)

  const stagerDir = await tmpDir(t)
  const stager = new helper.Stager({ dir: stagerDir, bootstrap })
  await stager.ready()
  t.teardown(() => stager.close())

  const staging = await tmpDir(t)
  const local = new Localdrive(staging)
  await local.put('/package.json', Buffer.from(JSON.stringify({ version: '1.0.0' })))
  await local.put(`/by-arch/${host}/app/test.app/test.txt`, Buffer.from('v1'))
  await local.close()
  await stager.stage(staging)
  await stager.seed()

  const dir = await tmpDir(t)
  const appDir = path.join(dir, 'test.app')
  await fs.promises.mkdir(appDir, { recursive: true })
  const appFile = path.join(appDir, 'test.txt')
  await fs.promises.writeFile(appFile, 'v1')

  const store = new Corestore(path.join(dir, 'corestore'))
  const updater = new Updater({
    dir,
    app: appDir,
    version: '1.0.0',
    upgrade: stager.link,
    name: 'test.app',
    store,
    delay: 0
  })
  await updater.ready()
  t.teardown(() => updater.close())

  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (c) => store.replicate(c))
  swarm.join(updater.drive.core.discoveryKey, { client: true, server: false })
  await swarm.flush()
  t.teardown(() => swarm.destroy())

  t.is(updater.updated, false)

  const updated = new Promise((resolve) => updater.on('updated', resolve))

  const staging2 = await tmpDir(t)
  const local2 = new Localdrive(staging2)
  await local2.put('/package.json', Buffer.from(JSON.stringify({ version: '1.0.1' })))
  await local2.put(`/by-arch/${host}/app/test.app/test.txt`, Buffer.from('v2'))
  await local2.close()
  await stager.stage(staging2)

  await updated
  t.is(updater.updated, true)

  if (!isWindows) {
    await updater.applyUpdate()
    const content = await fs.promises.readFile(appFile, 'utf8')
    t.is(content, 'v2', 'file was swapped to new version')
  }
})

test('should not update when remote version is older', async function (t) {
  t.timeout(60_000)

  const testnet = await helper.createTestnet()
  t.teardown(() => testnet.destroy())
  const bootstrap = testnet.nodes.map((e) => `${e.host}:${e.port}`)

  const stagerDir = await tmpDir(t)
  const stager = new helper.Stager({ dir: stagerDir, bootstrap })
  await stager.ready()
  t.teardown(() => stager.close())

  const staging = await tmpDir(t)
  const local = new Localdrive(staging)
  await local.put('/package.json', Buffer.from(JSON.stringify({ version: '1.0.0' })))
  await local.put(`/by-arch/${host}/app/test.txt`, Buffer.from('old'))
  await local.close()
  await stager.stage(staging)
  await stager.seed()

  const dir = await tmpDir(t)
  const appFile = path.join(dir, 'test.txt')
  await fs.promises.writeFile(appFile, 'current')

  const store = new Corestore(path.join(dir, 'corestore'))
  const updater = new Updater({
    dir,
    app: appFile,
    version: '2.0.0',
    upgrade: stager.link,
    name: 'test.txt',
    store,
    delay: 0
  })
  await updater.ready()
  t.teardown(() => updater.close())

  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (c) => store.replicate(c))
  swarm.join(updater.drive.core.discoveryKey, { client: true, server: false })
  await swarm.flush()
  t.teardown(() => swarm.destroy())

  await new Promise((resolve) => setTimeout(resolve, 3000))

  t.is(updater.updated, false, 'should not update to older version')

  if (!isWindows) {
    const content = await fs.promises.readFile(appFile, 'utf8')
    t.is(content, 'current', 'file unchanged')
  }
})

test('should emit error if update not found', async function (t) {
  t.plan(1)
  t.timeout(60_000)

  const testnet = await helper.createTestnet()
  t.teardown(() => testnet.destroy())
  const bootstrap = testnet.nodes.map((e) => `${e.host}:${e.port}`)

  const stagerDir = await tmpDir(t)
  const stager = new helper.Stager({ dir: stagerDir, bootstrap })
  await stager.ready()
  t.teardown(() => stager.close())

  const dir = await tmpDir(t)
  const appFile = path.join(dir, 'test.txt')
  await fs.promises.writeFile(appFile, 'v1')

  const store = new Corestore(path.join(dir, 'corestore'))
  const updater = new Updater({
    dir,
    app: appFile,
    version: '1.0.0',
    upgrade: stager.link,
    name: 'test.txt',
    store,
    delay: 0
  })
  await updater.ready()
  t.teardown(() => updater.close())

  const staging = await tmpDir(t)
  const local = new Localdrive(staging)
  await local.put('/package.json', Buffer.from(JSON.stringify({ version: '2.0.0' })))
  await local.put(`/by-arch/${host}/app/not_test.txt`, Buffer.from('v2'))
  await local.close()
  await stager.stage(staging)
  await stager.seed()

  const updated = new Promise((resolve, reject) => {
    updater.on('error', reject)
    updater.on('updating', resolve)
  })

  const swarm = new Hyperswarm({ bootstrap })
  t.teardown(async () => await swarm.destroy())
  swarm.on('connection', (c) => store.replicate(c))
  swarm.join(updater.drive.core.discoveryKey, { client: true, server: false })
  await swarm.flush()

  await t.exception(updated, /update not found/)
})

test('should update from prerelease to release', async function (t) {
  t.timeout(60_000)

  const testnet = await helper.createTestnet()
  t.teardown(() => testnet.destroy())
  const bootstrap = testnet.nodes.map((e) => `${e.host}:${e.port}`)

  const stagerDir = await tmpDir(t)
  const stager = new helper.Stager({ dir: stagerDir, bootstrap })
  await stager.ready()
  t.teardown(() => stager.close())

  const staging = await tmpDir(t)
  const local = new Localdrive(staging)
  await local.put('/package.json', Buffer.from(JSON.stringify({ version: '1.0.0' })))
  await local.put(`/by-arch/${host}/app/test.txt`, Buffer.from('release'))
  await local.close()
  await stager.stage(staging)
  await stager.seed()

  const dir = await tmpDir(t)
  const appFile = path.join(dir, 'test.txt')
  await fs.promises.writeFile(appFile, 'prerelease')

  const store = new Corestore(path.join(dir, 'corestore'))
  const updater = new Updater({
    dir,
    app: appFile,
    version: '1.0.0-rc.1',
    upgrade: stager.link,
    name: 'test.txt',
    store,
    delay: 0
  })
  await updater.ready()
  t.teardown(() => updater.close())

  const updated = new Promise((resolve) => updater.on('updated', resolve))

  const keyPair = await store.createKeyPair('test')
  const swarm = new Hyperswarm({ keyPair, bootstrap })
  swarm.on('connection', (c) => store.replicate(c))
  swarm.join(updater.drive.core.discoveryKey, { client: true, server: false })
  await swarm.flush()
  t.teardown(() => swarm.destroy())

  await updated
  t.is(updater.updated, true, 'prerelease updated to release')

  if (!isWindows) {
    await updater.applyUpdate()
    const content = await fs.promises.readFile(appFile, 'utf8')
    t.is(content, 'release', 'file was swapped')
  }
})

test('should delay update', async (t) => {
  t.timeout(60_000)
  t.plan(1)

  const testnet = await helper.createTestnet()
  t.teardown(() => testnet.destroy())
  const bootstrap = testnet.nodes.map((e) => `${e.host}:${e.port}`)

  const stagerDir = await tmpDir(t)
  const stager = new helper.Stager({ dir: stagerDir, bootstrap })
  await stager.ready()
  t.teardown(() => stager.close())

  const staging = await tmpDir(t)
  const local = new Localdrive(staging)
  await local.put('/package.json', Buffer.from(JSON.stringify({ version: '2.0.0' })))
  await local.put(`/by-arch/${host}/app/test.txt`, Buffer.from('old'))
  await local.close()
  await stager.stage(staging)
  await stager.seed()

  const dir = await tmpDir(t)
  const appFile = path.join(dir, 'test.txt')
  await fs.promises.writeFile(appFile, 'current')
  const delay = 5000

  const store = new Corestore(path.join(dir, 'corestore'))
  const updater = new Updater({
    dir,
    app: appFile,
    version: '1.0.0',
    upgrade: stager.link,
    name: 'test.txt',
    store,
    delay
  })
  await updater.ready()

  t.teardown(() => updater.close())

  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (c) => store.replicate(c))
  swarm.join(updater.drive.core.discoveryKey, { client: true, server: false })
  await swarm.flush()
  t.teardown(() => swarm.destroy())

  updater.on('update-scheduled', () => {
    t.pass()
  })
})

async function buildWindowsExe(dir, name, version) {
  await fs.promises.rm(path.join(dir, 'out'), { recursive: true, force: true })
  await fs.promises.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name,
        productName: name,
        version,
        bin: 'bin.js',
        main: 'bin.js'
      },
      null,
      2
    )
  )
  await fs.promises.writeFile(
    path.join(dir, 'bin.js'),
    "const pkg = require('./package.json')\nconsole.log(`${pkg.name} ${pkg.version}`)\n"
  )

  const out = path.join(dir, 'out', windowsHost)
  for await (const _ of bareBuild(path.join(dir, 'bin.js'), {
    base: dir,
    hosts: [windowsHost],
    name,
    out,
    standalone: true
  })) {
    // drain build output
  }

  return path.join(out, name + '.exe')
}

async function exists(filename) {
  try {
    await fs.promises.access(filename)
    return true
  } catch {
    return false
  }
}

function noop() {}
