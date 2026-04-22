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
const SquirrelManager = require('./squirrel-manager')
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
    this.windowsStagedPath = null

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
      const applied = await this._applyWindowsUpdate(nextApp)
      if (!applied) {
        const MSIXManager = require('msix-manager') // require must be here for platform compatibility
        const manager = new MSIXManager()
        await manager.addPackage(nextApp, { forceUpdateFromAnyVersion: true })
      }
    } else {
      await fsx.swap(nextApp, this.app)
    }
    await fs.promises.rm(this.next, { recursive: true, force: true })
  }

  _updateBackground() {
    this._update().catch((err) => this.emit('error', err))
  }

  async _update() {
    if (this.updating || !this.updates) return
    this.updating = true

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
      this.updating = false
      this.checkout = null
      await co.close()
      if (this.drive.core.length > length) this._updateBackground()
      return
    }

    const local = new Localdrive(next)

    this.emit('updating')
    const appRoot = `/by-arch/${host}/app`
    const prefix = await this._resolveMirrorPrefix(co, appRoot)
    for await (const data of co.mirror(local, { prefix })) {
      this.emit('updating-delta', data)
    }

    await co.close()
    await local.close()

    this.checkout = null
    this.length = length
    this.next = next
    this.windowsStagedPath = path.join(next, this._relativeStagedPathForPrefix(prefix, appRoot))

    this.updating = false
    this.updated = true
    this.emit('updated')

    if (this.drive.core.length > length) this._updateBackground()
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

  async _resolveMirrorPrefix(checkout, appRoot) {
    const fallback = prefixFor(host, this.name)
    if (!isWindows) return fallback

    const squirrel = new SquirrelManager()
    if (!squirrel.isSquirrelName(this.name)) return fallback

    const candidate = await squirrel.findCandidate(checkout, appRoot, { name: this.name })
    return candidate?.prefix || fallback
  }

  _relativeStagedPathForPrefix(prefix, appRoot) {
    const normalizedPrefix = String(prefix || '').replace(/\\/g, '/')
    if (!normalizedPrefix) return path.join('by-arch', host, 'app', this.name)
    const appRootNormalized = appRoot.replace(/\\/g, '/')

    if (normalizedPrefix === appRootNormalized) return path.join('by-arch', host, 'app')
    if (normalizedPrefix.startsWith(`${appRootNormalized}/`)) {
      const suffix = normalizedPrefix.slice(appRootNormalized.length + 1)
      return path.join('by-arch', host, 'app', suffix)
    }
    return path.join('by-arch', host, 'app', this.name)
  }

  async _applyWindowsUpdate(nextApp) {
    const squirrel = new SquirrelManager()
    const stagedPath = this.windowsStagedPath || nextApp
    const payload = await squirrel.payloadFromPath(stagedPath)
    if (!payload) return false

    await squirrel.apply(payload, { app: this.app })
    return true
  }
}

function prefixFor(host, name) {
  return `/by-arch/${host}/app/${name}`
}

function noop() {}
