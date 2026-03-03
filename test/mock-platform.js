const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const path = require('bare-path')
const ReadyResource = require('ready-resource')
const Localdrive = require('localdrive')
const pearLink = require('pear-link')

module.exports = class MockPlatform extends ReadyResource {
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
    const local = new Localdrive(dir)
    await local.ready()

    const mirror = local.mirror(this.drive, { prune: true, ...opts })
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
}
