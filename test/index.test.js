const test = require('brittle')
const path = require('path')
const fs = require('fs')
const tmpDir = require('test-tmp')
const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const Localdrive = require('localdrive')
const { platform, arch, isWindows } = require('which-runtime')
const helper = require('./helper')
const Updater = require('..')

const host = platform + '-' + arch

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

test.solo('should delay update', async (t) => {
  t.timeout(60_000)
  t.plan(2)

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

  let start = 0
  let updateStart = 0

  updater.drive.core.on('append', () => {
    start = Date.now()
  })

  t.teardown(() => updater.close())

  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (c) => store.replicate(c))
  swarm.join(updater.drive.core.discoveryKey, { client: true, server: false })
  await swarm.flush()
  t.teardown(() => swarm.destroy())

  let randomDelay
  updater.on('update-scheduled', (n) => {
    randomDelay = n
    t.ok(n > 0 && n < 5000)
  })

  updater.on('updating', () => {
    updateStart = Date.now()
    t.ok(updateStart - start >= randomDelay, 'update delays ' + randomDelay + 'ms')
  })
})

function noop() {}
