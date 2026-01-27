const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const config = require('./src-main/config');
const SettingsStore = require('./src-main/settings-store');
const pgadminUtils = require('./src-main/pgadmin-utils');
const net = require('net');
const http = require('http'); // Import http for robust polling

// Set App Name Early for Dock/Menu
app.setName('Portable PostGIS Desktop');
if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
}

// Enable live reload for all files in the project directory
    // excluding node_modules and data directory to avoid loops
    // Also excluding 'bin' to prevent reload when pgAdmin config_local.py is written
    if (!app.isPackaged) {
        require('electron-reload')(__dirname, {
            electron: path.join(__dirname, 'node_modules', '.bin', 'electron'),
            ignored: /node_modules|data|bin|[\/\\]\./
        });
    }

app.on('window-all-closed', function () {
    processManager.stopAll();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    processManager.stopAll();
});


let mainWindow;
let currentSettings = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1024,
        height: 768,
        icon: path.join(__dirname, 'assets', 'icon.png'),
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#00000000', // Transparent to let app background show through
            symbolColor: '#32b8c6', // Teal-300 for controls
            height: 32 // Standard height
        },
        autoHideMenuBar: true, // Hide default menu bar (File, Edit, etc.) for clean look
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'src', 'preload.js'),
            webviewTag: true // Enable webview for embedding pgAdmin
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

    mainWindow.on('closed', function () {
        mainWindow = null;
        isUiReady = false; // Reset UI ready state
        logBuffer = [];
    });
}

const services = require('./src-main/services');
const processManager = require('./src-main/process-manager');

// Listen for process exits (crashes, manual stops)
processManager.on('process-exit', ({ id, code }) => {
    console.log(`Service ${id} exited with code ${code}`);
    if (mainWindow && isUiReady) {
        mainWindow.webContents.send('service-exited', { id, code });
    }
});

// Log buffering
let logBuffer = [];
let isUiReady = false;

// Helper to check port availability
const checkPort = (port, host = '127.0.0.1') => {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve(false);
            } else {
                resolve(false); // Other error, assume not available for safety
            }
        });
        server.once('listening', () => {
            server.close();
            resolve(true);
        });
        server.listen(port, host);
    });
};

// Start services logic
async function startAppServices(settings) {
    // Deprecated: We now use granular start/stop from renderer
    // But keeping this as a helper if needed, or for initial check?
    // Actually, we will remove the auto-start logic from here and move it to renderer control.
}

ipcMain.on('ui-ready', () => {
    console.log('UI is ready. Flushing logs...');
    isUiReady = true;
    if (mainWindow) {
        logBuffer.forEach(msg => mainWindow.webContents.send('log', msg));
        logBuffer = [];
    }
    // No longer auto-starting services here. Renderer will initiate.
});

