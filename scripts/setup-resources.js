const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');
const { pipeline } = require('stream');
const { promisify } = require('util');
const streamPipeline = promisify(pipeline);
const tar = require('tar');

// Configuration for Binaries
const CONFIG = {
    mac: {
        postgres: "https://github.com/PostgresApp/PostgresApp/releases/download/v2.9.1/Postgres-2.9.1-16.dmg",
        python: "https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.10.13+20240107-x86_64-apple-darwin-install_only.tar.gz"
    },
    win: {
        postgres: "https://get.enterprisedb.com/postgresql/postgresql-14.10-1-windows-x64-binaries.zip",
        postgis: "https://download.osgeo.org/postgis/windows/pg14/postgis-bundle-pg14-3.6.1x64.zip",
        python: "https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.10.13+20240107-x86_64-pc-windows-msvc-shared-install_only.tar.gz"
    }
};

const ARGS = process.argv.slice(2);
// Default to all targets if user asked for it, or just current platform
const TARGETS = ARGS.includes('--target=win') ? ['win']
    : ARGS.includes('--target=mac') ? ['mac']
        : ARGS.includes('--target=all') ? ['mac', 'win']
            : [process.platform === 'win32' ? 'win' : 'mac'];

async function downloadFile(url, dest, { retries = 3, retryDelayMs = 1000 } = {}) {
    console.log(`Downloading ${url}...`);

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url);
            
            if (res.status === 404) {
                throw new Error(`Failed to fetch ${url}: 404 Not Found`);
            }
            
            if (!res.ok) {
                const statusText = res.statusText || `HTTP ${res.status}`;
                if (attempt < retries) {
                    console.warn(`Download attempt ${attempt} failed: ${statusText}. Retrying in ${retryDelayMs}ms...`);
                    await new Promise(r => setTimeout(r, retryDelayMs));
                    retryDelayMs *= 2;
                    continue;
                } else {
                    throw new Error(`Failed to fetch ${url}: ${statusText}`);
                }
            }

            const total = parseInt(res.headers.get('content-length'), 10);
            let current = 0;

            if (isNaN(total)) {
                console.log('Total size unknown based on content-length.');
            }

            const destStream = fs.createWriteStream(dest);

            res.body.on('data', (chunk) => {
                current += chunk.length;
                if (total && !isNaN(total)) {
                    const percent = ((current / total) * 100).toFixed(1);
                    process.stdout.write(`\rProgress: ${percent}% (${(current / 1024 / 1024).toFixed(1)} MB / ${(total / 1024 / 1024).toFixed(1)} MB)`);
                } else {
                    process.stdout.write(`\rDownloaded: ${(current / 1024 / 1024).toFixed(1)} MB`);
                }
            });

            await new Promise((resolve, reject) => {
                res.body.pipe(destStream);
                res.body.on("error", reject);
                destStream.on("finish", () => {
                    process.stdout.write('\n'); // Clear line of progress
                    resolve();
                });
            });
            console.log(`Downloaded to ${dest}`);
            return;
        } catch (e) {
            // If it's the last attempt or a fatal error (like 404), rethrow
            if (attempt === retries || e.message.includes('404 Not Found')) {
                throw e;
            }
            console.warn(`Download attempt ${attempt} error: ${e.message}. Retrying in ${retryDelayMs}ms...`);
            await new Promise(r => setTimeout(r, retryDelayMs));
            retryDelayMs *= 2;
        }
    }
}

