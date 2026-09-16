import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { join } from 'path'
import { spawn, ChildProcess } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import http from 'http'

// ---------------------------------------------------------------------------
// Python sidecar lifecycle
// ---------------------------------------------------------------------------

const PORT = 8765
const SERVER_URL = `http://127.0.0.1:${PORT}`

let sidecar: ChildProcess | null = null
let sidecarReady = false

/**
 * Repo root: in dev the app runs from <repo>/gui/out/main, so the engine
 * lives three levels up. Packaged builds ship a PyInstaller-bundled
 * sidecar binary in resources/quill-sidecar/ (see packaging/sidecar.spec
 * and electron-builder.yml extraResources) — resolved here instead.
 */
function repoRoot(): string {
  return app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..', '..')
}

function pythonBin(): string {
  if (app.isPackaged) {
    const binName = process.platform === 'win32' ? 'quill-sidecar.exe' : 'quill-sidecar'
    const bundled = join(process.resourcesPath, 'quill-sidecar', binName)
    if (existsSync(bundled)) return bundled
    throw new Error(`bundled sidecar not found at ${bundled}`)
  }
  const venv = join(repoRoot(), '.venv')
  const bin = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
  const candidate = join(venv, bin)
  return existsSync(candidate) ? candidate : 'python3'
}

function startSidecar(): void {
  const bin = pythonBin()
  // Packaged: the binary IS the server (its own main() parses --port).
  // Dev: python -m quill_engine.api.server with the repo root as cwd.
  const args = app.isPackaged
    ? ['--port', String(PORT)]
    : ['-m', 'quill_engine.api.server', '--port', String(PORT)]
  console.log(`[sidecar] starting ${bin} ${args.join(' ')}`)
  sidecar = spawn(bin, args, {
    cwd: repoRoot(),
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  sidecar.on('error', (error) => console.error(`[sidecar] spawn failed: ${error}`))
  sidecar.stdout?.on('data', (chunk) => console.log(`[sidecar] ${chunk}`))
  sidecar.stderr?.on('data', (chunk) => console.error(`[sidecar] ${chunk}`))
  sidecar.on('exit', (code) => {
    console.warn(`[sidecar] exited with code ${code}`)
    sidecarReady = false
  })
}

function stopSidecar(): void {
  if (sidecar && sidecar.exitCode === null) {
    sidecar.kill('SIGTERM')
  }
  sidecar = null
}

/**
 * Populate ``process.env`` from a ``KEY=VALUE`` file (stdlib only), mirroring
 * ``quill_engine.config._load_dotenv`` so the GUI reads the same root `.env`
 * the sidecar does. Existing env vars win. In packaged builds the `.env` file
 * is not shipped, so this only runs in dev (the repo root sits three levels
 * above this bundled main process).
 */
function loadDotEnv(path: string): void {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return // missing .env is fine; exported env vars are enough
  }
  for (const line of text.split('\n')) {
    const stripped = line.trim()
    if (!stripped || stripped.startsWith('#') || !stripped.includes('=')) continue
    const index = stripped.indexOf('=')
    const key = stripped.slice(0, index).trim()
    const value = stripped.slice(index + 1).trim().replace(/^["']|["']$/g, '')
    if (key && !(key in process.env)) process.env[key] = value
  }
}

function healthOnce(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(`${SERVER_URL}/api/health`, { timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    request.on('timeout', () => {
      request.destroy()
      resolve(false)
    })
    request.on('error', () => resolve(false))
  })
}

async function waitForServer(timeoutMs = 45000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await healthOnce(1500)) {
      sidecarReady = true
      return true
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

// ---------------------------------------------------------------------------
// Window + IPC
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null

// Software rendering keeps the app alive on VMs/headsless GPUs where the
// GPU process would otherwise crash the whole app.
app.disableHardwareAcceleration()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#191b21',
    title: 'Quill',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Source File…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu:open-file')
        },
        {
          label: 'New Blank Document',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu:new-doc')
        },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' }
      ]
    },
    { label: 'Edit', role: 'editMenu' },
    { label: 'View', role: 'viewMenu' },
    { label: 'Help', submenu: [{ role: 'about' }] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function pickSourceFile(): Promise<string | null> {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open source document',
    properties: ['openFile'],
    filters: [
      { name: 'Documents', extensions: ['md', 'txt', 'docx', 'doc', 'pdf', 'pptx', 'html'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })
  return result.canceled ? null : result.filePaths[0]
}

async function pickSaveFile(defaultName: string, fmt: string): Promise<string | null> {
  if (!mainWindow) return null
  const filters =
    fmt === 'docx'
      ? [{ name: 'Word document', extensions: ['docx'] }]
      : fmt === 'pdf'
        ? [{ name: 'PDF document', extensions: ['pdf'] }]
        : [{ name: 'Markdown', extensions: ['md'] }]
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save document',
    defaultPath: defaultName,
    filters
  })
  return result.canceled ? null : result.filePath ?? null
}

app.whenReady().then(async () => {
  if (!app.isPackaged) loadDotEnv(join(repoRoot(), '.env'))
  startSidecar()
  const ready = await waitForServer()

  ipcMain.handle('server:url', () => SERVER_URL)
  ipcMain.handle('server:ready', () => sidecarReady)
  ipcMain.handle('app:google-fonts-key', () => process.env.GOOGLE_FONTS_KEY || '')
  ipcMain.handle('dialog:open-file', () => pickSourceFile())
  ipcMain.handle('dialog:save-file', (_event, defaultName: string, fmt: string) =>
    pickSaveFile(defaultName, fmt)
  )
  ipcMain.handle('app:documents-dir', () => app.getPath('documents'))

  buildMenu()
  createWindow()

  if (!ready) {
    mainWindow?.webContents.send('sidecar:failed')
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopSidecar()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', stopSidecar)
process.on('exit', stopSidecar)
