const { app, BrowserWindow } = require('electron')
const { isLinux, isWindows, isMac } = require('which-runtime')
const path = require('path')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Updater = require('pear-runtime-updater')
const pkg = require('./package.json')
const { version, upgrade } = pkg

const CI = !!process.env.CI
if (CI) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-dev-shm-usage')
}

const positionalArgs = process.argv.slice(isLinux ? 2 : 1).filter((arg) => !arg.startsWith('-'))
const dir = positionalArgs?.[0]
const bootstrap = positionalArgs?.[1] ? JSON.parse(positionalArgs[1]) : undefined

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      offscreen: CI
    }
  })

  if (!CI) win.webContents.openDevTools()

  win.loadFile('index.html')
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })

  startUpdater()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function getAppPath() {
  if (!app.isPackaged) return null
  if (isLinux && process.env.APPIMAGE) return process.env.APPIMAGE
  if (isWindows) return process.execPath
  return path.join(process.resourcesPath, '..', '..')
}

async function startUpdater() {
  console.log(`running ${version} ${upgrade}`)

  const store = new Corestore(path.join(dir, 'pear-runtime/corestore'))
  const appPath = getAppPath()
  const updater = new Updater({
    dir,
    app: appPath,
    updates: true,
    version,
    upgrade,
    name: isLinux ? 'Updater.AppImage' : isMac ? 'Updater.app' : 'Updater.msix',
    store
  })

  await updater.ready()

  const keyPair = await store.createKeyPair('pear-runtime')
  const swarm = new Hyperswarm({ keyPair, bootstrap })
  swarm.on('connection', (connection) => store.replicate(connection))
  swarm.join(updater.drive.core.discoveryKey, {
    client: true,
    server: false
  })

  app.on('quit', async () => {
    await swarm.destroy()
    await updater.close()
    await store.close()
  })

  updater.on('updating', function () {
    console.log('updating')
  })

  updater.on('updated', async function () {
    console.log('updated')

    await updater.applyUpdate()

    app.quit()
  })

  if (version === '1.0.1') {
    app.quit()
  }
}
