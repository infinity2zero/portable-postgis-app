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

    // Fix permissions (Important for Mac)
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
    // Detect which share layout exists (share/postgresql vs share)
    const postgresBinDir = path.dirname(PATHS.POSTGRES_BIN);
    const postgresRootDir = path.dirname(postgresBinDir);
    const postgresLibDir = path.join(postgresRootDir, 'lib');
    
    // Check both possible extension locations to determine correct PGSHARE
    const shareExtPath1 = path.join(postgresRootDir, 'share', 'extension');
    const shareExtPath2 = path.join(postgresRootDir, 'share', 'postgresql', 'extension');
    
    let baseShareRoot;
    if (await fs.pathExists(shareExtPath2)) {
        try {
            const files = await fs.readdir(shareExtPath2);
            if (files.length > 0) {
                baseShareRoot = path.join(postgresRootDir, 'share', 'postgresql');
                onLog(`[postgres] Using PGSHARE: ${baseShareRoot} (found ${files.length} extensions)`);
            } else {
                baseShareRoot = path.join(postgresRootDir, 'share');
                onLog(`[postgres] Using PGSHARE: ${baseShareRoot} (share/postgresql/extension is empty)`);
            }
        } catch (e) {
            baseShareRoot = path.join(postgresRootDir, 'share');
            onLog(`[postgres] Using PGSHARE: ${baseShareRoot} (fallback)`);
        }
    } else if (await fs.pathExists(shareExtPath1)) {
        baseShareRoot = path.join(postgresRootDir, 'share');
        onLog(`[postgres] Using PGSHARE: ${baseShareRoot}`);
    } else {
        // Fallback - should not happen if Postgres is properly installed
        baseShareRoot = path.join(postgresRootDir, 'share');
        onLog(`[postgres] ⚠️  WARNING: Extension directories not found. Using fallback PGSHARE: ${baseShareRoot}`);
    }
    
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

