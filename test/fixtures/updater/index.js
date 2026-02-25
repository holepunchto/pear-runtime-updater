const { app, BrowserWindow, ipcMain } = require('electron')

const CI = !!process.env.CI
if (CI) {
  app.commandLine.appendSwitch('headless')
  app.commandLine.appendSwitch('disable-gpu')
}

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    offscreen: CI
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
