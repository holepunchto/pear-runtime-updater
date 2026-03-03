const fs = require('bare-fs')
const os = require('bare-os')
const createTestnet = require('@hyperswarm/testnet')
const { platform, arch } = require('which-runtime')
const path = require('bare-path')
const Localdrive = require('localdrive')
const ReadyResource = require('ready-resource')
const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const pearLink = require('pear-link')

module.exports = class Helper {
  static host = `${platform}-${arch}`
  static createTestnet = createTestnet

  static MockPlatform = class MockPlatform extends ReadyResource {
    constructor({ dir, key, bootstrap }) {
      super()
      this.key = key
      this.dir = dir
      this.bootstrap = bootstrap
    }

    async _open() {
      this.store = new Corestore(path.join(this.dir, 'pear-runtime', 'corestore'))
      this.drive = new Hyperdrive(this.store, {})
      await this.drive.ready()
      this.keyPair = await this.store.createKeyPair('pear-container')
      this.swarm = new Hyperswarm({ keyPair: this.keyPair, bootstrap: this.bootstrap })

      this.swarm.on('connection', (connection, peerInfo) => {
        this.store.replicate(connection)
      })
    }

    async _close() {
      if (this.discovery) await this.discovery.destroy()
      await this.swarm.destroy()
      await this.drive.close()
      await this.store.close()
    }

    async stage(dir, opts = {}) {
      console.log('length before stage', this.drive.core.length)
      const local = new Localdrive(dir)
      await local.ready()

      const mirror = local.mirror(this.drive, { prune: true, ...opts })
      for await (const diff of mirror) {
        console.log('mirror', diff)
      }

      console.log('length after stage', this.drive.core.length)

      await local.close()
    }

    async seed(opts = {}) {
      this.discovery = this.swarm.join(this.drive.discoveryKey, { server: true, ...opts })
      await this.discovery.flushed()
    }

    get link() {
      return pearLink.serialize(this.drive.key)
    }
  }

  static getRandomId() {
    return Math.random().toString(16).slice(2)
  }

  static tmpDir(name = '', suffix = Helper.getRandomId()) {
    return path.join(os.tmpdir(), `pear-test-${name ? name + '-' : ''}${suffix}`)
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
