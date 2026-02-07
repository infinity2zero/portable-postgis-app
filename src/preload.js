const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    platform: process.platform, // Expose platform for UI customization
    onLog: (callback) => ipcRenderer.on('log', (event, message) => callback(message)),
    onReady: (callback) => ipcRenderer.on('ready', (event, url) => callback(url)),
    showConfirm: (message) => ipcRenderer.invoke('show-confirm', message),
    checkExtensions: () => ipcRenderer.invoke('check-extensions'),
    getAvailableExtensions: () => ipcRenderer.invoke('get-available-extensions'),
    enableExtension: (extName, database) => ipcRenderer.invoke('enable-extension', extName, database),
    disableExtension: (extName, database) => ipcRenderer.invoke('disable-extension', extName, database),
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
    getPostgresStatus: () => ipcRenderer.invoke('get-postgres-status'),
    startPgAdmin: (pgPort, adminPort) => ipcRenderer.invoke('start-pgadmin', pgPort, adminPort),
    stopPgAdmin: () => ipcRenderer.invoke('stop-pgadmin'),
    onPgAdminReady: (callback) => ipcRenderer.on('pgadmin-ready', (event, url) => callback(url)),
    onServiceExit: (callback) => ipcRenderer.on('service-exited', (event, data) => callback(data)),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),

    // DB API (for built-in browser; database param = selected DB name)
    dbListDatabases: () => ipcRenderer.invoke('db:listDatabases'),
    dbListRoles: () => ipcRenderer.invoke('db:listRoles'),
    dbListTablespaces: () => ipcRenderer.invoke('db:listTablespaces'),
    dbListExtensions: (database) => ipcRenderer.invoke('db:listExtensions', database),
    dbCreateDatabase: (name, options) => ipcRenderer.invoke('db:createDatabase', name, options),
    dbListSchemas: (database) => ipcRenderer.invoke('db:listSchemas', database),
    dbListTables: (database, schema) => ipcRenderer.invoke('db:listTables', database, schema),
    dbListViews: (database, schema) => ipcRenderer.invoke('db:listViews', database, schema),
    dbListAllTablesAndViews: (database) => ipcRenderer.invoke('db:listAllTablesAndViews', database),
    dbListFunctions: (database, schema) => ipcRenderer.invoke('db:listFunctions', database, schema),
    dbListSequences: (database, schema) => ipcRenderer.invoke('db:listSequences', database, schema),
    dbListColumns: (database, schema, table) => ipcRenderer.invoke('db:listColumns', database, schema, table),
    dbListIndexes: (database, schema, table) => ipcRenderer.invoke('db:listIndexes', database, schema, table),
    dbListConstraints: (database, schema, table) => ipcRenderer.invoke('db:listConstraints', database, schema, table),
    dbListTriggers: (database, schema, table) => ipcRenderer.invoke('db:listTriggers', database, schema, table),
    dbListForeignKeys: (database, schema) => ipcRenderer.invoke('db:listForeignKeys', database, schema),
    dbGetOverviewStats: (database) => ipcRenderer.invoke('db:getOverviewStats', database),
    dbFetchRows: (database, schema, table, limit, offset) => ipcRenderer.invoke('db:fetchRows', database, schema, table, limit, offset),
    dbRunQuery: (database, sql) => ipcRenderer.invoke('db:runQuery', database, sql),
    dbRunScript: (database, sql) => ipcRenderer.invoke('db:runScript', database, sql),
    dbRunExplain: (database, sql) => ipcRenderer.invoke('db:runExplain', database, sql),
    dbRunDdl: (database, sql) => ipcRenderer.invoke('db:runDdl', database, sql),
    dbBackupDatabase: (database) => ipcRenderer.invoke('db:backupDatabase', database),
    dbRestoreDatabase: (database) => ipcRenderer.invoke('db:restoreDatabase', database),
    dbExportTableData: (database, schema, table, options) => ipcRenderer.invoke('db:exportTableData', database, schema, table, options),
    dbImportTableData: (database, schema, table, options) => ipcRenderer.invoke('db:importTableData', database, schema, table, options),
    saveQueryToFile: (content) => ipcRenderer.invoke('query:saveToFile', content),
    loadQueryFromFile: () => ipcRenderer.invoke('query:loadFromFile')
});
