import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import Localdrive from 'localdrive'
import { isWindows, platform } from 'which-runtime'

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname)
const fixtureDir = path.join(projectRoot, 'test', 'fixtures', 'updater')
const dest = path.join(fixtureDir, 'node_modules', 'pear-runtime-updater')

const allowScripts = {
  darwin: ['electron', 'macos-alias', 'fs-xattr'],
  linux: ['electron'],
  win32: ['electron']
}

await run(fixtureDir, 'npm', ['install'])
await runLifecycleScripts(fixtureDir, allowScripts[platform])

// Replace the file:../../.. symlink with actual project files
await fs.promises.rm(dest, { recursive: true, force: true })

const src = new Localdrive(projectRoot)
const dst = new Localdrive(dest)

for (const file of ['/package.json', '/index.js', '/index.d.ts']) {
  const content = await src.get(file)
  if (content) await dst.put(file, content)
}

await src.close()
await dst.close()

await run(dest, 'npm', ['install', '--omit=dev'])

async function runLifecycleScripts(dir, allowed) {
  const nm = path.join(dir, 'node_modules')

  for (const entry of allowed) {
    const pkgPath = path.join(nm, entry)
    const pkgFile = path.join(pkgPath, 'package.json')
    if (!fs.existsSync(pkgFile)) continue

    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
    const scripts = pkg.scripts || {}
    const hasGyp = fs.existsSync(path.join(pkgPath, 'binding.gyp'))

    for (const event of ['preinstall', 'install', 'postinstall']) {
      const cmd = scripts[event] || (event === 'install' && hasGyp ? 'node-gyp rebuild' : null)
      if (!cmd) continue
      console.log(`running ${event} for ${entry}`)
      await new Promise((resolve, reject) => {
        const child = spawn(cmd, { cwd: pkgPath, stdio: 'inherit', shell: true })
        child.on('exit', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`${event} script for ${entry} failed with exit code ${code}`))
        })
        child.on('error', reject)
      })
    }
  }
}

function run(cwd, cmd, args) {
  if (isWindows) {
    args = ['-Command', `${cmd} ${args.join(' ')}`]
    cmd = 'pwsh'
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} failed with exit code ${code}`))
    })
    child.on('error', reject)
  })
}
