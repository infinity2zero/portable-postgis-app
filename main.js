const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const config = require('./src-main/config');
const SettingsStore = require('./src-main/settings-store');
const net = require('net');
const http = require('http'); // Import http for robust polling

// Set App Name Early for Dock/Menu
app.setName('Portable PostGIS Desktop');
if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
}

// Enable live reload for all files in the project directory
    // excluding node_modules and data directory to avoid loops
    // Also excluding 'bin' to prevent reload when config files are written
    if (!app.isPackaged) {
        require('electron-reload')(__dirname, {
            electron: path.join(__dirname, 'node_modules', '.bin', 'electron'),
            ignored: /node_modules|data|bin|dist|renderer|[\/\\]\./
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
            webviewTag: true
        }
    });

    // In dev, load Angular from ng serve so changes reflect without rebuilding
    const loadAngularDev = process.env.ELECTRON_LOAD_ANGULAR_DEV === '1' || process.env.ELECTRON_LOAD_ANGULAR_DEV === 'true';
    if (loadAngularDev) {
        mainWindow.loadURL('http://localhost:4200').catch((err) => console.error('Load Angular dev failed (is ng serve running?):', err));
    } else {
        const angularIndex = path.join(__dirname, 'dist', 'renderer', 'browser', 'index.html');
        const fs = require('fs');
        if (fs.existsSync(angularIndex)) {
            mainWindow.loadFile(angularIndex);
        } else {
            mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
        }
    }

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

ipcMain.handle('get-postgres-status', async () => {
    return { running: processManager.isRunning('postgres') };
});

ipcMain.handle('start-pgadmin', async () => {
    return { success: false, error: 'pgAdmin has been removed. Use the Database tab for the built-in browser.' };
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
    const updated = await SettingsStore.save(newSettings);
    if (updated && typeof updated === 'object') {
        currentSettings = updated;
    }
    return currentSettings;
});

ipcMain.handle('check-port', async (event, port) => {
    return await checkPort(port);
});

// --- DB API (for built-in DB browser; uses pg when Postgres is running) ---
const MAX_ROWS = 5000;
function getDbConfig(database) {
    const db = database && typeof database === 'string' ? database : 'postgres';
    const s = currentSettings || { ports: {}, dbUser: 'postgres', dbPassword: 'postgres' };
    const port = s.ports?.postgres || config.PORTS.POSTGRES || 5432;
    return {
        host: '127.0.0.1',
        port: Number(port) || 5432,
        user: s.dbUser || 'postgres',
        password: s.dbPassword ?? 'postgres',
        database: db
    };
}

