const createTestnet = require('@hyperswarm/testnet')
const { platform, arch } = require('which-runtime')
const path = require('path')
const Localdrive = require('localdrive')
const ReadyResource = require('ready-resource')
const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const pearLink = require('pear-link')

module.exports = {
  host: `${platform}-${arch}`,
  createTestnet: createTestnet,

  Stager: class Stager extends ReadyResource {
    constructor({ dir, bootstrap }) {
      super()
      this.dir = dir
      this.bootstrap = bootstrap
    }

    async _open() {
      this.store = new Corestore(path.join(this.dir, 'pear-runtime', 'corestore'))
      this.drive = new Hyperdrive(this.store, {})
      await this.drive.ready()
      this.keyPair = await this.store.createKeyPair('pear-container')
      this.swarm = new Hyperswarm({ keyPair: this.keyPair, bootstrap: this.bootstrap })

      this.swarm.on('connection', (connection) => {
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
      const local = new Localdrive(dir)
      await local.ready()

      const mirror = local.mirror(this.drive, { dedup: true, batch: true, ...opts })
      await mirror.done()

      await local.close()
    }

    async seed(opts = {}) {
      this.discovery = this.swarm.join(this.drive.discoveryKey, { server: true, ...opts })
      await this.discovery.flushed()
    }

    get link() {
      return pearLink.serialize(this.drive.key)
    }
  },

  async waitForExit(child) {
    await new Promise((resolve, reject) => {
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`Failed with exit code ${code}`))
      })
      child.on('error', reject)
    })
  },

  async waitFor(assertion, { timeout = 20_000, interval = 100 } = {}) {
    const start = Date.now()
    let lastError = null

    while (Date.now() - start < timeout) {
      try {
        if (await assertion()) return
        lastError = null
      } catch (err) {
        lastError = err
      }

      await new Promise((resolve) => setTimeout(resolve, interval))
    }

    throw lastError || new Error(`Timed out after ${timeout}ms`)
  }
}
