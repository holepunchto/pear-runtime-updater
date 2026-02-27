const { app, BrowserWindow } = require('electron')
const { isLinux } = require('which-runtime')
const path = require('path')
const Updater = require('pear-runtime-updater')
const pkg = require('./package.json')
const { version, upgrade } = pkg

const CI = !!process.env.CI
if (CI) app.disableHardwareAcceleration()

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
  return path.join(process.resourcesPath, '..', '..')
}

async function startUpdater() {
  console.log(`running ${version} ${upgrade}`)

  const appPath = getAppPath()
  const dir = process.env.PEAR_APPDIR
  const bootstrap = JSON.parse(process.env.PEAR_BOOTSTRAP || '[]')
  const updater = new Updater({
    dir,
    app: appPath,
    bootstrap,
    updates: true,
    version,
    upgrade
  })
  await updater.ready()
  app.on('quit', () => {
    updater.close()
  })

  updater.on('updating', function () {
    console.log('updating')
  })

  updater.on('updated', async function () {
    console.log('updated')

    await updater.applyUpdate()
    console.log('applied')

    app.quit()
  })

  if (version === '1.0.1') {
    app.quit()
  }
}