async function installPostgres(targetOS) {
    const url = CONFIG[targetOS].postgres;
    const filename = path.basename(url);
    const binRoot = path.join(__dirname, '..', 'bin', targetOS);
    const downloadPath = path.join(binRoot, filename);
    const extractPath = path.join(binRoot, 'postgres');
    
    // Check if Postgres is already installed
    let postgresInstalled = await fs.pathExists(extractPath);
    
    if (!postgresInstalled) {
        await fs.ensureDir(binRoot);
        await downloadFile(url, downloadPath);

        // Spinner helper
        const spin = () => {
            const chars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
            let i = 0;
            return setInterval(() => {
                process.stdout.write(`\rExtracting... ${chars[i++ % chars.length]}`);
            }, 100);
        };

        console.log(`[${targetOS}] Extracting Postgres...`);
        const spinner = spin();

        try {
            if (filename.endsWith('.dmg')) {
                const { exec } = require('child_process');
                const execAsync = promisify(exec);
                const mountPoint = path.join('/tmp', 'pgapp_mount_' + Date.now());
                
                await fs.ensureDir(mountPoint);
                
                try {
                    // Attach DMG
                    await execAsync(`hdiutil attach -nobrowse -mountpoint "${mountPoint}" "${downloadPath}"`);
                    
                    // Copy binaries from Postgres.app/Contents/Versions/14 (or latest version dir found)
                    const versionsDir = path.join(mountPoint, 'Postgres.app', 'Contents', 'Versions');
                    let versionToCopy = '16';
                    if (!await fs.pathExists(path.join(versionsDir, versionToCopy))) {
                        const dirs = await fs.readdir(versionsDir);
                        if (dirs.length > 0) versionToCopy = dirs[0];
                    }

                    const source = path.join(versionsDir, versionToCopy);
                    if (await fs.pathExists(source)) {
                        console.log(`[${targetOS}] Copying binaries from ${source}...`);
                        await fs.copy(source, extractPath);
                    } else {
                        throw new Error(`Could not find Postgres binaries in DMG at ${source}`);
                    }
                } finally {
                    // Detach DMG
                    try {
                        await execAsync(`hdiutil detach "${mountPoint}" -force`);
                    } catch (e) {
                        console.warn('Failed to unmount:', e.message);
                    }
                }
                
                clearInterval(spinner);
                process.stdout.write('\rExtracting... Done!   \n');

            } else if (process.platform === 'win32' || targetOS === 'win') {
                const zip = new AdmZip(downloadPath);
                zip.extractAllTo(binRoot, true);
                clearInterval(spinner);
                process.stdout.write('\rExtracting... Done!   \n');

            } else {
                const { spawn } = require('child_process');
                // Use spawn to avoid buffer issues and allow async flow
                await new Promise((resolve, reject) => {
                    const child = spawn('unzip', ['-o', '-q', downloadPath, '-d', binRoot]);
                    child.on('close', code => code === 0 ? resolve() : reject(new Error(`unzip exited with ${code}`)));
                    child.on('error', reject);
                });
                clearInterval(spinner);
                process.stdout.write('\rExtracting... Done!   \n');
            }
        } catch (e) {
            clearInterval(spinner);
            process.stdout.write('\n');
            // Unzip failed. Corrupted download?
            await fs.remove(downloadPath);
            await fs.remove(extractPath);
            throw new Error(`Unzip failed. Download likely corrupted. Deleted ${downloadPath}. Please run setup again.`);
        }

        // EnterpriseDB zips usually extract to a 'pgsql' folder. Rename it.
        if (await fs.pathExists(path.join(binRoot, 'pgsql'))) {
            await fs.rename(path.join(binRoot, 'pgsql'), extractPath);
        }

        await fs.remove(downloadPath);
        // await fs.remove(downloadPath); // Duplicate removal?

        if (process.platform !== 'win32' && targetOS !== 'win') {
            const { execSync } = require('child_process');
            try {
                // Make binaries executable
                const binDir = path.join(binRoot, 'postgres', 'bin');
                if (await fs.pathExists(binDir)) {
                    execSync(`chmod +x "${path.join(binDir, '*')}"`, { stdio: 'inherit', shell: true });
                    console.log(`[${targetOS}] Fixed permissions for Postgres binaries.`);
                }
            } catch (e) {
                console.error(`[${targetOS}] Failed to chmod postgres binaries:`, e.message);
            }
        }

        console.log(`[${targetOS}] Postgres installed.`);
        postgresInstalled = true;
    } else {
        console.log(`[${targetOS}] Postgres already installed.`);
    }

    // Install PostGIS for Windows (Check if installed separately)
    if (postgresInstalled && (process.platform === 'win32' || targetOS === 'win')) {
        const postgisControlPath = path.join(extractPath, 'share', 'extension', 'postgis.control');

        if (!await fs.pathExists(postgisControlPath)) {
            console.log(`[${targetOS}] Installing PostGIS extensions...`);
            const postgisUrl = process.env.POSTGIS_URL || CONFIG.win.postgis;
            const postgisFilename = path.basename(postgisUrl);
            const postgisDownloadPath = path.join(binRoot, postgisFilename);

            try {
                await downloadFile(postgisUrl, postgisDownloadPath);

                console.log(`[${targetOS}] Extracting PostGIS...`);
                const postgisZip = new AdmZip(postgisDownloadPath);
                // Extract directly into postgres folder to merge bin/share/lib
                postgisZip.extractAllTo(extractPath, true);

                await fs.remove(postgisDownloadPath);
                console.log(`[${targetOS}] PostGIS installed.`);
            } catch (e) {
                // Non-fatal: log and continue so Python can still be installed
                console.warn(`[${targetOS}] Warning: Failed to download/install PostGIS from ${postgisUrl}: ${e.message}`);
                console.warn(`[${targetOS}] Continuing without PostGIS - you can set POSTGIS_URL in CI to a valid bundle URL.`);
            }
        } else {
            console.log(`[${targetOS}] PostGIS already installed.`);
        }
    }
}

