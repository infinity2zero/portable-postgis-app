const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    platform: process.platform, // Expose platform for UI customization
    onLog: (callback) => ipcRenderer.on('log', (event, message) => callback(message)),
    onReady: (callback) => ipcRenderer.on('ready', (event, url) => callback(url)),
    showConfirm: (message) => ipcRenderer.invoke('show-confirm', message),
    checkExtensions: () => ipcRenderer.invoke('check-extensions'),
    getAvailableExtensions: () => ipcRenderer.invoke('get-available-extensions'),
    enableExtension: (extName) => ipcRenderer.invoke('enable-extension', extName),
    disableExtension: (extName) => ipcRenderer.invoke('disable-extension', extName),
    wipeData: () => ipcRenderer.invoke('wipe-data'),
    signalUiReady: () => ipcRenderer.send('ui-ready'),
    
    // Settings & Ports
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    checkPort: (port) => ipcRenderer.invoke('check-port', port),
    relaunchApp: () => ipcRenderer.invoke('relaunch-app'),
    
    // Service Control
    startPostgres: (port) => ipcRenderer.invoke('start-postgres', port),
    stopPostgres: () => ipcRenderer.invoke('stop-postgres'),
    startPgAdmin: (pgPort, adminPort) => ipcRenderer.invoke('start-pgadmin', pgPort, adminPort),
    stopPgAdmin: () => ipcRenderer.invoke('stop-pgadmin'),
    onPgAdminReady: (callback) => ipcRenderer.on('pgadmin-ready', (event, url) => callback(url)),
    onServiceExit: (callback) => ipcRenderer.on('service-exited', (event, data) => callback(data)),
    openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
