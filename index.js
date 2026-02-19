const Hyperswarm = require('hyperswarm')
const Hyperdrive = require('hyperdrive')
const Localdrive = require('localdrive')
const Corestore = require('corestore')
const path = require('path')
const fs = require('fs')
const ReadyResource = require('ready-resource')
const link = require('pear-link')
const hid = require('hypercore-id-encoding')
const { platform, arch } = require('which-runtime')
const host = platform + '-' + arch

module.exports = class PearRuntime extends ReadyResource {
  constructor(config) {
    super()

    if (config.updates === false) return {}
    if (!config.dir) throw new Error('dir required')
    if (!config.link) throw new Error('upgrade link required')
    const { drive } = link.parse(config.link)
    this.dir = config.dir
    this.version = config.version || 0
    this.key = hid.decode(drive.key)
    this.length = drive.length || 0
    this.fork = drive.fork || 0
    this.link = link.serialize({
      drive: { fork: this.fork, length: this.length, key: this.key }
    })
    this.store = new Corestore(path.join(this.dir, 'pear-runtime/corestore'))
    this.drive = new Hyperdrive(this.store, this.key)
    this.swarm = null
    this.next = null
    this.checkout = null

    this.updating = false
    this.updated = false

    this.ready().catch(noop)
  }

  async _open() {
    await fs.promises.rm(path.join(this.dir, 'pear-runtime/next'), {
      recursive: true,
      force: true
    })

    if (!this.swarm) {
      const keyPair = await this.store.createKeyPair('pear-container')
      this.swarm = new Hyperswarm({ keyPair })
    }

    this.swarm.on('connection', (connection) => this.store.replicate(connection))
    this.swarm.join(this.drive.core.discoveryKey, {
      client: true,
      server: false
    })

    this._updateBackground()
    this.drive.core.on('append', () => this._updateBackground())
  }

  async _close() {
    await this.drive?.close()
    await this.checkout?.close()
    await this.store?.destroy()
    await this.swarm?.destroy()
  }

  _updateBackground() {
    this._update().catch(noop)
  }

  async _update() {
    if (this.updating) return
    this.updating = true

    const length = this.drive.core.length
    const id = length + '.' + this.drive.core.fork
    const next = path.join(this.dir, 'pear-runtime/next', id)
    const co = this.drive.checkout(length)

    this.checkout = co

    const manifest = await co.get('/package.json')
    if (!manifest || JSON.parse(manifest).version === this.version) {
      this.updating = false
      this.checkout = null
      await co.close()
      return
    }

    const local = new Localdrive(next)

    this.emit('updating')
    const prefix = '/by-arch/' + host + '/app/' + this.name
    for await (const data of co.mirror(local, { prefix })) {
      this.emit('updating-delta', data)
    }

    await co.close()
    await local.close()

    this.checkout = null
    this.length = length
    this.next = next

    this.updating = false
    this.updated = true
    this.emit('updated')

    if (this.drive.core.length > length) this._updateBackground()
  }
}

function noop() {}