async function installPython(targetOS) {
    const url = CONFIG[targetOS].python;
    const filename = path.basename(url);
    const binRoot = path.join(__dirname, '..', 'bin', targetOS);
    const downloadPath = path.join(binRoot, filename);
    const extractPath = path.join(binRoot, 'python');

    if (await fs.pathExists(extractPath)) {
        console.log(`[${targetOS}] Python already installed.`);
        return;
    }

    await fs.ensureDir(binRoot);
    await downloadFile(url, downloadPath);

    console.log(`[${targetOS}] Extracting Python...`);
    await fs.ensureDir(extractPath);

    // Python standalone builds are .tar.gz usually
    await tar.x({
        file: downloadPath,
        cwd: extractPath,
        strip: 0 // usually contains 'python' dir, check structure
    });

    // Smart flattening: Find the binary and move everything up
    const binaryName = targetOS === 'win' ? 'python.exe' : path.join('bin', 'python3');
    
    const findBinary = async (dir, targetEnd) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const found = await findBinary(fullPath, targetEnd);
                if (found) return found;
            } else {
                // Check if this file matches the target binary name (or path suffix)
                if (fullPath.endsWith(targetEnd)) {
                    return fullPath;
                }
            }
        }
        return null;
    };

    console.log(`[${targetOS}] Searching for ${binaryName}...`);
    const foundPath = await findBinary(extractPath, binaryName);

    if (foundPath) {
        console.log(`[${targetOS}] Found binary at ${foundPath}`);
        // Determine the root of the python installation
        // If binary is 'python.exe', root is dirname(foundPath)
        // If binary is 'bin/python3', root is dirname(dirname(foundPath))
        
        let sourceRoot = path.dirname(foundPath);
        // If targetEnd contained separators (e.g. bin/python3), go up
        const parts = binaryName.split(path.sep);
        if (parts.length > 1) {
            for (let i = 0; i < parts.length - 1; i++) {
                sourceRoot = path.dirname(sourceRoot);
            }
        }

        if (sourceRoot !== extractPath) {
            console.log(`[${targetOS}] Flattening from ${sourceRoot} to ${extractPath}...`);
            const contents = await fs.readdir(sourceRoot);
            for (const item of contents) {
                // Move items up
                await fs.move(path.join(sourceRoot, item), path.join(extractPath, item), { overwrite: true });
            }
            // Try to remove the now empty source directories if they are inside extractPath
            // (Optional, keeps things clean)
        }
    } else {
        throw new Error(`Could not find ${binaryName} in extracted files.`);
    }

    /* 
    // Old flattening logic removed in favor of smart search
    // Adjust structure if needed. Indygreg builds usually have a 'python' top level folder.
    const innerPython = path.join(extractPath, 'python');
    if (await fs.pathExists(innerPython)) { ... }
    const installDir = path.join(extractPath, 'install');
    if (await fs.pathExists(installDir)) { ... }
    */

    await fs.remove(downloadPath);
    console.log(`[${targetOS}] Python installed.`);
}