// Helper: Query PostgreSQL for available extensions (more reliable than file system checks)
async function queryAvailableExtensions(psqlBin, port, env) {
    const { execFile } = require('child_process');
    const execFileAsync = require('util').promisify(execFile);
    
    try {
        const { stdout } = await execFileAsync(psqlBin, [
            '-h', '127.0.0.1',
            '-p', port.toString(),
            '-U', 'postgres',
            '-w',
            '-d', 'postgres',
            '-A', '-t',
            '-c', "SELECT name FROM pg_available_extensions WHERE name IN ('postgis', 'postgis_topology', 'postgis_raster', 'pgrouting', 'fuzzystrmatch') ORDER BY name;"
        ], { env, timeout: 5000 });
        
        const extensions = stdout.trim().split('\n').filter(line => line.trim().length > 0);
        return extensions;
    } catch (e) {
        return [];
    }
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
    // We need to detect which layout exists and set PGSHARE accordingly.
    const postgresRootDir = path.dirname(path.dirname(binPath)); // .../postgres
    const postgresLibDir = path.join(postgresRootDir, 'lib');

    // Check both possible extension locations
    const shareExtPath1 = path.join(postgresRootDir, 'share', 'extension');
    const shareExtPath2 = path.join(postgresRootDir, 'share', 'postgresql', 'extension');
    
    let baseShareRoot;
    let sharePath;
    
    // Prefer share/postgresql/extension if it exists and has files, otherwise use share/extension
    if (await fs.pathExists(shareExtPath2)) {
        try {
            const files = await fs.readdir(shareExtPath2);
            if (files.length > 0) {
                baseShareRoot = path.join(postgresRootDir, 'share', 'postgresql');
                sharePath = shareExtPath2;
                onLog(`[postgres] Using extension directory: ${sharePath} (${files.length} files found)`);
            } else {
                // Empty directory, try the other location
                baseShareRoot = path.join(postgresRootDir, 'share');
                sharePath = shareExtPath1;
                onLog(`[postgres] share/postgresql/extension is empty, trying share/extension`);
            }
        } catch (e) {
            // Fallback to share/extension
            baseShareRoot = path.join(postgresRootDir, 'share');
            sharePath = shareExtPath1;
            onLog(`[postgres] Could not read share/postgresql/extension, using share/extension`);
        }
    } else if (await fs.pathExists(shareExtPath1)) {
        baseShareRoot = path.join(postgresRootDir, 'share');
        sharePath = shareExtPath1;
        onLog(`[postgres] Using extension directory: ${sharePath}`);
    } else {
        // Neither exists - this is a problem
        baseShareRoot = path.join(postgresRootDir, 'share');
        sharePath = shareExtPath1; // Default for PGSHARE, but we'll log error below
        onLog(`[postgres] ⚠️  WARNING: Neither extension directory found. Expected at:`);
        onLog(`[postgres]   - ${shareExtPath1}`);
        onLog(`[postgres]   - ${shareExtPath2}`);
    }
    
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

    // 3. Enable PostGIS extensions in 'postgres' database
    // First, query PostgreSQL to see what extensions are actually available
    // This is more reliable than file system checks
    onLog('[postgres] Checking available extensions from PostgreSQL catalog...');
    const availableExtensions = await queryAvailableExtensions(psqlBin, port, env);
    
    if (availableExtensions.length > 0) {
        onLog(`[postgres] Available extensions: ${availableExtensions.join(', ')}`);
    } else {
        onLog('[postgres] ⚠️  No PostGIS-related extensions found in PostgreSQL catalog.');
        onLog('[postgres] This may indicate PostGIS files are missing or PostgreSQL cannot find them.');
    }
    
    // Also check file system for debugging
    const postgisControl1 = path.join(shareExtPath1, 'postgis.control');
    const postgisControl2 = path.join(shareExtPath2, 'postgis.control');
    const postgisControlExists = await fs.pathExists(postgisControl1) || await fs.pathExists(postgisControl2);
    
    if (postgisControlExists) {
        const foundControlPath = await fs.pathExists(postgisControl1) ? postgisControl1 : postgisControl2;
        onLog(`[postgres] PostGIS control file found at: ${foundControlPath}`);
    } else {
        onLog(`[postgres] ⚠️  PostGIS control file not found in file system.`);
        onLog(`[postgres] Checked:`);
        onLog(`[postgres]   - ${postgisControl1}`);
        onLog(`[postgres]   - ${postgisControl2}`);
    }
    
    // Only proceed if PostGIS is available in PostgreSQL catalog
    if (!availableExtensions.includes('postgis')) {
        onLog(`[postgres] ⚠️  PostGIS not available in PostgreSQL. Skipping auto-enable.`);
        onLog(`[postgres] PGSHARE: ${baseShareRoot}`);
        onLog(`[postgres] Extension directory: ${sharePath}`);
        onLog(`[postgres] You may need to verify PostGIS installation or set PGSHARE correctly.`);
        return;
    }

    // Try to enable PostGIS - use query to check if it's already enabled first
    try {
        // Check if already enabled
        const checkResult = await execFileAsync(psqlBin, [
            '-h', '127.0.0.1',
            '-p', port.toString(),
            '-U', 'postgres',
            '-w',
            '-d', 'postgres',
            '-A', '-t',
            '-c', "SELECT COUNT(*) FROM pg_extension WHERE extname = 'postgis';"
        ], { env });
        
        const isEnabled = parseInt(checkResult.stdout.trim(), 10) > 0;
        
        if (!isEnabled) {
            onLog('[postgres] Enabling PostGIS extension...');
            await execFileAsync(psqlBin, [
                '-h', '127.0.0.1',
                '-p', port.toString(),
                '-U', 'postgres',
                '-w',
                '-d', 'postgres',
                '-c', 'CREATE EXTENSION IF NOT EXISTS postgis;'
            ], { env });
            onLog('[postgres] ✅ PostGIS extension enabled successfully.');
        } else {
            onLog('[postgres] ✅ PostGIS extension already enabled.');
        }
    } catch (e) {
        const errorMsg = e.message || e.stderr?.toString() || '';
        onLog(`[postgres] ❌ Failed to enable PostGIS extension: ${errorMsg}`);
        onLog(`[postgres] PGSHARE: ${baseShareRoot}`);
        onLog(`[postgres] Extension directory: ${sharePath}`);
        onLog(`[postgres] Control file found at: ${foundControlPath}`);
    }

    // Try pgRouting if available
    const pgroutingControl1 = path.join(shareExtPath1, 'pgrouting.control');
    const pgroutingControl2 = path.join(shareExtPath2, 'pgrouting.control');
    const pgroutingControlExists = await fs.pathExists(pgroutingControl1) || await fs.pathExists(pgroutingControl2);
    
    if (pgroutingControlExists) {
        try {
            const checkResult = await execFileAsync(psqlBin, [
                '-h', '127.0.0.1',
                '-p', port.toString(),
                '-U', 'postgres',
                '-w',
                '-d', 'postgres',
                '-A', '-t',
                '-c', "SELECT COUNT(*) FROM pg_extension WHERE extname = 'pgrouting';"
            ], { env });
            
            const isEnabled = parseInt(checkResult.stdout.trim(), 10) > 0;
            
            if (!isEnabled) {
                onLog('[postgres] Enabling pgRouting extension...');
                await execFileAsync(psqlBin, [
                    '-h', '127.0.0.1',
                    '-p', port.toString(),
                    '-U', 'postgres',
                    '-w',
                    '-d', 'postgres',
                    '-c', 'CREATE EXTENSION IF NOT EXISTS pgrouting;'
                ], { env });
                onLog('[postgres] ✅ pgRouting extension enabled successfully.');
            } else {
                onLog('[postgres] ✅ pgRouting extension already enabled.');
            }
        } catch (e) {
            const errorMsg = e.message || e.stderr?.toString() || '';
            onLog(`[postgres] ⚠️  Failed to enable pgRouting extension: ${errorMsg}`);
        }
    } else {
        onLog('[postgres] pgRouting extension not found (optional).');
    }
}

// pgAdmin has been removed from the bundle; use the built-in database browser in the Database tab.
async function startPgAdmin(onLog) {
    onLog('[pgadmin] pgAdmin is no longer bundled. Use the Database tab for the built-in browser.');
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
