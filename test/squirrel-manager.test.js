const test = require('brittle')
const path = require('path')
const fs = require('fs')
const tmpDir = require('test-tmp')
const SquirrelManager = require('../squirrel-manager')

test('squirrel-manager detects and parses local feed/install payloads', async function (t) {
  const manager = new SquirrelManager()
  t.is(manager.isSquirrelName('RELEASES'), true)
  t.is(manager.isSquirrelName('app-1.0.0-full.nupkg'), true)
  t.is(manager.isSquirrelName('Updater-Setup.exe'), false)

  const dir = await tmpDir(t)
  const feedDir = path.join(dir, 'feed')
  await fs.promises.mkdir(feedDir, { recursive: true })
  await fs.promises.writeFile(path.join(feedDir, 'RELEASES'), 'x', 'utf8')
  await fs.promises.writeFile(path.join(dir, 'setup.exe'), 'x', 'utf8')

  const feedPayload = await manager.payloadFromPath(feedDir)
  t.alike(feedPayload, { type: 'feed', feed: feedDir })

  const installerPayload = await manager.payloadFromPath(path.join(dir, 'setup.exe'))
  t.alike(installerPayload, { type: 'installer', file: path.join(dir, 'setup.exe') })
})
