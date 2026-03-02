const test = require('brittle')
const {
  spawn,
  constants: { SIGTERM }
} = require('bare-subprocess')
const Helper = require('./helper')
const path = require('bare-path')
const fs = require('bare-fs')
const env = require('bare-env')
const { platform, arch, isWindows } = require('which-runtime')

const fixture = Helper.fixture('cli-updater')
let dir, testnet

test.hook('setup', async (t) => {
  t.timeout(120_000)
  ;({ testnet, dir } = await Helper.provisionPlatform())
})

function pkgTarget() {
  const p = platform === 'win32' ? 'win' : platform
  return `node18-${p}-${arch}`
}

function binaryPath(appDir) {
  const base = path.join(appDir, 'dist', 'cli-updater')
  return isWindows ? base + '.exe' : base
}

function runCli(appDir, opts = {}) {
  const bin = binaryPath(appDir)
  const runEnv = {
    ...env,
    ...(opts.responseFile ? { PEAR_CLI_RESPONSE_FILE: opts.responseFile } : {}),
    ...(opts.pearBootstrap ? { PEAR_BOOTSTRAP: opts.pearBootstrap } : {})
  }
  return spawn(bin, [], { cwd: appDir, env: runEnv, stdio: ['pipe', 'pipe', 'pipe'] })
}

function runCliNode(appDir, opts = {}) {
  const runEnv = {
    ...env,
    ...(opts.responseFile ? { PEAR_CLI_RESPONSE_FILE: opts.responseFile } : {}),
    ...(opts.pearBootstrap ? { PEAR_BOOTSTRAP: opts.pearBootstrap } : {}),
    PEAR_APP_PATH: path.relative(appDir, binaryPath(appDir))
  }
  return spawn('node', ['cli.js'], { cwd: appDir, env: runEnv, stdio: ['pipe', 'pipe', 'pipe'] })
}

function parseResponse(stdout) {
  const line = stdout.trim().split('\n')[0]
  if (!line) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

const seedOpts = (id, stagingDir, link) => ({
  channel: `test-${id}`,
  name: `test-${id}`,
  key: null,
  dir: stagingDir,
  link,
  cmdArgs: []
})
const stageOpts = (id, stagingDir, link) => ({
  ...seedOpts(id, stagingDir, link),
  dryRun: false,
  ignore: []
})
const releaseOpts = (link, key) => ({ link, key })

const UPDATE_CHECK_TIMEOUT = 90_000

function withTimeout(promise, ms, getAppOutput = () => ({})) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const out = typeof getAppOutput === 'function' ? getAppOutput() : getAppOutput
      reject(
        new Error(
          `Update check timed out after ${ms}ms. ` +
            `App stdout: ${out.stdout || '(none)'}. ` +
            `App stderr: ${out.stderr || '(none)'}`
        )
      )
    }, ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

