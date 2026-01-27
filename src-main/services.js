const path = require('path');
const fs = require('fs-extra');
const net = require('net');
const config = require('./config');
const processManager = require('./process-manager');

const { PATHS, PORTS } = config;

async function startPostgres(onLog, port) {
    const pgPort = port || PORTS.POSTGRES;
    // 1. Check if binaries exist
    if (!await fs.pathExists(PATHS.POSTGRES_BIN)) {
        onLog(`[postgres] Binary not found at ${PATHS.POSTGRES_BIN}. Please run setup.`);
        return;
    }

    // 2. Init DB if not exists
    const dataDir = path.join(PATHS.DATA, 'postgres');
    await fs.ensureDir(dataDir);

    // Fix permissions (Important for Mac/Linux)
    if (process.platform !== 'win32') {
        try {
            await fs.chmod(dataDir, 0o700);
            onLog(`[postgres] Set permissions 0700 on ${dataDir}`);
        } catch (err) {
            onLog(`[postgres] Warning: Failed to set permissions on data directory: ${err.message}`);
        }
    }

    // Repair missing directories (e.g. if skipped by build/copy)
    // We include the COMPLETE standard PostgreSQL directory structure here to be safe.
    const requiredDirs = [
        'base',
        'global',
        'pg_commit_ts',
        'pg_dynshmem',
        'pg_logical',
        'pg_logical/mappings',
        'pg_logical/snapshots',
        'pg_multixact',
        'pg_multixact/members',
        'pg_multixact/offsets',
        'pg_notify',
        'pg_replslot',
        'pg_serial',
        'pg_snapshots',
        'pg_stat',
        'pg_stat_tmp',
        'pg_subtrans',
        'pg_tblspc',
        'pg_twophase',
        'pg_wal',
        'pg_wal/archive_status',
        'pg_xact'
    ];
    
    // Only attempt repair if we believe the DB is initialized (has version file)
    if (await fs.pathExists(path.join(dataDir, 'PG_VERSION'))) {
        onLog('[postgres] Checking for missing data directories...');
        try {
            const files = await fs.readdir(dataDir);
            onLog(`[postgres] Current data dir content: ${files.join(', ')}`);
        } catch (e) {
            onLog(`[postgres] Failed to list data dir: ${e.message}`);
        }

        for (const dir of requiredDirs) {
            try {
                const fullPath = path.join(dataDir, dir);
                if (!await fs.pathExists(fullPath)) {
                    onLog(`[postgres] Creating missing directory: ${dir}`);
                    await fs.ensureDir(fullPath);
                }
                
                if (process.platform !== 'win32') {
                    await fs.chmod(fullPath, 0o700);
                }
            } catch (err) {
                onLog(`[postgres] Error repairing directory ${dir}: ${err.message}`);
            }
        }
    }

    // Check if data populated (look for PG_VERSION, postgresql.conf, and valid base dir)
    const versionPath = path.join(dataDir, 'PG_VERSION');
    const confPath = path.join(dataDir, 'postgresql.conf');
    const baseDir = path.join(dataDir, 'base');
    const globalDir = path.join(dataDir, 'global');
    
    let isInitialized = await fs.pathExists(versionPath) && await fs.pathExists(confPath);
    
    if (isInitialized) {
        // Integrity check: 'base' must contain at least 'template1' and 'postgres' (so >= 2 dirs)
        // If it only has '1' (template1), initdb likely failed or was interrupted
        if (await fs.pathExists(baseDir)) {
            const dbs = await fs.readdir(baseDir);
            // We expect at least template1 (1) and postgres (OID varies). 
            // Also checking global dir is a good proxy for integrity.
            if (dbs.length < 2 || !await fs.pathExists(globalDir)) {
                onLog('[postgres] Data directory incomplete (missing default databases or global). Re-initializing...');
                isInitialized = false;
            }
        } else {
            onLog('[postgres] Data directory corrupted (missing base). Re-initializing...');
            isInitialized = false;
        }
    }

    if (!isInitialized) {
        // Ensure directory is empty if we are going to run initdb
        if (await fs.pathExists(dataDir)) {
             const files = await fs.readdir(dataDir);
             if (files.length > 0) {
                 onLog('[postgres] Data directory corrupted or incomplete. Clearing for fresh init...');
                 await fs.emptyDir(dataDir);
             }
        }

        onLog('[postgres] Initializing database cluster...');
        const initdbBin = path.join(path.dirname(PATHS.POSTGRES_BIN), 'initdb'); // usually in same dir as postgres

        // sync call or promise wrapper? ProcessManager is async but we need to wait for init to finish.
        // We'll just spawn initdb directly since it's a one-off task.
        const { spawn } = require('child_process');
        await new Promise((resolve, reject) => {
            const initProc = spawn(initdbBin, ['-D', dataDir, '-U', 'postgres', '--auth', 'trust', '-E', 'UTF8']);
            initProc.stdout.on('data', d => onLog(`[initdb] ${d}`));
            initProc.stderr.on('data', d => onLog(`[initdb] ${d}`));
            initProc.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`initdb failed with code ${code}`));
            });
        });
        onLog('[postgres] Initialization complete.');
    }

    // 3. Start Server
    processManager.start('postgres', PATHS.POSTGRES_BIN, ['-D', dataDir, '-p', pgPort.toString()], {}, onLog);

    // 4. Wait for readiness and fix (Ensure default DB exists and user is superuser)
    try {
        await waitForPort(pgPort);
        await ensureDatabaseFixed(pgPort, PATHS.POSTGRES_BIN, onLog);
    } catch (e) {
        onLog(`[postgres] Warning: Post-startup check failed: ${e.message}`);
    }
}

