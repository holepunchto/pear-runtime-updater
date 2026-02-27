const { app, BrowserWindow, ipcMain } = require('electron')
const { isMac, isLinux } = require('which-runtime')
const os = require('os')
const path = require('path')
const PearRuntime = require('pear-runtime')
const pkg = require('./package.json')
const { name, productName, version, upgrade } = pkg

let pear
const appName = productName ?? name
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
    },
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
  const pear = await getPear()
  pear.updater.on('updating', function () { console.log('updating') })
  pear.updater.on('updated', function () { console.log('updated') })

  console.log('started', version, upgrade)
})()

async function getPear() {
  if (pear) return pear
  const appPath = getAppPath()
  let dir = null
  if (appPath === null) {
    dir = path.join(os.tmpdir(), 'pear', appName)
  } else {
    dir = isMac
      ? path.join(os.homedir(), 'Library', 'Application Support', appName)
      : isLinux
        ? path.join(os.homedir(), '.config', appName)
        : path.join(os.homedir(), 'AppData', 'Roaming', appName)
  }
  const bootstrap = JSON.parse(process.env.PEAR_BOOTSTRAP || '[]')
  pear = new PearRuntime({ dir, app: appPath, bootstrap, updates: true, version, upgrade })
  return pear
}

function getAppPath() {
  if (!app.isPackaged) return null
  if (isLinux && process.env.APPIMAGE) return process.env.APPIMAGE
  return path.join(process.resourcesPath, '..', '..')
}