/** Try to create the configured DB user (e.g. postgres1) by connecting as postgres. Call when connection fails with "role does not exist". */
async function tryCreateConfiguredRole() {
    const s = currentSettings || { ports: {}, dbUser: 'postgres', dbPassword: 'postgres' };
    const wantUser = (s.dbUser || 'postgres').trim();
    if (wantUser === 'postgres') return false;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(wantUser)) return false;
    const port = Number(s.ports?.postgres || config.PORTS.POSTGRES || 5432) || 5432;
    const password = s.dbPassword ?? 'postgres';
    const { Client } = require('pg');
    const client = new Client({
        host: '127.0.0.1',
        port,
        user: 'postgres',
        password,
        database: 'postgres'
    });
    try {
        await client.connect();
        const escapedPassword = String(password).replace(/'/g, "''");
        const quotedRole = '"' + wantUser.replace(/"/g, '""') + '"';
        await client.query(`CREATE ROLE ${quotedRole} WITH LOGIN SUPERUSER PASSWORD '${escapedPassword}';`);
        return true;
    } catch (e) {
        return false;
    } finally {
        try { await client.end(); } catch (_) {}
    }
}

async function withDb(database, fn) {
    try {
        const { Client } = require('pg');
        const client = new Client(getDbConfig(database));
        await client.connect();
        try {
            return await fn(client);
        } finally {
            await client.end();
        }
    } catch (e) {
        const msg = e.message || String(e);
        const isRoleMissing = /role\s+["']?[\w]+["']?\s+does not exist/i.test(msg) || /role\s+["']?[\w]+["']?\s+doesn't exist/i.test(msg);
        const s = currentSettings || { ports: {}, dbUser: 'postgres' };
        const wantUser = (s.dbUser || 'postgres').trim();
        if (isRoleMissing && wantUser !== 'postgres') {
            const created = await tryCreateConfiguredRole();
            if (created) {
                try {
                    const client2 = new Client(getDbConfig(database));
                    await client2.connect();
                    try {
                        return await fn(client2);
                    } finally {
                        await client2.end();
                    }
                } catch (e2) {
                    const msg2 = e2.message || String(e2);
                    const detail2 = e2.detail ? '\n\nDetail: ' + e2.detail : '';
                    return { error: msg2 + detail2 };
                }
            }
        }
        const detail = e.detail ? '\n\nDetail: ' + e.detail : '';
        return { error: msg + detail };
    }
}

// List all databases (must connect to 'postgres')
ipcMain.handle('db:listDatabases', async () => {
    return await withDb('postgres', async (client) => {
        const r = await client.query(
            `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`
        );
        return { rows: r.rows.map(x => x.datname) };
    });
});

// Cluster-wide: roles (any DB)
ipcMain.handle('db:listRoles', async () => {
    return await withDb('postgres', async (client) => {
        const r = await client.query(`SELECT rolname FROM pg_roles ORDER BY rolname`);
        return { rows: r.rows.map(x => x.rolname) };
    });
});

// Cluster-wide: tablespaces
ipcMain.handle('db:listTablespaces', async () => {
    return await withDb('postgres', async (client) => {
        const r = await client.query(`SELECT spcname FROM pg_tablespace ORDER BY spcname`);
        return { rows: r.rows.map(x => x.spcname) };
    });
});

// Extensions enabled in a specific database
ipcMain.handle('db:listExtensions', async (event, database) => {
    const db = database && typeof database === 'string' ? database : 'postgres';
    return await withDb(db, async (client) => {
        const r = await client.query(`SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname`);
        return { rows: r.rows };
    });
});

// Create database (run from 'postgres')
function quoteDbName(name) {
    if (!name || typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) return null;
    return '"' + trimmed.replace(/"/g, '""') + '"';
}
ipcMain.handle('db:createDatabase', async (event, name, options) => {
    const q = quoteDbName(name);
    if (!q) return { error: 'Invalid database name' };
    const owner = options && typeof options === 'object' && options.owner && typeof options.owner === 'string' ? options.owner.trim() : null;
    const ownerQ = owner ? quoteDbName(owner) : null;
    const withClause = ownerQ ? ` WITH OWNER = ${ownerQ}` : '';
    return await withDb('postgres', async (client) => {
        await client.query(`CREATE DATABASE ${q}${withClause}`);
        return {};
    });
});

ipcMain.handle('db:listSchemas', async (event, database) => {
    return await withDb(database, async (client) => {
        const r = await client.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog', 'information_schema') ORDER BY schema_name`
        );
        return { rows: r.rows.map(x => x.schema_name) };
    });
});
ipcMain.handle('db:listTables', async (event, database, schema) => {
    const s = schema || 'public';
    return await withDb(database, async (client) => {
        const r = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`, [s]);
        return { rows: r.rows.map(x => x.table_name) };
    });
});
ipcMain.handle('db:listViews', async (event, database, schema) => {
    const s = schema || 'public';
    return await withDb(database, async (client) => {
        const r = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'VIEW' ORDER BY table_name`, [s]);
        return { rows: r.rows.map(x => x.table_name) };
    });
});
ipcMain.handle('db:listFunctions', async (event, database, schema) => {
    const s = schema || 'public';
    return await withDb(database, async (client) => {
        const r = await client.query(
            `SELECT routine_name FROM information_schema.routines WHERE routine_schema = $1 AND routine_type = 'FUNCTION' ORDER BY routine_name`,
            [s]
        );
        return { rows: r.rows.map(x => x.routine_name) };
    });
});
ipcMain.handle('db:listSequences', async (event, database, schema) => {
    const s = schema || 'public';
    return await withDb(database, async (client) => {
        const r = await client.query(
            `SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = $1 ORDER BY sequence_name`,
            [s]
        );
        return { rows: r.rows.map(x => x.sequence_name) };
    });
});
ipcMain.handle('db:listColumns', async (event, database, schema, table) => {
    const sch = schema || 'public';
    return await withDb(database, async (client) => {
        const r = await client.query(
            `SELECT c.column_name, c.data_type,
              EXISTS (
                SELECT 1 FROM information_schema.key_column_usage kcu
                JOIN information_schema.table_constraints tc ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
                WHERE tc.constraint_type = 'PRIMARY KEY' AND kcu.table_schema = c.table_schema AND kcu.table_name = c.table_name AND kcu.column_name = c.column_name
              ) AS is_primary_key
             FROM information_schema.columns c
             WHERE c.table_schema = $1 AND c.table_name = $2
             ORDER BY c.ordinal_position`,
            [sch, table]
        );
        return { rows: r.rows.map((row) => ({ column_name: row.column_name, data_type: row.data_type, is_primary_key: !!row.is_primary_key })) };
    });
});
ipcMain.handle('db:listIndexes', async (event, database, schema, table) => {
    const sch = schema || 'public';
    return await withDb(database, async (client) => {
        const r = await client.query(
            `SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
            [sch, table]
        );
        return { rows: r.rows };
    });
});
ipcMain.handle('db:listConstraints', async (event, database, schema, table) => {
    const sch = schema || 'public';
    return await withDb(database, async (client) => {
        const r = await client.query(
            `SELECT constraint_name AS name, constraint_type AS type FROM information_schema.table_constraints WHERE table_schema = $1 AND table_name = $2 ORDER BY constraint_name`,
            [sch, table]
        );
        return { rows: r.rows };
    });
});
ipcMain.handle('db:listTriggers', async (event, database, schema, table) => {
    const sch = schema || 'public';
    return await withDb(database, async (client) => {
        const r = await client.query(
            `SELECT trigger_name AS name, action_timing || ' ' || event_manipulation AS event FROM information_schema.triggers WHERE event_object_schema = $1 AND event_object_table = $2 ORDER BY trigger_name`,
            [sch, table]
        );
        return { rows: r.rows };
    });
});

// Foreign keys for ER diagram: (from_schema, from_table, from_columns) -> (to_schema, to_table, to_columns)
ipcMain.handle('db:listForeignKeys', async (event, database, schema) => {
    const sch = schema || 'public';
    return await withDb(database, async (client) => {
        const r = await client.query(
            `SELECT tc.constraint_name,
                    tc.table_schema AS from_schema, tc.table_name AS from_table,
                    kcu.column_name AS from_column, kcu.ordinal_position AS from_ordinal,
                    ccu.table_schema AS to_schema, ccu.table_name AS to_table,
                    ccu.column_name AS to_column
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema AND tc.table_name = kcu.table_name
             JOIN information_schema.constraint_column_usage ccu
               ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
             WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
             ORDER BY tc.constraint_name, kcu.ordinal_position`,
            [sch]
        );
        // Group by constraint into { constraint_name, from_schema, from_table, from_columns[], to_schema, to_table, to_columns[] }
        const byConstraint = new Map();
        for (const row of r.rows) {
            const key = row.constraint_name;
            if (!byConstraint.has(key)) {
                byConstraint.set(key, {
                    constraint_name: row.constraint_name,
                    from_schema: row.from_schema,
                    from_table: row.from_table,
                    from_columns: [],
                    to_schema: row.to_schema,
                    to_table: row.to_table,
                    to_columns: []
                });
            }
            const rec = byConstraint.get(key);
            rec.from_columns.push(row.from_column);
            rec.to_columns.push(row.to_column);
        }
        return { rows: Array.from(byConstraint.values()) };
    });
});

function quoteIdent(name) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return null;
    return '"' + name.replace(/"/g, '""') + '"';
}
ipcMain.handle('db:fetchRows', async (event, database, schema, table, limit = 100, offset = 0) => {
    const sch = schema || 'public';
    const tbl = table;
    const qs = quoteIdent(sch);
    const qt = quoteIdent(tbl);
    if (!qs || !qt) return { error: 'Invalid schema or table name' };
    const lim = Math.min(Number(limit) || 100, MAX_ROWS);
    const off = Math.max(0, Number(offset) || 0);
    return await withDb(database, async (client) => {
        const r = await client.query(`SELECT * FROM ${qs}.${qt} LIMIT $1 OFFSET $2`, [lim, off]);
        const countResult = await client.query(`SELECT count(*) FROM ${qs}.${qt}`);
        const total = parseInt(countResult.rows[0].count, 10);
        return { rows: r.rows, total };
    });
});
// Overview stats for the selected database (size, tablespaces, hit rates, top tables/indexes)
ipcMain.handle('db:getOverviewStats', async (event, database) => {
    const db = database && typeof database === 'string' ? database : 'postgres';
    return await withDb(db, async (client) => {
        const out = {
            databaseSize: 0,
            tableCount: 0,
            indexCount: 0,
            cacheHitRatio: null,
            tableHitRatio: null,
            indexHitRatio: null,
            tablespaces: [],
            topTables: [],
            topIndexes: []
        };
        const sizeRes = await client.query('SELECT pg_database_size(current_database()) AS size');
        if (sizeRes.rows[0]) out.databaseSize = parseInt(sizeRes.rows[0].size, 10) || 0;

        const countsRes = await client.query(`
            SELECT
                (SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE') AS table_count,
                (SELECT count(*) FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog','information_schema')) AS index_count
        `);
        if (countsRes.rows[0]) {
            out.tableCount = parseInt(countsRes.rows[0].table_count, 10) || 0;
            out.indexCount = parseInt(countsRes.rows[0].index_count, 10) || 0;
        }

        const dbStatRes = await client.query(
            'SELECT blks_hit, blks_read FROM pg_stat_database WHERE datname = current_database()'
        );
        if (dbStatRes.rows[0]) {
            const hit = parseInt(dbStatRes.rows[0].blks_hit, 10) || 0;
            const read = parseInt(dbStatRes.rows[0].blks_read, 10) || 0;
            const total = hit + read;
            out.cacheHitRatio = total > 0 ? Math.round((hit / total) * 10000) / 100 : null;
        }

        const tableStatRes = await client.query(`
            SELECT sum(heap_blks_hit) AS hit, sum(heap_blks_read) AS read FROM pg_statio_user_tables
        `);
        if (tableStatRes.rows[0]) {
            const hit = parseInt(tableStatRes.rows[0].hit, 10) || 0;
            const read = parseInt(tableStatRes.rows[0].read, 10) || 0;
            const total = hit + read;
            out.tableHitRatio = total > 0 ? Math.round((hit / total) * 10000) / 100 : null;
        }

        const indexStatRes = await client.query(`
            SELECT sum(idx_blks_hit) AS hit, sum(idx_blks_read) AS read FROM pg_statio_user_indexes
        `);
        if (indexStatRes.rows[0]) {
            const hit = parseInt(indexStatRes.rows[0].hit, 10) || 0;
            const read = parseInt(indexStatRes.rows[0].read, 10) || 0;
            const total = hit + read;
            out.indexHitRatio = total > 0 ? Math.round((hit / total) * 10000) / 100 : null;
        }

        const tsRes = await client.query(`
            SELECT spcname AS name, pg_tablespace_size(oid) AS size FROM pg_tablespace ORDER BY pg_tablespace_size(oid) DESC NULLS LAST
        `);
        out.tablespaces = (tsRes.rows || []).map(r => ({
            name: r.name,
            size: parseInt(r.size, 10) || 0
        }));

        const topTRes = await client.query(`
            SELECT schemaname, relname AS name, pg_total_relation_size(relid) AS size
            FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC NULLS LAST LIMIT 15
        `);
        out.topTables = (topTRes.rows || []).map(r => ({
            schemaname: r.schemaname,
            name: r.name,
            size: parseInt(r.size, 10) || 0
        }));

        const topIRes = await client.query(`
            SELECT schemaname, relname AS table_name, indexrelname AS name, pg_relation_size(indexrelid) AS size
            FROM pg_stat_user_indexes ORDER BY pg_relation_size(indexrelid) DESC NULLS LAST LIMIT 15
        `);
        out.topIndexes = (topIRes.rows || []).map(r => ({
            schemaname: r.schemaname,
            table_name: r.table_name,
            name: r.name,
            size: parseInt(r.size, 10) || 0
        }));

        return out;
    });
});

ipcMain.handle('db:runQuery', async (event, database, sql) => {
    if (!sql || typeof sql !== 'string') return { error: 'Invalid SQL' };
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
        return await withDb(database, async (client) => {
            const r = await client.query({ text: sql, rowMode: 'array' });
            const rows = r.rows.slice(0, MAX_ROWS);
            return { rows, fields: r.fields?.map(f => f.name) || [], rowCount: r.rowCount };
        });
    }
    return { error: 'Only SELECT (and read-only) queries are allowed via this API' };
});

// Run arbitrary SQL (single or multiple statements) - full query editor support
ipcMain.handle('db:runScript', async (event, database, sql) => {
    if (!sql || typeof sql !== 'string') return { error: 'Invalid SQL' };
    const db = database && typeof database === 'string' ? database : 'postgres';
    const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
    if (statements.length === 0) return { error: 'No statement to run' };
    return await withDb(db, async (client) => {
        let lastResult = null;
        for (const stmt of statements) {
            lastResult = await client.query({ text: stmt + ';', rowMode: 'array' });
        }
        if (!lastResult) return { rows: [], fields: [], rowCount: 0 };
        const fields = lastResult.fields?.map(f => f.name) || [];
        const rows = lastResult.rows?.slice(0, MAX_ROWS) || [];
        const rowCount = lastResult.rowCount ?? rows.length;
        return { rows, fields, rowCount };
    });
});
ipcMain.handle('db:runExplain', async (event, database, sql) => {
    if (!sql || typeof sql !== 'string') return { error: 'Invalid SQL' };
    const trimmed = sql.trim().toUpperCase();
    if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) {
        return { error: 'EXPLAIN only supports SELECT (and read-only) queries' };
    }
    const explainSql = 'EXPLAIN (FORMAT TEXT) ' + sql.trim();
    return await withDb(database, async (client) => {
        const r = await client.query(explainSql);
        const plan = r.rows.map((row) => row.query_plan || row.QUERY_PLAN || Object.values(row)[0]).filter(Boolean).join('\n');
        return { plan };
    });
});

// Run DDL (CREATE TABLE, etc.) in a database
ipcMain.handle('db:runDdl', async (event, database, sql) => {
    if (!sql || typeof sql !== 'string') return { error: 'Invalid SQL' };
    const db = database && typeof database === 'string' ? database : 'postgres';
    return await withDb(db, async (client) => {
        await client.query(sql.trim());
        return {};
    });
});

// Backup database: show save dialog, run pg_dump to chosen path
function getPgDumpPath() {
    let p = config.PATHS.POSTGRES_BIN;
    if (process.platform === 'win32') {
        p = p.replace('postgres.exe', 'pg_dump.exe');
    } else {
        p = p.replace(/postgres$/, 'pg_dump');
    }
    return p;
}

function getPsqlPath() {
    let p = config.PATHS.POSTGRES_BIN;
    if (process.platform === 'win32') {
        p = p.replace('postgres.exe', 'psql.exe');
    } else {
        p = p.replace(/postgres$/, 'psql');
    }
    return p;
}

function getPgRestorePath() {
    let p = config.PATHS.POSTGRES_BIN;
    if (process.platform === 'win32') {
        p = p.replace('postgres.exe', 'pg_restore.exe');
    } else {
        p = p.replace(/postgres$/, 'pg_restore');
    }
    return p;
}

function getPgEnv() {
    const s = currentSettings || { ports: {}, dbUser: 'postgres', dbPassword: 'postgres' };
    const port = s.ports?.postgres || config.PORTS.POSTGRES || 5432;
    const postgresBinDir = path.dirname(config.PATHS.POSTGRES_BIN);
    const postgresRoot = path.dirname(postgresBinDir);
    return {
        PGPASSWORD: s.dbPassword ?? 'postgres',
        PGSHARE: path.join(postgresRoot, 'share'),
        PGLIB: path.join(postgresRoot, 'lib'),
        ...process.env
    };
}

ipcMain.handle('db:backupDatabase', async (event, database) => {
    const db = database && typeof database === 'string' ? database : 'postgres';
    if (!mainWindow) return { success: false, error: 'Window not ready' };
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Backup database',
        defaultPath: `${db}.sql`,
        filters: [
            { name: 'Plain SQL', extensions: ['sql'] },
            { name: 'Custom (pg_restore)', extensions: ['backup', 'dump'] },
            { name: 'Tar archive', extensions: ['tar'] },
            { name: 'All files', extensions: ['*'] }
        ]
    });
    if (canceled || !filePath) return { success: false, cancelled: true };
    const ext = path.extname(filePath).toLowerCase();
    const formatFlag = (ext === '.tar' ? '-Ft' : (ext === '.backup' || ext === '.dump' ? '-Fc' : '-Fp'));
    const { execFile } = require('child_process');
    const execFileAsync = require('util').promisify(execFile);
    const s = currentSettings || { ports: {}, dbUser: 'postgres' };
    const port = s.ports?.postgres || config.PORTS.POSTGRES || 5432;
    try {
        await execFileAsync(getPgDumpPath(), [
            '-h', '127.0.0.1',
            '-p', String(port),
            '-U', s.dbUser || 'postgres',
            '-d', db,
            formatFlag,
            '-f', filePath
        ], { env: getPgEnv() });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('db:restoreDatabase', async (event, database) => {
    const db = database && typeof database === 'string' ? database : 'postgres';
    if (!mainWindow) return { success: false, error: 'Window not ready' };
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'Restore database',
        properties: ['openFile'],
        filters: [
            { name: 'SQL / Custom / Tar', extensions: ['sql', 'backup', 'dump', 'tar'] },
            { name: 'All files', extensions: ['*'] }
        ]
    });
    if (canceled || !filePaths || filePaths.length === 0) return { success: false, cancelled: true };
    const filePath = filePaths[0];
    const ext = path.extname(filePath).toLowerCase();
    const usePgRestore = (ext === '.tar' || ext === '.backup' || ext === '.dump');
    const { execFile } = require('child_process');
    const execFileAsync = require('util').promisify(execFile);
    const s = currentSettings || { ports: {}, dbUser: 'postgres' };
    const port = s.ports?.postgres || config.PORTS.POSTGRES || 5432;
    try {
        if (usePgRestore) {
            await execFileAsync(getPgRestorePath(), [
                '-h', '127.0.0.1',
                '-p', String(port),
                '-U', s.dbUser || 'postgres',
                '-d', db,
                '--no-owner',
                '--no-acl',
                filePath
            ], { env: getPgEnv() });
        } else {
            await execFileAsync(getPsqlPath(), [
                '-h', '127.0.0.1',
                '-p', String(port),
                '-U', s.dbUser || 'postgres',
                '-d', db,
                '-f', filePath
            ], { env: getPgEnv() });
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

// Table export: show save dialog, then COPY (csv/text/binary) or SELECT+transform (json/sql/html/markdown/xml)
const COPY_EXPORT_FORMATS = ['csv', 'text', 'binary'];
const TRANSFORM_EXPORT_FORMATS = ['json', 'sql', 'html', 'markdown', 'xml'];
function getExportSaveFilters(format) {
    const f = format || 'csv';
    if (f === 'binary') return [{ name: 'Binary', extensions: ['bin', 'dat'] }, { name: 'All files', extensions: ['*'] }];
    if (f === 'text') return [{ name: 'Text', extensions: ['txt', 'tsv'] }, { name: 'All files', extensions: ['*'] }];
    if (f === 'json') return [{ name: 'JSON', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }];
    if (f === 'sql') return [{ name: 'SQL', extensions: ['sql'] }, { name: 'All files', extensions: ['*'] }];
    if (f === 'html') return [{ name: 'HTML', extensions: ['html', 'htm'] }, { name: 'All files', extensions: ['*'] }];
    if (f === 'markdown') return [{ name: 'Markdown', extensions: ['md'] }, { name: 'All files', extensions: ['*'] }];
    if (f === 'xml') return [{ name: 'XML', extensions: ['xml'] }, { name: 'All files', extensions: ['*'] }];
    return [{ name: 'CSV', extensions: ['csv'] }, { name: 'All files', extensions: ['*'] }];
}
function getExportDefaultExt(format) {
    const map = { binary: 'bin', text: 'txt', json: 'json', sql: 'sql', html: 'html', markdown: 'md', xml: 'xml' };
    return map[format] || 'csv';
}
function escapeSqlVal(v) {
    if (v === null || v === undefined) return 'NULL';
    const s = String(v).replace(/'/g, "''");
    if (typeof v === 'number' && !Number.isNaN(v)) return String(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return "'" + s + "'";
}
function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function escapeMdCell(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
function rowsToJson(rows) {
    return JSON.stringify(rows, null, 2);
}
function rowsToSql(rows, schema, table, columns) {
    const cols = columns && columns.length ? columns : (rows[0] ? Object.keys(rows[0]) : []);
    const qs = '"' + String(schema).replace(/"/g, '""') + '"';
    const qt = '"' + String(table).replace(/"/g, '""') + '"';
    const colList = cols.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(', ');
    const lines = rows.map((row) => {
        const vals = cols.map((col) => escapeSqlVal(row[col]));
        return `INSERT INTO ${qs}.${qt} (${colList}) VALUES (${vals.join(', ')});`;
    });
    return lines.join('\n');
}
function rowsToHtml(rows, tableName) {
    const cols = rows[0] ? Object.keys(rows[0]) : [];
    let out = '<!DOCTYPE html>\n<html><head><meta charset="UTF-8"/><title>' + escapeHtml(tableName) + '</title></head><body><table border="1">\n<tr>';
    cols.forEach((c) => { out += '<th>' + escapeHtml(c) + '</th>'; });
    out += '</tr>\n';
    rows.forEach((row) => {
        out += '<tr>';
        cols.forEach((col) => { out += '<td>' + escapeHtml(row[col] != null ? String(row[col]) : '') + '</td>'; });
        out += '</tr>\n';
    });
    return out + '</table></body></html>';
}
function rowsToMarkdown(rows) {
    const cols = rows[0] ? Object.keys(rows[0]) : [];
    const header = '| ' + cols.map(escapeMdCell).join(' | ') + ' |';
    const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
    const body = rows.map((row) => '| ' + cols.map((col) => escapeMdCell(row[col] != null ? String(row[col]) : '')).join(' | ') + ' |').join('\n');
    return header + '\n' + sep + '\n' + body + '\n';
}
function escapeXml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
function rowsToXml(rows, tableName) {
    const cols = rows[0] ? Object.keys(rows[0]) : [];
    const safeName = tableName.replace(/[^a-zA-Z0-9_-]/g, '_');
    let out = '<?xml version="1.0" encoding="UTF-8"?>\n<' + safeName + '>\n';
    rows.forEach((row) => {
        out += '  <row>\n';
        cols.forEach((col) => {
            const safeCol = col.replace(/[^a-zA-Z0-9_-]/g, '_');
            const val = row[col];
            out += '    <' + safeCol + '>' + escapeXml(val != null ? String(val) : '') + '</' + safeCol + '>\n';
        });
        out += '  </row>\n';
    });
    return out + '</' + safeName + '>\n';
}

ipcMain.handle('db:exportTableData', async (event, database, schema, table, options) => {
    const sch = schema || 'public';
    const qs = quoteIdent(sch);
    const qt = quoteIdent(table);
    if (!qs || !qt) return { error: 'Invalid schema or table name' };
    const opts = options || {};
    const format = (opts.format && (COPY_EXPORT_FORMATS.includes(opts.format) || TRANSFORM_EXPORT_FORMATS.includes(opts.format)))
        ? opts.format
        : (opts.format === 'text' ? 'text' : 'csv');
    const ext = getExportDefaultExt(format);
    if (!mainWindow) return { error: 'Window not ready' };
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Export table data',
        defaultPath: `${table}.${ext}`,
        filters: getExportSaveFilters(format)
    });
    if (canceled || !filePath) return { success: false, cancelled: true };
    const columns = Array.isArray(opts.columns) && opts.columns.length > 0
        ? opts.columns.map((c) => quoteIdent(c)).filter(Boolean)
        : null;
    const colClause = columns ? ` (${columns.join(', ')})` : '';

    if (TRANSFORM_EXPORT_FORMATS.includes(format)) {
        try {
            const selectCols = columns ? columns.map((c) => c).join(', ') : '*';
            const selectSql = `SELECT ${selectCols} FROM ${qs}.${qt}`;
            const result = await withDb(database, async (client) => {
                const r = await client.query(selectSql);
                const rows = r.rows || [];
                let content;
                const colNames = columns || (rows[0] ? Object.keys(rows[0]) : []);
                if (format === 'json') content = rowsToJson(rows);
                else if (format === 'sql') content = rowsToSql(rows, sch, table, colNames);
                else if (format === 'html') content = rowsToHtml(rows, `${sch}.${table}`);
                else if (format === 'markdown') content = rowsToMarkdown(rows);
                else if (format === 'xml') content = rowsToXml(rows, table);
                else return { error: 'Unsupported format' };
                const fs = require('fs');
                fs.writeFileSync(filePath, content, 'utf8');
                return { success: true };
            });
            return result && result.error ? result : { success: true };
        } catch (e) {
            return { success: false, error: e.message || String(e) };
        }
    }

    let withOpts;
    if (format === 'binary') {
        withOpts = 'FORMAT binary';
    } else if (format === 'text') {
        const delim = (opts.delimiter === 'tab' || opts.delimiter === '\t') ? "E'\\t'" : (opts.delimiter ? `'${String(opts.delimiter).replace(/'/g, "''")}'` : "E'\\t'");
        const nullStr = opts.nullString != null ? `NULL '${String(opts.nullString).replace(/'/g, "''")}'` : "NULL '\\\\N'";
        withOpts = `FORMAT text DELIMITER ${delim} ${nullStr}`;
    } else {
        const delim = (opts.delimiter === 'tab' || opts.delimiter === '\t') ? "E'\\t'" : (opts.delimiter ? `'${String(opts.delimiter).replace(/'/g, "''")}'` : "','");
        const quote = opts.quote != null ? `'${String(opts.quote).replace(/'/g, "''")}'` : "'\"'";
        const escape = opts.escape != null ? `'${String(opts.escape).replace(/'/g, "''")}'` : "'\"'";
        const nullStr = opts.nullString != null ? `NULL '${String(opts.nullString).replace(/'/g, "''")}'` : "NULL '\\\\N'";
        const header = opts.header !== false ? 'HEADER true' : 'HEADER false';
        withOpts = `FORMAT csv DELIMITER ${delim} ${header} QUOTE ${quote} ESCAPE ${escape} ${nullStr}`;
    }
    const copySql = `COPY ${qs}.${qt}${colClause} TO STDOUT WITH (${withOpts})`;
    try {
        const { to: copyTo } = require('pg-copy-streams');
        const result = await withDb(database, async (client) => {
            return new Promise((resolve, reject) => {
                const outStream = client.query(copyTo(copySql));
                const writeStream = require('fs').createWriteStream(filePath);
                outStream.on('error', reject);
                writeStream.on('error', reject);
                writeStream.on('finish', () => resolve({ success: true }));
                outStream.pipe(writeStream);
            });
        });
        return result && result.error ? result : { success: true };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

// Table import: show open dialog, then COPY (csv/text/binary) or parse+INSERT (json/xml)
const COPY_IMPORT_FORMATS = ['csv', 'text', 'binary'];
const TRANSFORM_IMPORT_FORMATS = ['json', 'xml'];
function getImportOpenFilters(format) {
    const f = format || 'csv';
    if (f === 'json') return [{ name: 'JSON', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }];
    if (f === 'xml') return [{ name: 'XML', extensions: ['xml'] }, { name: 'All files', extensions: ['*'] }];
    return [
        { name: 'CSV / Text / Binary', extensions: ['csv', 'txt', 'tsv', 'bin', 'dat'] },
        { name: 'All files', extensions: ['*'] }
    ];
}
function parseJsonFile(filePath) {
    const fs = require('fs');
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [data];
}
function parseXmlFile(filePath) {
    const fs = require('fs');
    const content = fs.readFileSync(filePath, 'utf8');
    const rows = [];
    const rowMatch = content.match(/<row>[\s\S]*?<\/row>/g);
    if (rowMatch) {
        rowMatch.forEach((rowTag) => {
            const obj = {};
            const fieldRegex = /<([a-zA-Z0-9_]+)>([^<]*)<\/\1>/g;
            let m;
            while ((m = fieldRegex.exec(rowTag)) !== null) obj[m[1]] = m[2];
            rows.push(obj);
        });
    }
    return rows;
}
const IMPORT_BATCH_SIZE = 500;

ipcMain.handle('db:importTableData', async (event, database, schema, table, options) => {
    const sch = schema || 'public';
    const qs = quoteIdent(sch);
    const qt = quoteIdent(table);
    if (!qs || !qt) return { error: 'Invalid schema or table name' };
    if (!mainWindow) return { error: 'Window not ready' };
    const opts = options || {};
    const format = (opts.format && (COPY_IMPORT_FORMATS.includes(opts.format) || TRANSFORM_IMPORT_FORMATS.includes(opts.format)))
        ? opts.format
        : (opts.format === 'binary' ? 'binary' : (opts.format === 'text' ? 'text' : 'csv'));
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'Import into table',
        properties: ['openFile'],
        filters: getImportOpenFilters(format)
    });
    if (canceled || !filePaths || filePaths.length === 0) return { success: false, cancelled: true };
    const filePath = filePaths[0];

    if (TRANSFORM_IMPORT_FORMATS.includes(format)) {
        try {
            const rows = format === 'json' ? parseJsonFile(filePath) : parseXmlFile(filePath);
            if (!rows.length) return { success: true };
            const allCols = opts.columns && opts.columns.length ? opts.columns : Object.keys(rows[0]).filter((k) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
            const rawCols = allCols.filter((c) => quoteIdent(c));
            const colList = rawCols.map((c) => quoteIdent(c));
            if (colList.length === 0) return { error: 'No valid column names' };
            const quotedCols = colList.join(', ');
            await withDb(database, async (client) => {
                for (let i = 0; i < rows.length; i += IMPORT_BATCH_SIZE) {
                    const batch = rows.slice(i, i + IMPORT_BATCH_SIZE);
                    const values = batch.map((row) => {
                        const vals = rawCols.map((col) => {
                            const raw = row[col];
                            if (raw === null || raw === undefined) return 'NULL';
                            const s = String(raw).replace(/'/g, "''");
                            return "'" + s + "'";
                        });
                        return `(${vals.join(', ')})`;
                    });
                    const sql = `INSERT INTO ${qs}.${qt} (${quotedCols}) VALUES ${values.join(', ')}`;
                    await client.query(sql);
                }
            });
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message || String(e) };
        }
    }

    const columns = Array.isArray(opts.columns) && opts.columns.length > 0
        ? opts.columns.map((c) => quoteIdent(c)).filter(Boolean)
        : null;
    const colClause = columns ? ` (${columns.join(', ')})` : '';
    let withOpts;
    if (format === 'binary') {
        withOpts = 'FORMAT binary';
    } else if (format === 'text') {
        const delim = (opts.delimiter === 'tab' || opts.delimiter === '\t') ? "E'\\t'" : (opts.delimiter ? `'${String(opts.delimiter).replace(/'/g, "''")}'` : "E'\\t'");
        const nullStr = opts.nullString != null ? `NULL '${String(opts.nullString).replace(/'/g, "''")}'` : "NULL '\\\\N'";
        withOpts = `FORMAT text DELIMITER ${delim} ${nullStr}`;
    } else {
        const delim = (opts.delimiter === 'tab' || opts.delimiter === '\t') ? "E'\\t'" : (opts.delimiter ? `'${String(opts.delimiter).replace(/'/g, "''")}'` : "','");
        const quote = opts.quote != null ? `'${String(opts.quote).replace(/'/g, "''")}'` : "'\"'";
        const escape = opts.escape != null ? `'${String(opts.escape).replace(/'/g, "''")}'` : "'\"'";
        const nullStr = opts.nullString != null ? `NULL '${String(opts.nullString).replace(/'/g, "''")}'` : "NULL '\\\\N'";
        const header = opts.header !== false ? 'HEADER true' : 'HEADER false';
        withOpts = `FORMAT csv DELIMITER ${delim} ${header} QUOTE ${quote} ESCAPE ${escape} ${nullStr}`;
    }
    const copySql = `COPY ${qs}.${qt}${colClause} FROM STDIN WITH (${withOpts})`;
    try {
        const { from: copyFrom } = require('pg-copy-streams');
        const result = await withDb(database, async (client) => {
            return new Promise((resolve, reject) => {
                const inStream = require('fs').createReadStream(filePath);
                const copyStream = client.query(copyFrom(copySql));
                copyStream.on('error', reject);
                copyStream.on('finish', () => resolve({ success: true }));
                inStream.pipe(copyStream);
            });
        });
        return result && result.error ? result : { success: true };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

// Save query to file: show save dialog, write content
const fs = require('fs-extra');
ipcMain.handle('query:saveToFile', async (event, content) => {
    if (!mainWindow) return { success: false, error: 'Window not ready' };
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Save query',
        defaultPath: 'query.sql',
        filters: [{ name: 'SQL', extensions: ['sql'] }, { name: 'All files', extensions: ['*'] }]
    });
    if (canceled || !filePath) return { success: false, cancelled: true };
    try {
        await fs.writeFile(filePath, typeof content === 'string' ? content : '', 'utf8');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

// Load query from file: show open dialog, read content
ipcMain.handle('query:loadFromFile', async () => {
    if (!mainWindow) return { success: false, error: 'Window not ready' };
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'Load query',
        properties: ['openFile'],
        filters: [{ name: 'SQL', extensions: ['sql'] }, { name: 'All files', extensions: ['*'] }]
    });
    if (canceled || !filePaths || filePaths.length === 0) return { success: false, cancelled: true };
    try {
        const content = await fs.readFile(filePaths[0], 'utf8');
        return { success: true, content };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
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

    const { execFile } = require('child_process');
    const execFileAsync = require('util').promisify(execFile);
    
    // Set PostgreSQL environment variables
    const postgresShareDir = path.join(path.dirname(path.dirname(psqlPath)), 'share');
    const postgresLibDir = path.join(path.dirname(path.dirname(psqlPath)), 'lib');
    const env = {
        ...process.env,
        PGSHARE: postgresShareDir,
        PGLIB: postgresLibDir
    };
    
    try {
        // Query pg_extension catalog: name|version
        const { stdout } = await execFileAsync(psqlPath, [
            '-U', 'postgres',
            '-d', 'postgres',
            '-A', '-t',
            '-c', 'SELECT extname, extversion FROM pg_extension;'
        ], { env });
        
        const extensions = stdout.trim().split('\n').map(line => {
            const parts = line.trim().split('|');
            if (parts.length >= 2) {
                return { name: parts[0].trim(), version: parts[1].trim() };
            }
            return null;
        }).filter(e => e);
        
        return extensions;
    } catch (e) {
        console.error('Failed to check extensions:', e.message || e);
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

ipcMain.handle('enable-extension', async (event, extName, database) => {
    const db = database && typeof database === 'string' ? database : 'postgres';
    const psqlPath = getPsqlPath();
    const env = getPgEnv();
    const { execFile } = require('child_process');
    const execFileAsync = require('util').promisify(execFile);
    try {
        if (!/^[a-zA-Z0-9_]+$/.test(extName)) {
            throw new Error("Invalid extension name");
        }
        await execFileAsync(psqlPath, [
            '-h', '127.0.0.1',
            '-p', String(currentSettings?.ports?.postgres || config.PORTS.POSTGRES || 5432),
            '-U', currentSettings?.dbUser || 'postgres',
            '-d', db,
            '-c', `CREATE EXTENSION IF NOT EXISTS "${extName}" CASCADE;`
        ], { env });
        return { success: true };
    } catch (e) {
        const errorMsg = e.message || e.stderr?.toString() || 'Unknown error';
        console.error(`Failed to enable extension ${extName}:`, errorMsg);
        return { success: false, error: errorMsg };
    }
});

ipcMain.handle('disable-extension', async (event, extName, database) => {
    const db = database && typeof database === 'string' ? database : 'postgres';
    const psqlPath = getPsqlPath();
    const env = getPgEnv();
    const { execFile } = require('child_process');
    const execFileAsync = require('util').promisify(execFile);
    try {
        if (!/^[a-zA-Z0-9_]+$/.test(extName)) {
            throw new Error("Invalid extension name");
        }
        await execFileAsync(psqlPath, [
            '-h', '127.0.0.1',
            '-p', String(currentSettings?.ports?.postgres || config.PORTS.POSTGRES || 5432),
            '-U', currentSettings?.dbUser || 'postgres',
            '-d', db,
            '-c', `DROP EXTENSION IF EXISTS "${extName}" CASCADE;`
        ], { env });
        return { success: true };
    } catch (e) {
        const errorMsg = e.message || e.stderr?.toString() || 'Unknown error';
        console.error(`Failed to disable extension ${extName}:`, errorMsg);
        return { success: false, error: errorMsg };
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