// Granular Service Control IPC
ipcMain.handle('start-postgres', async (event, port) => {
    const sendLog = (msg) => {
        console.log(msg);
        if (isUiReady && mainWindow) mainWindow.webContents.send('log', msg);
    };
    try {
        await services.startPostgres(sendLog, port);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('stop-postgres', async () => {
    services.stopPostgres();
    return { success: true };
});

ipcMain.handle('start-pgadmin', async (event, pgPort, adminPort) => {
    // Ensure theme is synced before starting
    if (currentSettings) {
        await pgadminUtils.setPgAdminTheme(currentSettings.theme);
    }
    
    const sendLog = (msg) => {
        console.log(msg);
        if (isUiReady && mainWindow) mainWindow.webContents.send('log', msg);
    };
    try {
        await services.startPgAdmin(sendLog, pgPort, adminPort);
        
        // Wait for pgAdmin readiness
        const pollInterval = 1000;
        const maxRetries = 30;
        let retries = 0;
        
        const checkHttp = (url) => {
            return new Promise((resolve) => {
                const req = http.get(url, (res) => {
                    // Any response means the server is up
                    // We can check res.statusCode if we want to be stricter, but 
                    // even a 404 or 302 means the server is listening.
                    res.resume();
                    resolve({ success: true, status: res.statusCode });
                });
                req.on('error', (err) => {
                    resolve({ success: false, error: err.message });
                });
                req.setTimeout(2000, () => {
                    req.destroy();
                    resolve({ success: false, error: 'timeout' });
                });
            });
        };

        sendLog('Waiting for pgAdmin to be ready...');
        while (retries < maxRetries) {
            // Try 127.0.0.1
            const urlIP = `http://127.0.0.1:${adminPort}`;
            const resIP = await checkHttp(urlIP);
            
            if (resIP.success) {
                if (mainWindow) mainWindow.webContents.send('pgadmin-ready', urlIP);
                sendLog(`[pgadmin] Ready at ${urlIP} (Status: ${resIP.status})`);
                return { success: true };
            }

            // Fallback try localhost
            const urlLocal = `http://localhost:${adminPort}`;
            const resLocal = await checkHttp(urlLocal);
            
            if (resLocal.success) {
                if (mainWindow) mainWindow.webContents.send('pgadmin-ready', urlLocal);
                sendLog(`[pgadmin] Ready at ${urlLocal} (Status: ${resLocal.status})`);
                return { success: true };
            }
            
            // Log failure reason periodically or on last retry
            if (retries % 5 === 0) {
                 sendLog(`[debug] Poll failed. 127.0.0.1: ${resIP.error}, localhost: ${resLocal.error}`);
            }

            await new Promise(r => setTimeout(r, pollInterval));
            retries++;
            sendLog(`Waiting for pgAdmin... (${retries}/${maxRetries})`);
        }
        return { success: false, error: 'Timed out waiting for pgAdmin' };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('stop-pgadmin', async () => {
    services.stopPgAdmin();
    return { success: true };
});

ipcMain.on('retry-start-services', async () => {
    // Deprecated
});

// Settings IPC
ipcMain.handle('get-settings', async () => {
    return await SettingsStore.load();
});

ipcMain.handle('save-settings', async (event, newSettings) => {
    currentSettings = await SettingsStore.save(newSettings);
    // Sync theme with pgAdmin preferences immediately
    if (currentSettings && currentSettings.theme) {
        await pgadminUtils.setPgAdminTheme(currentSettings.theme);
        console.log(`[Main] Synced theme '${currentSettings.theme}' to pgAdmin DB.`);
    }
    return currentSettings;
});

ipcMain.handle('check-port', async (event, port) => {
    return await checkPort(port);
});

ipcMain.handle('relaunch-app', () => {
    app.relaunch();
    app.exit(0);
});

app.on('ready', async () => {
    if (process.platform === 'darwin') {
        app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
    }
    app.setName('Portable PostGIS Desktop');
    currentSettings = await SettingsStore.load();
    await createWindow();
    // Sync theme with pgAdmin preferences
    if (currentSettings) {
        await pgadminUtils.setPgAdminTheme(currentSettings.theme);
    }

    // Small delay to ensure window is initialized before potential conflict events
    // But ideally we wait for ui-ready. 
    // Let's modify: We will start services ONLY after UI is ready to ensure user sees logs/errors.
});

// We'll move the start logic to 'ui-ready' listener to be safe and simple
ipcMain.removeAllListeners('ui-ready'); // Remove the previous simple one
ipcMain.on('ui-ready', () => {
    console.log('UI is ready.');
    isUiReady = true;
    // Flush logs if any (from main process initialization?)
    logBuffer.forEach(msg => mainWindow.webContents.send('log', msg));
    logBuffer = [];
    
    // Auto-start is now handled by the renderer calling 'start-postgres' based on its own logic/settings
    // We do NOT call startAppServices(currentSettings) here anymore.
});

// ... existing IPC handlers ...


// IPC Handlers for Extensions
ipcMain.handle('show-confirm', async (event, message) => {
    if (!mainWindow) return false;
    const result = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['OK', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: message,
        icon: null, // No icon as requested
        noLink: true,
        title: 'Portable PostGIS Desktop'
    });
    return result.response === 0;
});

ipcMain.handle('check-extensions', async () => {
    // Construct path to psql
    let psqlPath = config.PATHS.POSTGRES_BIN;
    // Replace 'postgres' executable with 'psql'
    if (process.platform === 'win32') {
        psqlPath = psqlPath.replace('postgres.exe', 'psql.exe');
    } else {
        psqlPath = psqlPath.replace(/postgres$/, 'psql');
    }

    const { exec } = require('child_process');
    const execAsync = require('util').promisify(exec);
    
    try {
        // Query pg_extension catalog: name|version
        const cmd = `"${psqlPath}" -U postgres -d postgres -A -t -c "SELECT extname, extversion FROM pg_extension;"`;
        const { stdout } = await execAsync(cmd);
        
        const extensions = stdout.trim().split('\n').map(line => {
            const parts = line.trim().split('|');
            if (parts.length >= 2) {
                return { name: parts[0].trim(), version: parts[1].trim() };
            }
            return null;
        }).filter(e => e);
        
        return extensions;
    } catch (e) {
        console.error('Failed to check extensions:', e);
        return [];
    }
});

ipcMain.handle('open-external', async (event, url) => {
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { success: true };
});


ipcMain.handle('wipe-data', async () => {
    console.log('Received wipe-data request');
    try {
        // 1. Stop all services
        await processManager.stopAll();
        
        // 2. Wait a bit to ensure files are released
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // 3. Remove data directory
        const fs = require('fs-extra');
        if (await fs.pathExists(config.PATHS.DATA)) {
            await fs.remove(config.PATHS.DATA);
            console.log('Data directory wiped successfully');
        }
        
        // 4. Clear Electron Session Data (Cookies, Local Storage, etc.)
        if (mainWindow) {
            console.log('Clearing session data...');
            await mainWindow.webContents.session.clearStorageData();
        }

        // 5. Relaunch the application
        app.relaunch();
        app.exit(0);
        
        return { success: true };
    } catch (e) {
        console.error('Failed to wipe data:', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('enable-extension', async (event, extName) => {
    let psqlPath = config.PATHS.POSTGRES_BIN;
    if (process.platform === 'win32') {
        psqlPath = psqlPath.replace('postgres.exe', 'psql.exe');
    } else {
        psqlPath = psqlPath.replace(/postgres$/, 'psql');
    }

    const { exec } = require('child_process');
    const execAsync = require('util').promisify(exec);
    
    try {
        // Sanitize extName to avoid injection (basic check)
        if (!/^[a-zA-Z0-9_]+$/.test(extName)) {
                    throw new Error("Invalid extension name");
                }
                const cmd = `"${psqlPath}" -U postgres -d postgres -c "CREATE EXTENSION IF NOT EXISTS \\"${extName}\\" CASCADE;"`;
                await execAsync(cmd);
                return { success: true };
    } catch (e) {
        console.error(`Failed to enable extension ${extName}:`, e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('disable-extension', async (event, extName) => {
    let psqlPath = config.PATHS.POSTGRES_BIN;
    if (process.platform === 'win32') {
        psqlPath = psqlPath.replace('postgres.exe', 'psql.exe');
    } else {
        psqlPath = psqlPath.replace(/postgres$/, 'psql');
    }

    const { exec } = require('child_process');
    const execAsync = require('util').promisify(exec);
    
    try {
        // Sanitize extName to avoid injection (basic check)
        if (!/^[a-zA-Z0-9_]+$/.test(extName)) {
            throw new Error("Invalid extension name");
        }
        const cmd = `"${psqlPath}" -U postgres -d postgres -c "DROP EXTENSION IF EXISTS \\"${extName}\\" CASCADE;"`;
        await execAsync(cmd);
        return { success: true };
    } catch (e) {
        console.error(`Failed to disable extension ${extName}:`, e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-available-extensions', async () => {
    try {
        const fs = require('fs-extra');
        // Resolve extension directory relative to BIN_DIR
        // config.PATHS.BIN is bin/mac or bin/win
        // Extensions are usually in:
        // Mac: bin/mac/postgres/share/postgresql/extension
        // Win: bin/win/postgres/share/extension (or share/postgresql/extension depending on distribution)
        
        let extDir;
        if (config.IS_WIN) {
             // Adjust based on typical Windows layout if needed, assuming similar for now or verify later
             extDir = path.join(config.PATHS.BIN, 'postgres', 'share', 'extension');
             if (!await fs.pathExists(extDir)) {
                 extDir = path.join(config.PATHS.BIN, 'postgres', 'share', 'postgresql', 'extension');
             }
        } else {
             extDir = path.join(config.PATHS.BIN, 'postgres', 'share', 'postgresql', 'extension');
        }

        if (await fs.pathExists(extDir)) {
            const files = await fs.readdir(extDir);
            // Filter for .control files
            const controls = files
                .filter(f => f.endsWith('.control'))
                .map(f => f.replace('.control', ''));
            return controls;
        }
        return [];
    } catch (e) {
        console.error('Failed to get available extensions:', e);
        return [];
    }
});
