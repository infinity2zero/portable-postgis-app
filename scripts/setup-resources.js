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
        python: "https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.10.13+20240107-x86_64-pc-windows-msvc-shared-install_only.tar.gz"
    }
};

const ARGS = process.argv.slice(2);
// Default to all targets if user asked for it, or just current platform
const TARGETS = ARGS.includes('--target=win') ? ['win']
    : ARGS.includes('--target=mac') ? ['mac']
        : ARGS.includes('--target=all') ? ['mac', 'win']
            : [process.platform === 'win32' ? 'win' : 'mac'];

async function downloadFile(url, dest) {
    console.log(`Downloading ${url}...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.statusText}`);

    const total = parseInt(res.headers.get('content-length'), 10);
    let current = 0;

    if (isNaN(total)) {
        console.log('Total size unknown based on content-length.');
    }

    const destStream = fs.createWriteStream(dest);

    // Track progress
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
}

async function installPostgres(targetOS) {
    const url = CONFIG[targetOS].postgres;
    const filename = path.basename(url);
    const binRoot = path.join(__dirname, '..', 'bin', targetOS);
    const downloadPath = path.join(binRoot, filename);
    const extractPath = path.join(binRoot, 'postgres');

    if (await fs.pathExists(extractPath)) {
        console.log(`[${targetOS}] Postgres already installed.`);
        return;
    }

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
    await fs.remove(downloadPath);

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

    // Adjust structure if needed. Indygreg builds usually have a 'python' top level folder.
    // If we extracted into `bin/mac/python`, we might have `bin/mac/python/python`.
    // Let's flatten if so.
    const innerPython = path.join(extractPath, 'python');
    if (await fs.pathExists(innerPython)) {
        const contents = await fs.readdir(innerPython);
        for (const item of contents) {
            await fs.move(path.join(innerPython, item), path.join(extractPath, item));
        }
        await fs.rmdir(innerPython);
    }

    // Indygreg 'install_only' builds for Windows often have an 'install' subdirectory.
    // Flatten that too if present, so python.exe is directly in bin/win/python/
    const installDir = path.join(extractPath, 'install');
    if (await fs.pathExists(installDir)) {
         const contents = await fs.readdir(installDir);
         for (const item of contents) {
             await fs.move(path.join(installDir, item), path.join(extractPath, item), { overwrite: true });
         }
         await fs.rmdir(installDir);
    }

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
    const pythonBin = targetOS === 'win'
        ? path.join(binRoot, 'python', 'python.exe')
        : path.join(binRoot, 'python', 'bin', 'python3');

    const { exec } = require('child_process');
    const execPromise = promisify(exec);

    try {
        await execPromise(`"${pythonBin}" -m pip install --upgrade pip`);
        console.log(`[${targetOS}] Pip upgraded.`);
        await execPromise(`"${pythonBin}" -m pip install pgadmin4`);
        console.log(`[${targetOS}] pgAdmin4 installed.`);
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
