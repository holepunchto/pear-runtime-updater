const fs = require('bare-fs')
const os = require('bare-os')
const pearBootstrap = require('pear-updater-bootstrap')
const createTestnet = require('@hyperswarm/testnet')
const { spawn } = require('bare-subprocess')
const sodium = require('sodium-native')
const b4a = require('b4a')
const { platform, arch, isWindows } = require('which-runtime')
const IPC = require('pear-ipc')
const path = require('bare-path')
const Localdrive = require('localdrive')

module.exports = class Helper {
  static host = `${platform}-${arch}`
  static byArch = path.join('by-arch', Helper.host, 'bin', `pear-runtime${isWindows ? '.exe' : ''}`)
  static key = '63q1a8m8z678h19u3ckrzkdmpk7ydkp88jrrjwnkg7c5prf7kuxy'

  static createTestnet = createTestnet

  static getRandomId() {
    return Math.random().toString(16).slice(2)
  }

  static tmpDir(name = '', suffix = Helper.getRandomId()) {
    return path.join(os.tmpdir(), `pear-test-${name ? name + '-' : ''}${suffix}`)
  }

  static async bootstrap(dir, key, bootstrap = undefined) {
    await Helper.gc(dir)
    await fs.promises.mkdir(dir, { recursive: true })

    await pearBootstrap(key, dir, { bootstrap })
  }

  static async socketPath(platformDir) {
    const pipeId = (s) => {
      const buf = b4a.allocUnsafe(32)
      sodium.crypto_generichash(buf, b4a.from(s))
      return b4a.toString(buf, 'hex')
    }

    return isWindows ? `\\\\.\\pipe\\pear-${pipeId(platformDir)}` : `${platformDir}/pear.sock`
  }

  static async provisionPlatform() {
    const dir = Helper.tmpDir()
    await Helper.bootstrap(dir, Helper.key)
    const testnet = await Helper.createTestnet()
    const dhtBootstrap = testnet.nodes.map((e) => `${e.host}:${e.port}`).join(',')
    const runtime = path.join(dir, 'current', Helper.byArch)

    const pearProcess = spawn(runtime, ['--sidecar', '-M', '--dht-bootstrap', dhtBootstrap], {
      stdio: 'ignore'
    })

    return { testnet, pearProcess, dir, runtime }
  }

  static async connect(platformDir, options = {}) {
    const socketPath = options.socketPath ?? (await Helper.socketPath(platformDir))
    const lock = options.lock ?? path.join(platformDir, 'pear.lock')
    const connectTimeout = options.connectTimeout ?? 10000

    const ipc = new IPC.Client({
      lock,
      socketPath,
      connectTimeout,
      connect: true
    })

    await ipc.ready()

    return ipc
  }

  static async gc(dir) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true })
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'EISDIR' && err.code !== 'ENOTDIR') throw err
    }
  }

  static async waitForExit(child) {
    await new Promise((resolve, reject) => {
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`Failed with exit code ${code}`))
      })
      child.on('error', reject)
    })
  }

  static matchesPattern(message, pattern) {
    if (typeof pattern !== 'object' || pattern === null) return false
    for (const key in pattern) {
      if (Object.hasOwnProperty.call(pattern, key) === false) continue
      if (Object.hasOwnProperty.call(message, key) === false) return false
      const messageValue = message[key]
      const patternValue = pattern[key]
      const nested =
        typeof patternValue === 'object' &&
        patternValue !== null &&
        typeof messageValue === 'object' &&
        messageValue !== null
      if (nested) {
        if (!this.matchesPattern(messageValue, patternValue)) return false
      } else if (messageValue !== patternValue) {
        return false
      }
    }
    return true
  }

  static async pick(stream, ptn = {}, by = 'tag') {
    for await (const output of stream) {
      if (ptn?.[by] !== 'error' && output[by] === 'error') {
        throw new Error(output?.data?.message ?? 'Unknown error')
      }
      if (this.matchesPattern(output, ptn)) return output.data
    }
    return null
  }

  static async teardownStream(stream) {
    if (stream.destroyed) return
    stream.end()
    return new Promise((resolve) => stream.on('close', resolve))
  }

  static fixture(name) {
    return path.join(__dirname, 'fixtures', name)
  }

  static async cp(src, dst, options = { ignore: ['/pear', '/.git', '/test'] }) {
    if (fs.statSync(src).isDirectory() === false) {
      const dstDir = path.dirname(dst)
      if (fs.existsSync(dstDir) === false) fs.mkdirSync(dstDir, { recursive: true })
      fs.copyFileSync(src, dst)
      return
    }

    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true })
    const mirror = new Localdrive(src).mirror(new Localdrive(dst), {
      prune: false,
      ...options
    })
    await mirror.done()
  }

  static async readJSON(file) {
    const content = await fs.promises.readFile(file, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    return content ? JSON.parse(content) : null
  }

  static async writeJSON(file, data) {
    await fs.promises.writeFile(file, JSON.stringify(data, null, 2), 'utf-8')
  }
}
