const { app, BrowserWindow, ipcMain } = require('electron')
const { isLinux } = require('which-runtime')
const path = require('path')
const Updater = require('pear-runtime-updater')
const pkg = require('./package.json')
const { version, upgrade } = pkg

const CI = !!process.env.CI
if (CI) {
  app.commandLine.appendSwitch('headless')
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-dev-shm-usage')
  app.commandLine.appendSwitch('no-sandbox')
  app.disableHardwareAcceleration()
}

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
})

ipcMain.on('log', (event, message) => {
  console.log(message)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
;(async () => {
  console.log('running')
  const updater = await getUpdater()
  updater.on('updating', function () {
    console.log('updating')
  })
  updater.on('updated', function () {
    console.log('updated')
  })

  console.log('started', version, upgrade)
})()

async function getUpdater() {
  const appPath = getAppPath()
  const dir = process.env.PEAR_APPDIR
  const bootstrap = JSON.parse(process.env.PEAR_BOOTSTRAP || '[]')
  return new Updater({ dir, app: appPath, bootstrap, updates: true, version, upgrade })
}

function getAppPath() {
  if (!app.isPackaged) return null
  if (isLinux && process.env.APPIMAGE) return process.env.APPIMAGE
  return path.join(process.resourcesPath, '..', '..')
}
