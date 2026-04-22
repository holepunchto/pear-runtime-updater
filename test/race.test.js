// TEST-ONLY: exercises the re-entry guard + catch-up re-kick on the same-version
// early-return path. Relies on the throwaway `_firstUpdateTimeout` knob on the
// updater. Do NOT merge.

const test = require('brittle')
const path = require('path')
const tmpDir = require('test-tmp')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Localdrive = require('localdrive')
const { platform, arch } = require('which-runtime')
const helper = require('./helper')
const Updater = require('..')

const host = platform + '-' + arch

test('same-version first update with 10s delay + concurrent v2 stage → catch-up mirrors v2', async function (t) {
  t.timeout(60_000)

  const testnet = await helper.createTestnet()
  t.teardown(() => testnet.destroy())
  const bootstrap = testnet.nodes.map((e) => `${e.host}:${e.port}`)

  // stager + v1 initial stage
  const stagerDir = await tmpDir(t)
  const stager = new helper.Stager({ dir: stagerDir, bootstrap })
  await stager.ready()
  t.teardown(() => stager.close())

  const stagingV1 = await tmpDir(t)
  const localV1 = new Localdrive(stagingV1)
  await localV1.put('/package.json', Buffer.from(JSON.stringify({ version: '1.0.0' })))
  await localV1.put(`/by-arch/${host}/app/test.txt`, Buffer.from('v1'))
  await localV1.close()
  await stager.stage(stagingV1)
  await stager.seed()

  // updater at v1, with a 10s delay on its first _update() — running stays true
  // long enough that a concurrent v2 stage can append during it.
  const dir = await tmpDir(t)
  const store = new Corestore(path.join(dir, 'corestore'))
  const updater = new Updater({
    dir,
    app: path.join(dir, 'test.txt'), // placeholder for `bundled` semantics, unused here
    version: '1.0.0',
    upgrade: stager.link,
    name: 'test.txt',
    store,
    _firstUpdateTimeout: 10_000
  })
  await updater.ready()
  t.teardown(() => updater.close())

  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (c) => store.replicate(c))
  swarm.join(updater.drive.core.discoveryKey, { client: true, server: false })
  await swarm.flush()
  t.teardown(() => swarm.destroy())

  t.is(updater.updated, false, 'updated flag initially false')

  // Confirm the updater is in its guard-held window: running=true, updating=false.
  // Poll briefly — the delay starts after drive.update() resolves, which is near-instant once the swarm is connected.
  await helper.waitFor(() => updater.running === true && updater.updating === false)
  t.is(updater.running, true, 'running flag is set during delay')
  t.is(updater.updating, false, 'updating flag NOT set yet — still in same-version path')

  // While the updater is sleeping, stage v2. Blocks append to the drive and
  // propagate via the swarm. `_updateBackground` will fire and get guard-dropped.
  const stagingV2 = await tmpDir(t)
  const localV2 = new Localdrive(stagingV2)
  await localV2.put('/package.json', Buffer.from(JSON.stringify({ version: '2.0.0' })))
  await localV2.put(`/by-arch/${host}/app/test.txt`, Buffer.from('v2'))
  await localV2.close()

  const updated = new Promise((resolve) => updater.on('updated', resolve))
  await stager.stage(stagingV2)

  // After the 10s delay ends, updater enters same-version return (manifest is v1
  // at the frozen `length` snapshot), the catch-up re-kick detects
  // drive.core.length > length, fires a fresh `_update(0)` which mirrors v2.
  await updated
  t.is(updater.updated, true, 'updated flag set after catch-up mirror of v2')
  t.is(updater.updating, false, 'updating flag cleared at end of mirror path')
  t.is(updater.running, false, 'running flag cleared at end of mirror path')
})
