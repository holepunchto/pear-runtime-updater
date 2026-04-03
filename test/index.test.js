const test = require('brittle')
const path = require('path')
const fs = require('fs')
const tmpDir = require('test-tmp')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Localdrive = require('localdrive')
const { platform, arch, isWindows } = require('which-runtime')
const helper = require('./helper')
const Updater = require('..')

const host = platform + '-' + arch

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
    store
  })
  await updater.ready()
  t.teardown(() => updater.close())

  const keyPair = await store.createKeyPair('test')
  const swarm = new Hyperswarm({ keyPair, bootstrap })
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
    store
  })
  await updater.ready()
  t.teardown(() => updater.close())

  const keyPair = await store.createKeyPair('test')
  const swarm = new Hyperswarm({ keyPair, bootstrap })
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
    store
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
