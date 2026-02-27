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
const env = require('bare-env')
const Localdrive = require('localdrive')

const MAX_OP_STEP_WAIT = env.CI ? 360000 : 120000

class Reiterate {
  constructor(stream) {
    this.stream = stream
    this.complete = false
    this.buffer = []
    this.readers = []

    this._ondata = this._ondata.bind(this)
    this._onend = this._onend.bind(this)
    this.onerror = this._onerror.bind(this)

    this.stream.on('data', this._ondata)
    this.stream.on('end', this._onend)
    this.stream.on('error', this._onerror)
  }

  _ondata(value) {
    this.buffer.push({ value, done: false })
    for (const { resolve } of this.readers) resolve()
    this.readers.length = 0
  }

  _onend() {
    this.buffer.push({ done: true })
    this.complete = true
    for (const { resolve } of this.readers) resolve()
    this.readers.length = 0
  }

  _onerror(err) {
    for (const { reject } of this.readers) reject(err)
    this.readers.length = 0
  }

  async *_tail() {
    try {
      let i = 0
      while (i < this.buffer.length || !this.complete) {
        if (i < this.buffer.length) {
          const { value, done } = this.buffer[i++]
          if (done) break
          yield value
        } else {
          await new Promise((resolve, reject) => this.readers.push({ resolve, reject }))
        }
      }
    } finally {
      this.stream.off('data', this._ondata)
      this.stream.off('end', this._onend)
      this.stream.off('error', this._onerror)
    }
  }

  [Symbol.asyncIterator]() {
    return this._tail()
  }
}

module.exports = class Helper {
  static host = `${platform}-${arch}`
  static byArch = path.join('by-arch', Helper.host, 'bin', `pear-runtime${isWindows ? '.exe' : ''}`)
  static key = '63q1a8m8z678h19u3ckrzkdmpk7ydkp88jrrjwnkg7c5prf7kuxy'

  static createTestnet = createTestnet

  static getRandomId() {
    return Math.random().toString(16).slice(2)
  }

  static tmpDir(suffix = Helper.getRandomId()) {
    return path.join(os.tmpdir(), `pear-test-${suffix}`)
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
    if (Array.isArray(ptn)) return this.#untils(stream, ptn, by)
    for await (const output of stream) {
      if (ptn?.[by] !== 'error' && output[by] === 'error') {
        throw new Error(output?.data?.message ?? 'Unknown error')
      }
      if (this.matchesPattern(output, ptn)) return output.data
    }
    return null
  }

  static #untils(stream, patterns = [], by) {
    const untils = {}
    for (const ptn of patterns) {
      untils[ptn[by]] = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(
              'Helper: Data Timeout for ' +
                JSON.stringify(ptn) +
                ' after ' +
                MAX_OP_STEP_WAIT +
                'ms'
            )
          )
        }, MAX_OP_STEP_WAIT)
        const onclose = () => reject(new Error('Helper: Unexpected close on stream'))
        const onerror = (err) => reject(err)
        const ondata = (data) => {
          if (data === null || data?.tag === 'final') stream.off('close', onclose)
        }
        stream.on('data', ondata)
        stream.on('close', onclose)
        stream.on('error', onerror)
        const onpick = (data) => {
          const result = data === undefined ? true : data
          resolve(result)
        }
        this.pick(new Reiterate(stream), ptn, by)
          .then(onpick, reject)
          .finally(() => {
            clearTimeout(timeout)
            stream.off('data', ondata)
            stream.off('close', onclose)
            stream.off('error', onerror)
          })
      })
    }
    return untils
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

  static async replaceInFile(file, searchValue, replaceValue) {
    const content = await fs.promises.readFile(file, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (content === null) throw new Error(`File not found: ${file}`)
    const updatedContent = content.replace(searchValue, replaceValue)
    await fs.promises.writeFile(file, updatedContent, 'utf-8')
  }
}
