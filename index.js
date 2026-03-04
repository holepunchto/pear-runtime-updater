const Hyperswarm = require('hyperswarm')
const Hyperdrive = require('hyperdrive')
const Localdrive = require('localdrive')
const Corestore = require('corestore')
const path = require('path')
const fs = require('fs')
const fsx = require('fs-native-extensions')
const ReadyResource = require('ready-resource')
const link = require('pear-link')
const hid = require('hypercore-id-encoding')
const { platform, arch, isWindows } = require('which-runtime')
const host = platform + '-' + arch

module.exports = class PearRuntime extends ReadyResource {
  constructor(opts = {}) {
    super()
    this.updates = opts.updates !== false
    if (!opts.dir) throw new Error('dir required')
    if (!opts.upgrade) throw new Error('upgrade link required')

    this.dir = opts.dir
    this.version = opts.version || 0
    this.app = opts.app
    this.name = opts.name ?? (this.app && path.basename(this.app))
    if (isWindows) this.name = path.basename(this.name, path.extname(this.name)) + '.msix'
    this.bootstrap = opts.bootstrap
    this.bundled = opts.bundled || !!this.app

    if (this.updates) {
      const { drive: upgrade } = link.parse(opts.upgrade)
      this.key = hid.decode(upgrade.key)
      this.length = upgrade.length || 0
      this.fork = upgrade.fork || 0
      this.link = link.serialize({ drive: { fork: this.fork, length: this.length, key: this.key } })
      this.store = new Corestore(path.join(this.dir, 'pear-runtime/corestore'))
      this.drive = new Hyperdrive(this.store, this.key)
    } else {
      this.key = null
      this.length = null
      this.fork = null
      this.link = null
      this.store = null
      this.drive = null
    }

    this.swarm = null
    this.next = null
    this.checkout = null
    this.updating = false
    this.updated = false

    this.ready().catch(noop)
  }

  async _open() {
    if (!this.updates) return
    await this.drive.ready()

    if (this.bundled) {
      await fs.promises.rm(path.join(this.dir, 'pear-runtime/next'), {
        recursive: true,
        force: true
      })

      if (!this.swarm) {
        const keyPair = await this.store.createKeyPair('pear-container')
        this.swarm = new Hyperswarm({ keyPair, bootstrap: this.bootstrap })
      }

      this.swarm.on('connection', (connection) => this.store.replicate(connection))
      this.swarm.join(this.drive.core.discoveryKey, {
        client: true,
        server: false
      })

      this._updateBackground()
      this.drive.core.on('append', () => this._updateBackground())
    }
  }

  async _close() {
    if (!this.updates) return

    await this.drive.close()
    if (this.checkout !== null) await this.checkout.close()
    await this.store.close()
    await this.swarm.destroy()
  }

  async applyUpdate() {
    if (!this.updated || this.applied || !this.bundled) return
    this.applied = true

    const nextApp = path.join(this.next, 'by-arch', host, 'app', this.name)
    if (isWindows) {
      console.log('Updating to', nextApp)
      const MSIXManager = require('msix-manager') // require must be here for platform compatibility
      console.log('Instantiating MSIXManager')
      const manager = new MSIXManager()
      console.log('Installing', nextApp)
      await manager.addPackage(nextApp)
      console.log('Installed')
    } else {
      await fsx.swap(nextApp, this.app)
    }
    await fs.promises.rm(this.next, { recursive: true, force: true })
  }

  _updateBackground() {
    this._update().catch(noop)
  }

  async _update() {
    if (this.updating || !this.updates) return
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
    const prefix = `/by-arch/${host}/app/${this.name}`
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
