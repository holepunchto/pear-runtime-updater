const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const SQUIRREL_EXTENSIONS = new Set(['.nupkg'])

module.exports = class SquirrelManager {
  isSquirrelName(name) {
    const normalized = String(name || '').toLowerCase()
    if (!normalized) return false
    if (normalized === 'releases') return true
    if (normalized.includes('squirrel')) return true
    return SQUIRREL_EXTENSIONS.has(path.extname(normalized))
  }

  async payloadFromPath(targetPath) {
    const stat = await statIfExists(targetPath)
    if (!stat) return null
    if (stat.isDirectory()) return { type: 'feed', feed: targetPath }

    const ext = path.extname(targetPath).toLowerCase()
    if (ext === '.nupkg') return { type: 'feed', feed: path.dirname(targetPath) }
    if (ext === '.exe') return { type: 'installer', file: targetPath }

    return null
  }

  async findCandidate(checkout, appRoot, opts = {}) {
    const requested = normalizedName(opts.name)
    const candidates = []

    for await (const entry of checkout.list(appRoot)) {
      const key = entry.key || String(entry)
      const basename = path.basename(key).toLowerCase()
      const ext = path.extname(key).toLowerCase()
      const parent = path.dirname(key).replace(/\\/g, '/')

      if (basename === 'releases' || ext === '.nupkg') {
        candidates.push({
          key: parent,
          prefix: parent,
          score: scoreCandidate(parent, requested)
        })
      } else if (ext === '.exe') {
        candidates.push({
          key,
          prefix: key,
          score: scoreCandidate(key, requested) + 1
        })
      }
    }

    candidates.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    return candidates[0] || null
  }

  async apply(payloadOrPath, opts = {}) {
    const payload =
      typeof payloadOrPath === 'string' ? await this.payloadFromPath(payloadOrPath) : payloadOrPath
    if (!payload) throw new Error('Squirrel update payload not found')

    if (payload.type === 'installer') {
      const installerArgs = opts.installerArgs || ['--silent']
      await run(payload.file, installerArgs)
      return payload
    }

    const updateExe = resolveUpdateExe(opts)
    const updateArgs = opts.updateArgs || ['--update']
    await run(updateExe, [...updateArgs, payload.feed])
    return payload
  }
}

async function statIfExists(file) {
  try {
    return await fs.promises.stat(file)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

function normalizedName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function scoreCandidate(key, requested) {
  const normalized = normalizedName(key)
  let score = 0
  if (normalized.includes('squirrel')) score += 10
  if (requested && normalized.includes(requested)) score += 5
  if (normalized.includes('setup')) score += 2
  return score
}

function resolveUpdateExe(opts = {}) {
  const proc = getProcess()
  const candidates = [
    opts.updateExe,
    proc?.env?.SQUIRREL_UPDATE_EXE,
    fromProcessExecPath(),
    fromAppPath(opts.app)
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error('Squirrel Update.exe not found')
}

function fromProcessExecPath() {
  const proc = getProcess()
  if (!proc?.execPath) return null
  const appVersionDir = path.dirname(proc.execPath)
  return path.join(path.dirname(appVersionDir), 'Update.exe')
}

function fromAppPath(app) {
  if (!app) return null
  const appDir = path.extname(app) ? path.dirname(app) : app
  return path.join(path.dirname(appDir), 'Update.exe')
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      windowsHide: true
    })

    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve()
      reject(new Error(`${path.basename(command)} failed with ${signal || `exit code ${code}`}`))
    })
  })
}

function getProcess() {
  return typeof globalThis.process !== 'undefined' ? globalThis.process : null
}