function waitForPort(port) {
    return new Promise((resolve, reject) => {
        const timeout = Date.now() + 30000; // 30s timeout
        const interval = setInterval(() => {
            const socket = new net.Socket();
            socket.setTimeout(200);
            socket.on('connect', () => {
                socket.destroy();
                clearInterval(interval);
                resolve();
            });
            socket.on('timeout', () => {
                socket.destroy();
            });
            socket.on('error', (err) => {
                socket.destroy();
            });
            socket.connect(port, '127.0.0.1');

            if (Date.now() > timeout) {
                clearInterval(interval);
                reject(new Error('Timeout waiting for Postgres port'));
            }
        }, 500);
    });
}

async function ensureDatabaseFixed(port, binPath, onLog) {
    const { exec } = require('child_process');
    const execAsync = require('util').promisify(exec);
    
    // Construct paths
    let createdbBin = path.join(path.dirname(binPath), 'createdb');
    let psqlBin = path.join(path.dirname(binPath), 'psql');
    
    if (process.platform === 'win32') {
        createdbBin += '.exe';
        psqlBin += '.exe';
    }

    // 1. Ensure 'postgres' database exists
    try {
        // createdb -h 127.0.0.1 -p port -U postgres -w postgres
        // We use -w (no password) assuming trust auth
        // We use template1 as maintenance db to connect to because 'postgres' might not exist yet
        await execAsync(`"${createdbBin}" -h 127.0.0.1 -p ${port} -U postgres -w -d template1 -e postgres`);
        onLog('[postgres] Created default "postgres" database.');
    } catch (e) {
        // Ignore error if it already exists
        if (!e.message.includes('already exists')) {
             onLog(`[postgres] Warning: createdb failed (might already exist): ${e.message}`);
        }
    }

    // 2. Ensure 'postgres' user is superuser (just in case)
    try {
        await execAsync(`"${psqlBin}" -h 127.0.0.1 -p ${port} -U postgres -w -c "ALTER USER postgres WITH SUPERUSER CREATEDB;"`);
        onLog('[postgres] Ensured "postgres" user privileges.');
    } catch (e) {
        onLog(`[postgres] Warning: Failed to update user privileges: ${e.message}`);
    }
}

