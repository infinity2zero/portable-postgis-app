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

    // 3. Start Server with proper environment variables
    // Set PostgreSQL environment variables so it can find extensions and libraries.
    // As above, prefer .../share/postgresql if present, otherwise fall back to .../share.
    const postgresBinDir = path.dirname(PATHS.POSTGRES_BIN);
    const postgresRootDir = path.dirname(postgresBinDir);
    let baseShareRoot = path.join(postgresRootDir, 'share', 'postgresql');
    if (!await fs.pathExists(baseShareRoot)) {
        baseShareRoot = path.join(postgresRootDir, 'share');
    }
    const postgresLibDir = path.join(postgresRootDir, 'lib');
    
    const postgresEnv = {
        ...process.env,
        PGSHARE: baseShareRoot,
        PGLIB: postgresLibDir,
        // On Windows, also set PATH to include PostgreSQL bin directory
        PATH: process.platform === 'win32' 
            ? `${postgresBinDir}${path.delimiter}${process.env.PATH}`
            : process.env.PATH
    };
    
    processManager.start('postgres', PATHS.POSTGRES_BIN, ['-D', dataDir, '-p', pgPort.toString()], { env: postgresEnv }, onLog);

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
    const { execFile } = require('child_process');
    const execFileAsync = require('util').promisify(execFile);
    
    // Construct paths - normalize for Windows
    let createdbBin = path.join(path.dirname(binPath), 'createdb');
    let psqlBin = path.join(path.dirname(binPath), 'psql');
    
    if (process.platform === 'win32') {
        createdbBin += '.exe';
        psqlBin += '.exe';
    }

    // Set PostgreSQL environment variables so it can find extensions.
    // On Windows distributions, extensions may live under either:
    //   .../postgres/share/extension
    //   .../postgres/share/postgresql/extension
    // We prefer the 'share/postgresql' layout if it exists and point PGSHARE there,
    // so the server looks in the correct place for control files.
    const postgresRootDir = path.dirname(path.dirname(binPath)); // .../postgres
    const postgresLibDir = path.join(postgresRootDir, 'lib');

    // Determine the base share root that actually exists
    let baseShareRoot = path.join(postgresRootDir, 'share', 'postgresql');
    if (!await fs.pathExists(baseShareRoot)) {
        baseShareRoot = path.join(postgresRootDir, 'share');
    }

    // Extension directory under the chosen share root
    let sharePath = path.join(baseShareRoot, 'extension');
    
    const env = {
        ...process.env,
        PGSHARE: baseShareRoot,
        PGLIB: postgresLibDir
    };

    // 1. Ensure 'postgres' database exists
    // First check if it exists by trying to connect
    let dbExists = false;
    try {
        await execFileAsync(psqlBin, [
            '-h', '127.0.0.1',
            '-p', port.toString(),
            '-U', 'postgres',
            '-w',
            '-d', 'postgres',
            '-c', 'SELECT 1;'
        ], { env, timeout: 5000 });
        dbExists = true;
        onLog('[postgres] Database "postgres" already exists.');
    } catch (e) {
        // Database doesn't exist or connection failed, try to create it
        try {
            // Use execFile with proper arguments array for Windows compatibility
            // createdb -h 127.0.0.1 -p port -U postgres -w postgres
            // We use -w (no password) assuming trust auth
            // We use template1 as maintenance db to connect to because 'postgres' might not exist yet
            await execFileAsync(createdbBin, [
                '-h', '127.0.0.1',
                '-p', port.toString(),
                '-U', 'postgres',
                '-w',
                '-d', 'template1',
                '-e',
                'postgres'
            ], { env, timeout: 10000 });
            onLog('[postgres] Created default "postgres" database.');
            dbExists = true;
        } catch (createError) {
            // Ignore error if it already exists
            const errorMsg = createError.message || createError.stderr?.toString() || '';
            if (errorMsg.includes('already exists') || errorMsg.includes('duplicate')) {
                onLog('[postgres] Database "postgres" already exists.');
                dbExists = true;
            } else {
                onLog(`[postgres] Error: Failed to create database "postgres": ${errorMsg}`);
                onLog(`[postgres] createdb path: ${createdbBin}`);
                onLog(`[postgres] This may prevent extensions from being enabled.`);
            }
        }
    }
    
    // If database doesn't exist, we can't proceed with extension setup
    if (!dbExists) {
        onLog('[postgres] Cannot proceed with extension setup - database does not exist.');
        return;
    }

    // 2. Ensure 'postgres' user is superuser (just in case)
    try {
        await execFileAsync(psqlBin, [
            '-h', '127.0.0.1',
            '-p', port.toString(),
            '-U', 'postgres',
            '-w',
            '-d', 'postgres',
            '-c', 'ALTER USER postgres WITH SUPERUSER CREATEDB;'
        ], { env });
        onLog('[postgres] Ensured "postgres" user privileges.');
    } catch (e) {
        const errorMsg = e.message || e.stderr?.toString() || '';
        onLog(`[postgres] Warning: Failed to update user privileges: ${errorMsg}`);
    }

    // 3. Ensure 'postgis' extension is enabled in 'postgres' database
    // This is important because users expect it to be ready.
    // First verify the extension files exist
    const postgisControl = path.join(sharePath, 'postgis.control');
    if (!await fs.pathExists(postgisControl)) {
        onLog(`[postgres] Warning: PostGIS extension not found at ${postgisControl}. Skipping extension enable.`);
        onLog(`[postgres] Share root: ${baseShareRoot}`);
        onLog(`[postgres] Extension directory: ${sharePath}`);
        return;
    }

    try {
        await execFileAsync(psqlBin, [
            '-h', '127.0.0.1',
            '-p', port.toString(),
            '-U', 'postgres',
            '-w',
            '-d', 'postgres',
            '-c', 'CREATE EXTENSION IF NOT EXISTS postgis;'
        ], { env });
        onLog('[postgres] Enabled PostGIS extension.');
    } catch (e) {
        const errorMsg = e.message || e.stderr?.toString() || '';
        onLog(`[postgres] Warning: Failed to enable PostGIS extension: ${errorMsg}`);
        onLog(`[postgres] Extension path: ${sharePath}`);
    }

    // Try pgRouting if available
    const pgroutingControl = path.join(sharePath, 'pgrouting.control');
    if (await fs.pathExists(pgroutingControl)) {
        try {
            await execFileAsync(psqlBin, [
                '-h', '127.0.0.1',
                '-p', port.toString(),
                '-U', 'postgres',
                '-w',
                '-d', 'postgres',
                '-c', 'CREATE EXTENSION IF NOT EXISTS pgrouting;'
            ], { env });
            onLog('[postgres] Enabled pgRouting extension.');
        } catch (e) {
            const errorMsg = e.message || e.stderr?.toString() || '';
            onLog(`[postgres] Warning: Failed to enable pgRouting extension: ${errorMsg}`);
        }
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
             // Also check inside python/Lib/site-packages (if PYTHON_BIN is python/python.exe)
             const innerSitePackages = path.join(path.dirname(config.PATHS.PYTHON_BIN), 'Lib', 'site-packages');
             
             if (await fs.pathExists(altSitePackages)) {
                 pgAdminPy = path.join(altSitePackages, 'pgadmin4', 'pgAdmin4.py');
                 onLog(`[pgadmin] Found site-packages at alternate location: ${altSitePackages}`);
             } else if (await fs.pathExists(innerSitePackages)) {
                 pgAdminPy = path.join(innerSitePackages, 'pgadmin4', 'pgAdmin4.py');
                 onLog(`[pgadmin] Found site-packages at inner location: ${innerSitePackages}`);
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
            const findFile = async (dir, filename, depth = 0) => {
                if (depth > 5) return null; // Prevent infinite recursion
                const files = await fs.readdir(dir);
                for (const file of files) {
                    const fullPath = path.join(dir, file);
                    try {
                        const stat = await fs.stat(fullPath);
                        if (stat.isDirectory()) {
                            // Don't go too deep, but check pgadmin4 or site-packages or Lib
                            // Also check just 'Lib' or 'site-packages'
                            if (file === 'site-packages' || file === 'pgadmin4' || file === 'Lib' || file === 'python') {
                                 const found = await findFile(fullPath, filename, depth + 1);
                                 if (found) return found;
                            }
                        } else if (file === filename) {
                            return fullPath;
                        }
                    } catch (e) {
                        // Ignore access errors
                    }
                }
                return null;
            };
            
            // Search in root of python installation
            // For portable python, it might be nested. 
            // C:\...\bin\win\python\python.exe -> Root is C:\...\bin\win\python
            const pythonRoot = path.dirname(config.PATHS.PYTHON_BIN);
                
            if (await fs.pathExists(pythonRoot)) {
                onLog(`[pgadmin] Deep searching for pgAdmin4.py in ${pythonRoot}...`);
                const found = await findFile(pythonRoot, 'pgAdmin4.py');
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
