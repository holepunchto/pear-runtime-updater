const test = require('brittle')
const { spawn, spawnSync } = require('child_process')
const helper = require('./helper')
const path = require('path')
const { isLinux, isMac, isWindows, platform, arch } = require('which-runtime')
const fsp = require('fs/promises')
const Localdrive = require('localdrive')
const pearBuild = require('pear-build')

const host = platform + '-' + arch
const fixture = path.join(__dirname, 'fixtures', 'updater')
const npm = isWindows ? 'npm.cmd' : 'npm'
const powershell = 'pwsh.exe'

function getInstalledMsixExe(name) {
  const result = spawnSync(powershell, [
    '-Command',
    `(Get-AppxPackage -Name '${name}').InstallLocation`
  ])
  const installLocation = result.stdout.toString().trim()
  if (!installLocation) throw new Error('MSIX package not found: ' + name)
  return path.join(installLocation, 'app', name + '.exe')
}

function removeMsixPackage(name) {
  const child = spawn(
    powershell,
    ['-Command', `Get-AppxPackage -Name '${name}' | Remove-AppxPackage`],
    { stdio: 'ignore' }
  )
  return helper.waitForExit(child).catch(() => {})
}

function trustMsixCertificate(msixPath) {
  const child = spawn(
    powershell,
    [
      '-Command',
      `$sig=(Get-AuthenticodeSignature '${msixPath}').SignerCertificate; Export-Certificate -Cert $sig -FilePath "$env:TEMP\\msix-sign.cer" -Force | Out-Null; Import-Certificate -FilePath "$env:TEMP\\msix-sign.cer" -CertStoreLocation Cert:\\LocalMachine\\Root | Out-Null; Remove-Item "$env:TEMP\\msix-sign.cer" -Force;`
    ],
    { stdio: 'ignore' }
  )

  return helper.waitForExit(child)
}

let testnet
const unhookTestnet = test.hook('create testnet', async () => {
  testnet = await helper.createTestnet()
})