test('cli updates', async (t) => {
  t.timeout(180_000)

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
  t.teardown(() => Helper.gc(app))
  await Helper.cp(fixture, app)

  t.comment('update app version and link')
  {
    const pkg = await Helper.readJSON(path.join(app, 'package.json'))
    pkg.version = '1.0.0'
    pkg.upgrade = link
    await Helper.writeJSON(path.join(app, 'package.json'), pkg)
  }

  t.comment('install dependencies')
  {
    const child = spawn('npm', ['install'], { cwd: app })
    await Helper.waitForExit(child)
  }

  t.comment('build app')
  await fs.promises.mkdir(path.join(app, 'dist'), { recursive: true })
  const pkgCache = path.join(app, '.pkg-cache')
  await fs.promises.mkdir(pkgCache, { recursive: true })
  {
    const child = spawn('npx', ['pkg', '.', '-t', pkgTarget(), '-o', path.join(app, 'dist', 'cli-updater')], {
      cwd: app,
      env: { ...env, PKG_CACHE_PATH: pkgCache }
    })
    await Helper.waitForExit(child)
  }

  t.comment('clone first build to runDir (this is what we run; original stays for staging)')
  const runDir = Helper.tmpDir()
  t.teardown(() => Helper.gc(runDir))
  await Helper.cp(app, runDir)

  t.comment('run pear-build (stage the original build)')
  const staging = Helper.tmpDir()
  t.teardown(() => Helper.gc(staging))
  const host = Helper.host
  const appFlag = `--${host}-app`
  {
    const binPath = binaryPath(app)
    const child = spawn(
      'npx',
      ['pear-build', `${appFlag}=${binPath}`, '--package=./package.json', `--target=${staging}`],
      { cwd: app }
    )
    await Helper.waitForExit(child)
  }

  t.comment('stage (original build)')
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

  t.comment('run clone (node cli.js from runDir; PEAR_APP_PATH = binary for applyUpdate to swap)')
  const pearBootstrap = JSON.stringify(testnet.nodes.map((e) => `${e.host}:${e.port}`))
  const responseFile = path.join(runDir, 'response.json')
  const run = runCliNode(runDir, { responseFile, pearBootstrap })
  let stdout = ''
  let stderr = ''
  run.stdout.on('data', (data) => {
    stdout += data.toString()
  })
  run.stderr.on('data', (data) => {
    const s = data.toString()
    stderr += s
    t.comment('app stderr: ' + s.trim())
  })
  const exit = Helper.waitForExit(run)
  const appOutput = () => ({ stdout, stderr })

  t.comment('confirm first run is 1.0.0')
  await new Promise((r) => setTimeout(r, 500))
  const response1 =
    parseResponse(stdout) || (await fs.promises.readFile(responseFile, 'utf8').then((s) => JSON.parse(s.trim())).catch(() => null))
  if (response1) t.ok(response1.version === '1.0.0', `first run version 1.0.0 (got ${response1.version})`)

  t.comment('update app version')
  {
    const pkg = await Helper.readJSON(path.join(app, 'package.json'))
    pkg.version = '1.0.1'
    pkg.upgrade = link
    await Helper.writeJSON(path.join(app, 'package.json'), pkg)
  }

  t.comment('rebuild in place (original dir; running app is the clone so no conflict)')
  {
    const child = spawn('npx', ['pkg', '.', '-t', pkgTarget(), '-o', path.join(app, 'dist', 'cli-updater')], {
      cwd: app,
      env: { ...env, PKG_CACHE_PATH: pkgCache }
    })
    await Helper.waitForExit(child)
  }

  t.comment('rerun pear-build (stage new build)')
  {
    const binPath = binaryPath(app)
    const child = spawn(
      'npx',
      ['pear-build', `${appFlag}=${binPath}`, '--package=./package.json', `--target=${staging}`],
      { cwd: app }
    )
    await Helper.waitForExit(child)
  }

  t.comment('restage')
  const updated = new Promise((resolve) => {
    const onData = (data) => {
      if (data.toString().includes('updated')) {
        run.stdout.off('data', onData)
        resolve()
      }
    }
    run.stdout.on('data', onData)
  })
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

  t.comment('reseed (so app can discover updated content)')
  {
    const seed = ipc.seed(seedOpts(id, staging, link))
    t.teardown(() => Helper.teardownStream(seed))
    await Helper.pick(seed, { tag: 'announced' })
    t.pass('reseed announced')
  }

  t.comment('check for update message')
  await withTimeout(updated, UPDATE_CHECK_TIMEOUT, appOutput)
  t.pass('updated')

  t.comment('exit (app will exit after applyUpdate)')
  await exit

  t.comment('restart same path (runDir clone, now with OTA-applied binary)')
  const run2 = runCli(runDir, { responseFile, pearBootstrap })
  let stdout2 = ''
  run2.stdout.on('data', (data) => {
    stdout2 += data.toString()
  })
  await Helper.waitForExit(run2)
  const response2 =
    parseResponse(stdout2) || (await fs.promises.readFile(responseFile, 'utf8').then((s) => JSON.parse(s.trim())))
  t.ok(response2?.version === '1.0.1', `after restart version 1.0.1 (got ${response2?.version})`)

  t.comment('done')
})

test.hook('cleanup', async (t) => {
  const ipc = await Helper.connect(dir)
  t.teardown(() => ipc.close())
  await ipc.shutdown()
  await testnet.destroy()
  await Helper.gc(dir)
})