async function startPgAdmin(onLog, pgPort, pgAdminPort) {
    const dbPort = pgPort || PORTS.POSTGRES;
    const adminPort = pgAdminPort || PORTS.PGADMIN;

    if (!await fs.pathExists(PATHS.PYTHON_BIN)) {
        onLog(`[pgadmin] Python not found at ${PATHS.PYTHON_BIN}.`);
        return;
    }

    // pgAdmin4 entry point is usually pgAdmin4.py in the site-packages or source
    // Since we pip installed it, we need to find where pgAdmin4.py is.
    // If installed in the portable python, it's likely in Lib/site-packages/pgadmin4/pgAdmin4.py

    // Strategy: Search for pgAdmin4.py in site-packages
    // Note: Windows path separator handling is critical here.
    // Standard Python layout on Windows: python.exe is in root, Lib is in root.
    // So if python is at bin/win/python/python.exe, Lib is at bin/win/python/Lib.
    const sitePackages = config.IS_WIN
        ? path.join(path.dirname(config.PATHS.PYTHON_BIN), 'Lib', 'site-packages')
        : path.join(path.dirname(config.PATHS.PYTHON_BIN), '..', 'lib', 'python3.10', 'site-packages');

    // Fallback search
    let pgAdminPy = path.join(sitePackages, 'pgadmin4', 'pgAdmin4.py');

    // Let's ensure sitePackages exists.
    if (!await fs.pathExists(sitePackages)) {
        onLog(`[pgadmin] Warning: site-packages not found at ${sitePackages}`);
        
        // Try looking in the '..' location just in case (old logic)
        if (config.IS_WIN) {
             const altSitePackages = path.join(path.dirname(config.PATHS.PYTHON_BIN), '..', 'Lib', 'site-packages');
             if (await fs.pathExists(altSitePackages)) {
                 pgAdminPy = path.join(altSitePackages, 'pgadmin4', 'pgAdmin4.py');
                 onLog(`[pgadmin] Found site-packages at alternate location: ${altSitePackages}`);
             } else {
                 // Try searching recursively in the python dir for pgAdmin4.py
                 const pythonDir = path.dirname(config.PATHS.PYTHON_BIN);
                 onLog(`[pgadmin] Searching for pgAdmin4.py in ${pythonDir}...`);
                 // Simple depth-limited search could go here, but for now let's just log failure.
             }
        }
    }
    
    // Check if pgAdmin4.py actually exists
    if (!await fs.pathExists(pgAdminPy)) {
        onLog(`[pgadmin] Error: pgAdmin4.py not found at ${pgAdminPy}`);
        // Attempt to find it by walking the python directory
        try {
            const findFile = async (dir, filename) => {
                const files = await fs.readdir(dir);
                for (const file of files) {
                    const fullPath = path.join(dir, file);
                    const stat = await fs.stat(fullPath);
                    if (stat.isDirectory()) {
                        // Don't go too deep
                        if (file === 'site-packages' || file === 'pgadmin4') {
                             const found = await findFile(fullPath, filename);
                             if (found) return found;
                        }
                    } else if (file === filename) {
                        return fullPath;
                    }
                }
                return null;
            };
            
            // Search in Lib/site-packages
            const libDir = config.IS_WIN 
                ? path.join(path.dirname(config.PATHS.PYTHON_BIN), 'Lib')
                : path.join(path.dirname(config.PATHS.PYTHON_BIN), '..', 'lib');
                
            if (await fs.pathExists(libDir)) {
                const found = await findFile(libDir, 'pgAdmin4.py');
                if (found) {
                    pgAdminPy = found;
                    onLog(`[pgadmin] Found pgAdmin4.py at ${pgAdminPy}`);
                }
            }
        } catch (e) {
            onLog(`[pgadmin] Search failed: ${e.message}`);
        }
    }

    // Quick glob/find if we haven't installed it yet could fail.
    // We'll assume the setup script prints where it installed it or we assume standard layout.

    // Env vars for portable config
    const env = {
        ...process.env,
        PGADMIN_CONFIG_SERVER_MODE: 'False',
        PGADMIN_CONFIG_DATA_DIR: path.join(PATHS.DATA, 'pgadmin'),
        PGADMIN_CONFIG_SQLITE_PATH: path.join(PATHS.DATA, 'pgadmin', 'pgadmin.db'),
        PGADMIN_CONFIG_SESSION_DB_PATH: path.join(PATHS.DATA, 'pgadmin', 'sessions'),
        PGADMIN_CONFIG_STORAGE_DIR: path.join(PATHS.DATA, 'pgadmin', 'storage'),
        PGADMIN_PORT: adminPort.toString() // Set the port for pgAdmin
    };

    await fs.ensureDir(path.join(PATHS.DATA, 'pgadmin'));

    // Create config_local.py to force pgAdmin to use our portable paths
    // This is necessary because the pip-installed pgAdmin doesn't natively respect these env vars without a wrapper
    const configLocalPath = path.join(path.dirname(pgAdminPy), 'config_local.py');
    const configLocalContent = `
import os
APP_NAME = 'Portable PostGIS'
SERVER_MODE = os.environ.get('PGADMIN_CONFIG_SERVER_MODE', 'False') == 'True'
DATA_DIR = os.environ.get('PGADMIN_CONFIG_DATA_DIR')
SQLITE_PATH = os.environ.get('PGADMIN_CONFIG_SQLITE_PATH')
SESSION_DB_PATH = os.environ.get('PGADMIN_CONFIG_SESSION_DB_PATH')
STORAGE_DIR = os.environ.get('PGADMIN_CONFIG_STORAGE_DIR')
MASTER_PASSWORD_REQUIRED = False
DEFAULT_SERVER = '127.0.0.1'
DEFAULT_SERVER_PORT = int(os.environ.get('PGADMIN_PORT', 5050))
`;
    
    try {
        await fs.writeFile(configLocalPath, configLocalContent);
    } catch (err) {
        onLog(`[pgadmin] Error writing config_local.py: ${err.message}`);
        // If we can't write to the site-packages dir (common in some packed environments),
        // we might need to rely solely on env vars, but pgAdmin's env var support is tricky.
        // Let's assume for now we must fix the path if it's wrong.
    }

    // Auto-register the local Postgres server if not already done
    const serversJsonPath = path.join(PATHS.DATA, 'pgadmin', 'servers.json');
    const serversJsonContent = {
        "Servers": {
            "1": {
                "Name": "Portable Postgres",
                "Group": "Servers",
                "Port": dbPort,
                "Username": "postgres",
                "Host": "127.0.0.1",
                "SSLMode": "prefer",
                "MaintenanceDB": "postgres"
            }
        }
    };
    
    // We always register the server to ensure config is correct/repaired
    // This handles cases where user wiped data or config was corrupted
    const serverRegisteredFlag = path.join(PATHS.DATA, 'pgadmin', 'server_registered.flag');
    // if (!await fs.pathExists(serverRegisteredFlag)) { // Always run
        onLog('[pgadmin] Registering local server...');
        await fs.writeJson(serversJsonPath, serversJsonContent);
        
        // Run setup.py load-servers
        // We need to run this with the same python environment
        const setupPy = path.join(path.dirname(pgAdminPy), 'setup.py');
        const { spawn } = require('child_process');
        
        await new Promise((resolve, reject) => {
            const loadProc = spawn(PATHS.PYTHON_BIN, [setupPy, 'load-servers', serversJsonPath, '--replace'], { env });
            loadProc.stdout.on('data', d => onLog(`[pgadmin-setup] ${d}`));
            loadProc.stderr.on('data', d => onLog(`[pgadmin-setup] ${d}`));
            loadProc.on('close', code => {
                if (code === 0) {
                    onLog('[pgadmin] Server registered successfully.');
                    fs.writeFile(serverRegisteredFlag, 'done').then(resolve);
                } else {
                    onLog(`[pgadmin] Failed to register server (code ${code}).`);
                    resolve(); // Resolve anyway so we don't block startup
                }
            });
        });
    // }

    // Command: python -u path/to/pgAdmin4.py
    processManager.start('pgadmin', PATHS.PYTHON_BIN, ['-u', pgAdminPy], { env }, onLog);
}

function stopPostgres() {
    processManager.stop('postgres');
}

function stopPgAdmin() {
    processManager.stop('pgadmin');
}

module.exports = {
    startPostgres,
    startPgAdmin,
    stopPostgres,
    stopPgAdmin
};
