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
    this.syncing = false
    this.syncPending = false
    this.updated = false

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

      this._syncBackground()
      this.drive.core.on('append', () => this._syncBackground())
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

  _syncBackground() {
    if (!this.updates) return
    if (this.syncing) {
      this.syncPending = true
      return
    }

    this.syncing = true
    this._sync()
      .catch((err) => this.emit('error', err))
      .finally(() => {
        this.syncing = false
        if (this.syncPending) {
          this.syncPending = false
          this._syncBackground()
        }
      })
  }

  async _sync() {
    await this._prefetchCurrent()
    await this._update()
  }

  _prefix() {
    return `/by-arch/${host}/app/${this.name}`
  }

  async _prefetchCurrent() {
    if (this.prefetched || !this.bundled) return
    if (this.drive.core.length === 0) return

    const length = await this._findCurrentVersionLength()
    if (!length) return

    const prefix = this._prefix()
    const co = this.drive.checkout(length)

    try {
      if (!(await co.has(prefix))) {
        await co.download(prefix).done()
      }
    } finally {
      await co.close()
    }

    this.prefetched = true
  }

  async _findCurrentVersionLength() {
    const prefix = this._prefix()

    for (let length = this.drive.core.length; length > 0; length--) {
      const co = this.drive.checkout(length)

      try {
        const manifest = await co.get('/package.json')
        if (!manifest) continue
        if (JSON.parse(manifest).version !== this.version) continue
        if (!(await hasEntries(co, prefix))) continue
        return length
      } finally {
        await co.close()
      }
    }

    return 0
  }

  async _update() {
    if (!this.updates) return

    const length = this.drive.core.length
    const id = length + '.' + this.drive.core.fork
    const next = path.join(this.dir, 'pear-runtime/next', id)
    const co = this.drive.checkout(length)

    this.checkout = co

    const manifest = await co.get('/package.json')

    const current = semver.Version.parse(this.version)
    const remote = manifest ? semver.Version.parse(JSON.parse(manifest).version) : null

    if (!remote || current.compare(remote) >= 0) {
      this.updating = false
      this.checkout = null
      await co.close()
      if (this.drive.core.length > length) this._updateBackground()
      return
    }

    const local = new Localdrive(next)

    this.emit('updating')
    const prefix = this._prefix()
    for await (const data of co.mirror(local, { prefix })) {
      this.emit('updating-delta', data)
    }

    await co.close()
    await local.close()

    this.checkout = null
    this.length = length
    this.next = next

    this.updated = true
    this.emit('updated')

    if (this.drive.core.length > length) this._syncBackground()
  }
}

async function hasEntries(drive, prefix) {
  for await (const entry of drive.list(prefix)) {
    return !!entry
  }

  return false
}

function noop() {}