test('should receive and apply update when update happens while app is running', async (t) => {
  t.timeout(300_000)

  t.comment('prepare stager')
  const stager = await helper.createStager(t, { testnet })
  const link = stager.link
  t.ok(link, `prepared ${link}`)

  t.comment('prepare copy of fixture')
  const app = await t.tmp()
  await new Localdrive(fixture).mirror(new Localdrive(app)).done()

  t.comment('update app version and link')
  {
    const pkg = require(path.join(app, 'package.json'))
    pkg.version = '1.0.0'
    pkg.upgrade = link
    await fsp.writeFile(path.join(app, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
  }

  t.comment('build app')
  let appBuildPath
  {
    const child = spawn(npm, ['run', 'make'], { cwd: app, shell: true })
    await t.execution(helper.waitForExit(child), 'app built successfully')
  }
  if (isLinux) {
    appBuildPath = path.join(app, 'out', 'make', `Updater.AppImage`)
    await fsp.rename(path.join(app, 'out', 'make', `Updater-1.0.0-${arch}.AppImage`), appBuildPath)
  }
  if (isMac) appBuildPath = path.join(app, 'out', `Updater-${host}`, 'Updater.app')
  if (isWindows) appBuildPath = path.join(app, 'out', 'make', 'msix', arch, 'Updater.msix')

  t.comment(isWindows ? 'trust and install app' : 'copy build to run dir')
  const runDir = await t.tmp()
  let appRunPath
  if (isLinux) {
    appRunPath = path.join(runDir, 'Updater.AppImage')
    await fsp.mkdir(path.dirname(appRunPath), { recursive: true })
    await fsp.cp(appBuildPath, appRunPath)
  }
  if (isMac) {
    appRunPath = path.join(runDir, 'Updater.app')
    await new Localdrive(appBuildPath).mirror(new Localdrive(appRunPath)).done()
  }
  if (isWindows) {
    await t.execution(trustMsixCertificate(appBuildPath), 'trusted MSIX certificate successfully')

    const MSIXManager = require('msix-manager')
    const manager = new MSIXManager()
    await t.execution(manager.addPackage(appBuildPath), 'installed app successfully')
    t.teardown(() => removeMsixPackage('Updater'))

    appRunPath = getInstalledMsixExe('Updater')
  }

  t.comment('run pear-build')
  const staging = await t.tmp()
  await t.execution(
    pearBuild({
      package: path.join(app, 'package.json'),
      [`${platform}${arch.charAt(0).toUpperCase() + arch.slice(1)}App`]: appBuildPath,
      target: staging
    }).done(),
    'pear-build ran successfully'
  )

  t.comment('stage')
  await t.execution(stager.stage(staging), 'staged successfully')

  t.comment('seed')
  await t.execution(stager.seed(), 'seeded successfully')

  t.comment('run')
  const runParams = { args: [] }
  const appDir = await t.tmp()
  const baseArgs = [appDir, JSON.stringify(stager.bootstrap), '1.0.1']

  if (isLinux) {
    // needed because GHA does not support FUSE and SUID sandboxing
    runParams.args = ['--appimage-extract-and-run', '--no-sandbox', ...baseArgs]
    runParams.execPath = appRunPath
  }

  if (isMac) {
    runParams.args = [...baseArgs]
    runParams.execPath = path.join(appRunPath, 'Contents', 'MacOS', 'Updater')
  }

  if (isWindows) {
    runParams.args = [...baseArgs]
    runParams.execPath = appRunPath
  }

  let run = spawn(runParams.execPath, runParams.args, {
    cwd: app,
    stdio: 'pipe'
  })
  // On Windows, the process may exit with code 1 when terminated by the MSIX installer
  let exit = helper.waitForExit(run)

  t.comment('update app version')
  {
    const pkg = require(path.join(app, 'package.json'))
    pkg.version = '1.0.1'
    pkg.upgrade = link
    await fsp.writeFile(path.join(app, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
  }

  t.comment('rebuild app')
  {
    await t.execution(
      fsp.rm(path.join(app, 'out'), { recursive: true }),
      'removed old build successfully'
    )
    const child = spawn(npm, ['run', 'make'], { cwd: app, shell: true })
    await t.execution(helper.waitForExit(child), 'app rebuilt successfully')
  }
  if (isLinux) {
    await fsp.rename(path.join(app, 'out', 'make', `Updater-1.0.1-${arch}.AppImage`), appBuildPath)
  }

  t.comment('rerun pear-build')
  await t.execution(
    pearBuild({
      package: path.join(app, 'package.json'),
      [`${platform}${arch.charAt(0).toUpperCase() + arch.slice(1)}App`]: appBuildPath,
      target: staging
    }).done(),
    'pear-build ran successfully'
  )

  t.comment('restage')
  const updated = new Promise((resolve) =>
    run.stdout.on('data', (data) => {
      if (data.toString().includes('updated')) resolve()
    })
  )

  await t.execution(stager.stage(staging), 'restaged successfully')

  t.comment('check for update message')
  await t.execution(updated, 'got updated message')

  t.comment('wait for exit')
  await t.execution(exit, 'app exited successfully')

  if (isWindows) {
    t.comment('give time for MSIX installer to finish')
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }

  t.comment('rerun app')
  if (isWindows) {
    appRunPath = getInstalledMsixExe('Updater')
    runParams.execPath = appRunPath
  }
  run = spawn(runParams.execPath, runParams.args, {
    cwd: app,
    stdio: 'pipe'
  })
  exit = helper.waitForExit(run)

  t.comment('wait for version')
  const startedVersion = new Promise((resolve) => {
    run.stdout.on('data', (data) => {
      const dataStr = data.toString()
      if (dataStr.startsWith('running')) {
        resolve(dataStr.split(' ')[1])
      }
    })
  })

  t.is(await startedVersion, '1.0.1', 'version matches updated value (1.0.1)')

  await t.execution(exit, 'app exited successfully')
})

test('should receive and apply update when update happens while app is not running', async (t) => {
  t.timeout(300_000)

  t.comment('prepare stager')
  const stager = await helper.createStager(t, { testnet })

  const link = stager.link
  t.ok(link, `prepared ${link}`)

  t.comment('prepare copy of fixture')
  const app = await t.tmp()
  await new Localdrive(fixture).mirror(new Localdrive(app)).done()

  t.comment('update app version and link')
  {
    const pkg = require(path.join(app, 'package.json'))
    pkg.version = '1.0.0'
    pkg.upgrade = link
    await fsp.writeFile(path.join(app, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
  }

  t.comment('build app')
  let appBuildPath
  {
    const child = spawn(npm, ['run', 'make'], { cwd: app, shell: true })
    await t.execution(helper.waitForExit(child), 'app built successfully')
  }
  if (isLinux) {
    appBuildPath = path.join(app, 'out', 'make', `Updater.AppImage`)
    await fsp.rename(path.join(app, 'out', 'make', `Updater-1.0.0-${arch}.AppImage`), appBuildPath)
  }
  if (isMac) appBuildPath = path.join(app, 'out', `Updater-${host}`, 'Updater.app')
  if (isWindows) appBuildPath = path.join(app, 'out', 'make', 'msix', arch, 'Updater.msix')

  t.comment(isWindows ? 'trust and install app' : 'copy build to run dir')
  const runDir = await t.tmp()
  let appRunPath
  if (isLinux) {
    appRunPath = path.join(runDir, 'Updater.AppImage')
    await fsp.mkdir(path.dirname(appRunPath), { recursive: true })
    await fsp.cp(appBuildPath, appRunPath)
  }
  if (isMac) {
    appRunPath = path.join(runDir, 'Updater.app')
    await new Localdrive(appBuildPath).mirror(new Localdrive(appRunPath)).done()
  }
  if (isWindows) {
    await t.execution(trustMsixCertificate(appBuildPath), 'trusted MSIX certificate successfully')

    const MSIXManager = require('msix-manager')
    const manager = new MSIXManager()
    await t.execution(manager.addPackage(appBuildPath), 'installed app successfully')
    t.teardown(() => removeMsixPackage('Updater'))

    appRunPath = getInstalledMsixExe('Updater')
  }

  t.comment('run pear-build')
  const staging = await t.tmp()
  await t.execution(
    pearBuild({
      package: path.join(app, 'package.json'),
      [`${platform}${arch.charAt(0).toUpperCase() + arch.slice(1)}App`]: appBuildPath,
      target: staging
    }).done(),
    'pear-build ran successfully'
  )

  t.comment('stage')
  await t.execution(stager.stage(staging), 'staged successfully')

  t.comment('seed')
  await t.execution(stager.seed(), 'seeded successfully')

  t.comment('update app version')
  {
    const pkg = require(path.join(app, 'package.json'))
    pkg.version = '1.0.1'
    pkg.upgrade = link
    await fsp.writeFile(path.join(app, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
  }

  t.comment('rebuild app')
  {
    await t.execution(
      fsp.rm(path.join(app, 'out'), { recursive: true }),
      'removed old build successfully'
    )
    const child = spawn(npm, ['run', 'make'], { cwd: app, shell: true })
    await t.execution(helper.waitForExit(child), 'app rebuilt successfully')
  }
  if (isLinux) {
    await fsp.rename(path.join(app, 'out', 'make', `Updater-1.0.1-${arch}.AppImage`), appBuildPath)
  }

  t.comment('rerun pear-build')
  await t.execution(
    pearBuild({
      package: path.join(app, 'package.json'),
      [`${platform}${arch.charAt(0).toUpperCase() + arch.slice(1)}App`]: appBuildPath,
      target: staging
    }).done(),
    'pear-build ran successfully'
  )

  t.comment('restage')
  await t.execution(stager.stage(staging), 'restaged successfully')

  t.comment('run')
  const runParams = { args: [] }
  const appDir = await t.tmp()
  const baseArgs = [appDir, JSON.stringify(stager.bootstrap), '1.0.1']

  if (isLinux) {
    // needed because GHA does not support FUSE and SUID sandboxing
    runParams.args = ['--appimage-extract-and-run', '--no-sandbox', ...baseArgs]
    runParams.execPath = appRunPath
  }

  if (isMac) {
    runParams.args = [...baseArgs]
    runParams.execPath = path.join(appRunPath, 'Contents', 'MacOS', 'Updater')
  }

  if (isWindows) {
    runParams.args = [...baseArgs]
    runParams.execPath = appRunPath
  }

  let run = spawn(runParams.execPath, runParams.args, {
    cwd: app,
    stdio: 'pipe'
  })
  // On Windows, the process may exit with code 1 when terminated by the MSIX installer
  let exit = helper.waitForExit(run)
  const updated = new Promise((resolve) =>
    run.stdout.on('data', (data) => {
      if (data.toString().includes('updated')) resolve()
    })
  )

  t.comment('check for update message')
  await t.execution(updated, 'got updated message')

  t.comment('wait for exit')
  await t.execution(exit, 'app exited successfully')

  if (isWindows) {
    t.comment('give time for MSIX installer to finish')
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }

  t.comment('rerun app')
  if (isWindows) {
    appRunPath = getInstalledMsixExe('Updater')
    runParams.execPath = appRunPath
  }
  run = spawn(runParams.execPath, runParams.args, {
    cwd: app,
    stdio: 'pipe'
  })
  exit = helper.waitForExit(run)

  t.comment('wait for version')
  const startedVersion = new Promise((resolve) => {
    run.stdout.on('data', (data) => {
      const dataStr = data.toString()
      if (dataStr.startsWith('running')) {
        resolve(dataStr.split(' ')[1])
      }
    })
  })

  t.is(await startedVersion, '1.0.1', 'version matches updated value (1.0.1)')

  await t.execution(exit, 'app exited successfully')
})

test('should update from prerelease to release', async (t) => {
  t.timeout(300_000)

  t.comment('prepare stager')
  const stager = await helper.createStager(t, { testnet })

  const link = stager.link
  t.ok(link, `prepared ${link}`)

  t.comment('prepare copy of fixture')
  const app = await t.tmp()
  await new Localdrive(fixture).mirror(new Localdrive(app)).done()

  t.comment('update app version and link')
  {
    const pkg = require(path.join(app, 'package.json'))
    pkg.version = '1.0.0-rc.1'
    pkg.upgrade = link
    await fsp.writeFile(path.join(app, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
    if (isWindows) {
      const forgePath = path.join(app, 'forge.config.js')
      const forgeContent = await fsp.readFile(forgePath, 'utf8')
      await fsp.writeFile(
        forgePath,
        forgeContent.replace(
          "manifestVariables: { publisher: 'Holepunch' }",
          "manifestVariables: { publisher: 'Holepunch', packageVersion: '1.0.0.1' }"
        ),
        'utf8'
      )
    }
  }

  t.comment('build app')
  let appBuildPath
  {
    const child = spawn(npm, ['run', 'make'], { cwd: app, shell: true })
    await t.execution(helper.waitForExit(child), 'app built successfully')
  }
  if (isLinux) {
    appBuildPath = path.join(app, 'out', 'make', 'Updater.AppImage')
    await fsp.rename(
      path.join(app, 'out', 'make', `Updater-1.0.0-rc.1-${arch}.AppImage`),
      appBuildPath
    )
  }
  if (isMac) appBuildPath = path.join(app, 'out', `Updater-${host}`, 'Updater.app')
  if (isWindows) appBuildPath = path.join(app, 'out', 'make', 'msix', arch, 'Updater.msix')

  t.comment(isWindows ? 'trust and install app' : 'copy build to run dir')
  const runDir = await t.tmp()
  let appRunPath
  if (isLinux) {
    appRunPath = path.join(runDir, 'Updater.AppImage')
    await fsp.mkdir(path.dirname(appRunPath), { recursive: true })
    await fsp.cp(appBuildPath, appRunPath)
  }
  if (isMac) {
    appRunPath = path.join(runDir, 'Updater.app')
    await new Localdrive(appBuildPath).mirror(new Localdrive(appRunPath)).done()
  }
  if (isWindows) {
    await t.execution(trustMsixCertificate(appBuildPath), 'trusted MSIX certificate successfully')

    const MSIXManager = require('msix-manager')
    const manager = new MSIXManager()
    await t.execution(manager.addPackage(appBuildPath), 'installed app successfully')
    t.teardown(() => removeMsixPackage('Updater'))

    appRunPath = getInstalledMsixExe('Updater')
  }

  t.comment('run pear-build')
  const staging = await t.tmp()
  await t.execution(
    pearBuild({
      package: path.join(app, 'package.json'),
      [`${platform}${arch.charAt(0).toUpperCase() + arch.slice(1)}App`]: appBuildPath,
      target: staging
    }).done(),
    'pear-build ran successfully'
  )

  t.comment('stage')
  await t.execution(stager.stage(staging), 'staged successfully')

  t.comment('seed')
  await t.execution(stager.seed(), 'seeded successfully')

  t.comment('update app version')
  {
    const pkg = require(path.join(app, 'package.json'))
    pkg.version = '1.0.0'
    pkg.upgrade = link
    await fsp.writeFile(path.join(app, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
    if (isWindows) {
      const forgePath = path.join(app, 'forge.config.js')
      const forgeContent = await fsp.readFile(forgePath, 'utf8')
      await fsp.writeFile(
        forgePath,
        forgeContent.replace(
          "manifestVariables: { publisher: 'Holepunch', packageVersion: '1.0.0.1' }",
          "manifestVariables: { publisher: 'Holepunch' }"
        ),
        'utf8'
      )
    }
  }

  t.comment('rebuild app')
  {
    await t.execution(
      fsp.rm(path.join(app, 'out'), { recursive: true }),
      'removed old build successfully'
    )
    const child = spawn(npm, ['run', 'make'], { cwd: app, shell: true })
    await t.execution(helper.waitForExit(child), 'app rebuilt successfully')
  }
  if (isLinux) {
    await fsp.rename(path.join(app, 'out', 'make', `Updater-1.0.0-${arch}.AppImage`), appBuildPath)
  }

  t.comment('rerun pear-build')
  await t.execution(
    pearBuild({
      package: path.join(app, 'package.json'),
      [`${platform}${arch.charAt(0).toUpperCase() + arch.slice(1)}App`]: appBuildPath,
      target: staging
    }).done(),
    'pear-build ran successfully'
  )

  t.comment('restage')
  await t.execution(stager.stage(staging), 'restaged successfully')

  t.comment('run')
  const runParams = { args: [] }
  const appDir = await t.tmp()
  const baseArgs = [appDir, JSON.stringify(stager.bootstrap), '1.0.0']

  if (isLinux) {
    // needed because GHA does not support FUSE and SUID sandboxing
    runParams.args = ['--appimage-extract-and-run', '--no-sandbox', ...baseArgs]
    runParams.execPath = appRunPath
  }

  if (isMac) {
    runParams.args = [...baseArgs]
    runParams.execPath = path.join(appRunPath, 'Contents', 'MacOS', 'Updater')
  }

  if (isWindows) {
    runParams.args = [...baseArgs]
    runParams.execPath = appRunPath
  }

  let run = spawn(runParams.execPath, runParams.args, {
    cwd: app,
    stdio: 'pipe'
  })

  // On Windows, the process may exit with code 1 when terminated by the MSIX installer
  let exit = helper.waitForExit(run)
  const updated = new Promise((resolve) =>
    run.stdout.on('data', (data) => {
      if (data.toString().includes('updated')) resolve()
    })
  )

  t.comment('check for update message')
  await t.execution(updated, 'got updated message')

  t.comment('wait for exit')
  await t.execution(exit, 'app exited successfully')

  if (isWindows) {
    t.comment('give time for MSIX installer to finish')
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }

  t.comment('rerun app')
  if (isWindows) {
    appRunPath = getInstalledMsixExe('Updater')
    runParams.execPath = appRunPath
  }
  run = spawn(runParams.execPath, runParams.args, {
    cwd: app,
    stdio: 'pipe'
  })
  exit = helper.waitForExit(run)

  t.comment('wait for version')
  const startedVersion = new Promise((resolve) => {
    run.stdout.on('data', (data) => {
      const dataStr = data.toString()
      if (dataStr.startsWith('running')) {
        resolve(dataStr.split(' ')[1])
      }
    })
  })

  t.is(await startedVersion, '1.0.0', 'version matches updated value (1.0.0)')

  await t.execution(exit, 'app exited successfully')
})

unhookTestnet('destroy testnet', async () => {
  await testnet.destroy()
})
