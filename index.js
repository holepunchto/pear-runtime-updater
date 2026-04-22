const Hyperdrive = require('hyperdrive')
const Localdrive = require('localdrive')
const path = require('path')
const fs = require('fs')
const fsx = require('fs-native-extensions')
const ReadyResource = require('ready-resource')
const link = require('pear-link')
const hid = require('hypercore-id-encoding')
const { platform, arch, isWindows } = require('which-runtime')
const semver = require('bare-semver')
const debounceify = require('debounceify')
const host = platform + '-' + arch

module.exports = class PearRuntimeUpdater extends ReadyResource {
  constructor(opts = {}) {
    super()
    this.updates = opts.updates !== false
    if (!opts.dir) throw new Error('dir required')
    if (!opts.upgrade) throw new Error('upgrade link required')
    if (!opts.name) throw new Error('name required')
    if (!opts.store) throw new Error('store required')

    this.dir = opts.dir
    this.store = opts.store
    this.version = opts.version || '0.0.0-0'
    this.app = opts.app
    this.name = opts.name
    this.bundled = opts.bundled || !!this.app

    const { drive: upgrade } = link.parse(opts.upgrade)
    this.key = hid.decode(upgrade.key)
    this.length = upgrade.length || 0
    this.fork = upgrade.fork || 0
    this.link = link.serialize({ drive: { fork: this.fork, length: this.length, key: this.key } })
    this.drive = new Hyperdrive(this.store, this.key)

    this.next = null
    this.checkout = null
    this.prefetched = false
    this.updating = false
    this.updated = false

    this._update = debounceify(this._update.bind(this))

    this.ready().catch(noop)
  }

  async _open() {
    await this.drive.ready()
    if (!this.updates) return

    if (this.bundled) {
      await fs.promises.rm(path.join(this.dir, 'pear-runtime/next'), {
        recursive: true,
        force: true
      })

      this._updateBackground()
      this.drive.core.on('append', () => this._updateBackground())
    }
  }

  async _close() {
    await this.drive.close()

    if (!this.updates) return
    if (this.checkout !== null) await this.checkout.close()
  }

  async applyUpdate() {
    if (!this.updated || this.applied || !this.bundled) return
    this.applied = true

    const nextApp = path.join(this.next, 'by-arch', host, 'app', this.name)
    if (isWindows) {
      const MSIXManager = require('msix-manager') // require must be here for platform compatibility
      const manager = new MSIXManager()
      await manager.addPackage(nextApp, { forceUpdateFromAnyVersion: true })
    } else {
      await fsx.swap(nextApp, this.app)
    }
    await fs.promises.rm(this.next, { recursive: true, force: true })
  }

  _updateBackground() {
    this._update().catch((err) => this.emit('error', err))
  }

  async _update() {
    if (!this.updates) return

    await this.drive.update()

    const length = this.drive.core.length
    const id = length + '.' + this.drive.core.fork
    const next = path.join(this.dir, 'pear-runtime/next', id)
    const co = this.drive.checkout(length)

    this.checkout = co

    const manifest = await co.get('/package.json')

    const current = semver.Version.parse(this.version)
    const remote = manifest ? semver.Version.parse(JSON.parse(manifest).version) : null

    if (remote && current.compare(remote) === 0 && this.bundled && !this.prefetched) {
      try {
        await this._prefetchLatest()
      } catch (err) {
        this.emit('error', err)
      }
    }

    if (!remote || current.compare(remote) >= 0) {
      this.checkout = null
      await co.close()
      return
    }

    const local = new Localdrive(next)

    this.updating = true
    this.emit('updating')
    const prefix = prefixFor(host, this.name)
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
  }

  async _prefetchLatest() {
    const length = this.drive.core.length
    if (!length) return

    const co = this.drive.checkout(length)
    const prefix = prefixFor(host, this.name)

    try {
      if (!(await co.has(prefix))) {
        await co.download(prefix).done()
      }
    } finally {
      await co.close()
    }

    this.prefetched = true
  }
}

function prefixFor(host, name) {
  return `/by-arch/${host}/app/${name}`
}

function noop() {}