async function installPgAdmin(targetOS) {
    if (targetOS !== process.platform && process.platform === 'darwin' && targetOS !== 'mac') {
        // Can't pip install windows while on mac easily
        console.log(`[${targetOS}] Skipping pgAdmin install (must run on target OS).`);
        return;
    }
    if (process.platform === 'win32' && targetOS !== 'win') {
        return;
    }

    // Only install pgAdmin if we are ON the target OS (checked above roughly)
    // Actually, "mac" on "darwin" is fine. "win" on "win32" is fine.

    // Double check strictly
    if (targetOS === 'mac' && process.platform !== 'darwin') return;
    if (targetOS === 'win' && process.platform !== 'win32') {
        console.log(`[${targetOS}] Skipping pgAdmin install for Windows (running on Mac). Run this script on Windows to finish setup.`);
        return;
    }

    console.log(`[${targetOS}] Installing pgAdmin4 via pip...`);
    const binRoot = path.join(__dirname, '..', 'bin', targetOS);

    // Base Python coming from the portable distribution
    const basePython =
        targetOS === 'win'
            ? path.join(binRoot, 'python', 'python.exe')
            : path.join(binRoot, 'python', 'bin', 'python3');

    const { exec } = require('child_process');
    const execPromise = promisify(exec);

    // On Windows, run pgAdmin inside its own venv so pyvenv.cfg exists and layout
    // matches what pgAdmin expects. On mac we keep current behaviour (no venv)
    // because the app is already working fine there.
    let effectivePython = basePython;

    if (targetOS === 'win') {
        const venvDir = path.join(binRoot, 'python', 'pgadmin-venv');
        const venvCfg = path.join(venvDir, 'pyvenv.cfg');
        const venvPython = path.join(venvDir, 'Scripts', 'python.exe');

        try {
            const venvExists = await fs.pathExists(venvDir);
            const cfgExists = await fs.pathExists(venvCfg);

            if (!venvExists || !cfgExists) {
                console.log(`[${targetOS}] Creating pgAdmin virtualenv at ${venvDir}...`);
                console.log(`[${targetOS}] Using base Python: ${basePython}`);
                await fs.ensureDir(path.dirname(venvDir));
                await execPromise(`"${basePython}" -m venv "${venvDir}"`);
                console.log(`[${targetOS}] pgAdmin virtualenv created.`);
            } else {
                console.log(`[${targetOS}] pgAdmin virtualenv already present at ${venvDir}.`);
            }

            if (await fs.pathExists(venvPython)) {
                effectivePython = venvPython;
                console.log(`[${targetOS}] Using venv Python for pgAdmin: ${effectivePython}`);
                // Log Python version for debugging
                try {
                    const { stdout } = await execPromise(`"${effectivePython}" --version`);
                    console.log(`[${targetOS}] venv Python version: ${stdout.trim()}`);
                } catch (e) {
                    console.warn(`[${targetOS}] Failed to get venv Python version: ${e.message}`);
                }
            } else {
                console.warn(
                    `[${targetOS}] venv Python not found at ${venvPython}, falling back to base Python ${basePython}`
                );
            }
        } catch (e) {
            console.error(`[${targetOS}] Failed to create/use pgAdmin venv:`, e);
            console.warn(`[${targetOS}] Falling back to base Python for pgAdmin installation.`);
            effectivePython = basePython;
        }
    }

    try {
        console.log(`[${targetOS}] Upgrading pip using ${effectivePython}...`);
        await execPromise(`"${effectivePython}" -m pip install --upgrade pip`);
        console.log(`[${targetOS}] Pip upgraded.`);

        console.log(`[${targetOS}] Installing pgAdmin4==8.4 using ${effectivePython}...`);
        // Install specific version of pgadmin4 to avoid known registry issues in some newer builds
        await execPromise(`"${effectivePython}" -m pip install pgadmin4==8.4`);
        console.log(`[${targetOS}] pgAdmin4 installed successfully.`);
    } catch (e) {
        console.error(`[${targetOS}] Failed to install pgAdmin:`, e);
    }
}

async function run() {
    try {
        console.log(`Targets: ${TARGETS.join(', ')}`);
        for (const target of TARGETS) {
            console.log(`--- Setting up for ${target} ---`);
            await installPostgres(target);
            await installPython(target);
            await installPgAdmin(target);
        }
        console.log('Setup complete!');
    } catch (err) {
        console.error('Setup failed:', err);
    }
}

run();
