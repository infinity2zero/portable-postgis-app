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
        postgres: "https://github.com/PostgresApp/PostgresApp/releases/download/v2.9.1/Postgres-2.9.1-16.dmg"
    },
    win: {
        postgres: "https://get.enterprisedb.com/postgresql/postgresql-14.10-1-windows-x64-binaries.zip",
        postgis: "https://download.osgeo.org/postgis/windows/pg14/postgis-bundle-pg14-3.6.1x64.zip"
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
        // Check both possible PostGIS locations inside the postgres tree
        const postgisControlPath1 = path.join(extractPath, 'share', 'extension', 'postgis.control');
        const postgisControlPath2 = path.join(extractPath, 'share', 'postgresql', 'extension', 'postgis.control');
        
        const postgisInstalled = await fs.pathExists(postgisControlPath1) || await fs.pathExists(postgisControlPath2);
        
        if (!postgisInstalled) {
            console.log(`[${targetOS}] PostGIS not found in postgres tree. Installing PostGIS extensions...`);
            console.log(`[${targetOS}] Expected locations:`);
            console.log(`[${targetOS}]   - ${postgisControlPath1}`);
            console.log(`[${targetOS}]   - ${postgisControlPath2}`);
            
            const postgisUrl = process.env.POSTGIS_URL || CONFIG.win.postgis;
            const postgisFilename = path.basename(postgisUrl);
            const postgisDownloadPath = path.join(binRoot, postgisFilename);

            try {
                await downloadFile(postgisUrl, postgisDownloadPath);
                console.log(`[${targetOS}] PostGIS bundle downloaded: ${postgisFilename}`);

                // Extract PostGIS to a temporary folder, then merge its bin/lib/share into our postgres tree.
                const tempPostgisDir = path.join(binRoot, 'postgis-temp');
                await fs.remove(tempPostgisDir);
                await fs.ensureDir(tempPostgisDir);

                console.log(`[${targetOS}] Extracting PostGIS into temporary folder ${tempPostgisDir}...`);
                const postgisZip = new AdmZip(postgisDownloadPath);
                
                // List contents before extraction for debugging
                const zipEntries = postgisZip.getEntries();
                console.log(`[${targetOS}] PostGIS zip contains ${zipEntries.length} entries`);
                
                postgisZip.extractAllTo(tempPostgisDir, true);
                console.log(`[${targetOS}] PostGIS extracted to temp folder.`);

                // Many PostGIS bundles have a top-level "postgis-bundle-..." folder.
                // Detect the actual bundle root that contains share/extension/postgis.control.
                const candidateRoots = [tempPostgisDir];
                try {
                    const children = await fs.readdir(tempPostgisDir, { withFileTypes: true });
                    for (const entry of children) {
                        if (entry.isDirectory()) {
                            candidateRoots.push(path.join(tempPostgisDir, entry.name));
                        }
                    }
                } catch (e) {
                    console.warn(`[${targetOS}] Failed to list children of temp PostGIS dir: ${e.message}`);
                }

                let bundleRoot = null;
                for (const root of candidateRoots) {
                    const c1 = path.join(root, 'share', 'extension', 'postgis.control');
                    const c2 = path.join(root, 'share', 'postgresql', 'extension', 'postgis.control');
                    if (await fs.pathExists(c1) || await fs.pathExists(c2)) {
                        bundleRoot = root;
                        break;
                    }
                }

                if (!bundleRoot) {
                    console.warn(`[${targetOS}] ⚠️  Could not locate PostGIS share/extension directory inside bundle.`);
                    console.warn(`[${targetOS}] Temp folder contents will be listed for debugging.`);
                    try {
                        const tempContents = await fs.readdir(tempPostgisDir);
                        console.log(`[${targetOS}] postgis-temp contents: ${tempContents.join(', ')}`);
                    } catch (e) {
                        console.warn(`[${targetOS}] Failed to list postgis-temp contents: ${e.message}`);
                    }
                } else {
                    console.log(`[${targetOS}] Found PostGIS bundle root at ${bundleRoot}. Merging into postgres tree...`);
                    // Merge key directories from bundleRoot into our postgres extractPath
                    const dirsToMerge = ['bin', 'lib', 'share', 'include'];
                    for (const dirName of dirsToMerge) {
                        const srcDir = path.join(bundleRoot, dirName);
                        if (await fs.pathExists(srcDir)) {
                            const destDir = path.join(extractPath, dirName);
                            console.log(`[${targetOS}] Merging ${srcDir} -> ${destDir}`);
                            await fs.ensureDir(destDir);
                            await fs.copy(srcDir, destDir, { overwrite: true });
                        }
                    }
                }

                // Clean up temp bundle and archive
                await fs.remove(tempPostgisDir);
                await fs.remove(postgisDownloadPath);

                // Verify PostGIS files were merged correctly
                const verifyPath1 = path.join(extractPath, 'share', 'extension', 'postgis.control');
                const verifyPath2 = path.join(extractPath, 'share', 'postgresql', 'extension', 'postgis.control');
                
                if (await fs.pathExists(verifyPath1)) {
                    console.log(`[${targetOS}] ✅ PostGIS verified at: ${verifyPath1}`);
                } else if (await fs.pathExists(verifyPath2)) {
                    console.log(`[${targetOS}] ✅ PostGIS verified at: ${verifyPath2}`);
                } else {
                    // List what actually exists in share directories for debugging
                    const shareDir = path.join(extractPath, 'share');
                    if (await fs.pathExists(shareDir)) {
                        try {
                            const shareContents = await fs.readdir(shareDir);
                            console.log(`[${targetOS}] Share directory contents: ${shareContents.join(', ')}`);
                            
                            // Check extension directories
                            const extDir1 = path.join(shareDir, 'extension');
                            const extDir2 = path.join(shareDir, 'postgresql', 'extension');
                            
                            if (await fs.pathExists(extDir1)) {
                                const extFiles1 = await fs.readdir(extDir1);
                                console.log(`[${targetOS}] share/extension contains: ${extFiles1.slice(0, 10).join(', ')}${extFiles1.length > 10 ? '...' : ''}`);
                            }
                            if (await fs.pathExists(extDir2)) {
                                const extFiles2 = await fs.readdir(extDir2);
                                console.log(`[${targetOS}] share/postgresql/extension contains: ${extFiles2.slice(0, 10).join(', ')}${extFiles2.length > 10 ? '...' : ''}`);
                            }
                        } catch (e) {
                            console.warn(`[${targetOS}] Could not list share directory: ${e.message}`);
                        }
                    }
                    console.warn(`[${targetOS}] ⚠️  PostGIS control file not found after merge. PostGIS may not work correctly.`);
                }

                console.log(`[${targetOS}] PostGIS installation/merge complete.`);
            } catch (e) {
                // Non-fatal: log and continue
                console.error(`[${targetOS}] ❌ Failed to download/install PostGIS from ${postgisUrl}: ${e.message}`);
                console.warn(`[${targetOS}] Continuing without PostGIS - you can set POSTGIS_URL in CI to a valid bundle URL.`);
            }
        } else {
            const foundPath = await fs.pathExists(postgisControlPath1) ? postgisControlPath1 : postgisControlPath2;
            console.log(`[${targetOS}] ✅ PostGIS already installed at: ${foundPath}`);
        }

        // Remove redundant dirs from postgres tree to reduce bundle size (Windows)
        const dirsToRemove = ['symbols', 'StackBuilder', 'include', 'doc', 'pgAdmin 4'];
        for (const dirName of dirsToRemove) {
            const fullPath = path.join(extractPath, dirName);
            if (await fs.pathExists(fullPath)) {
                await fs.remove(fullPath);
                console.log(`[${targetOS}] Removed ${dirName}/ from postgres (not needed at runtime).`);
            }
        }
        // Remove any leftover postgis-bundle-* folder (from old extraction layout)
        try {
            const entries = await fs.readdir(extractPath);
            for (const name of entries) {
                if (name.toLowerCase().startsWith('postgis-bundle-')) {
                    await fs.remove(path.join(extractPath, name));
                    console.log(`[${targetOS}] Removed ${name}/ from postgres (merged content only kept).`);
                }
            }
        } catch (e) {
            console.warn(`[${targetOS}] Could not clean postgis-bundle dirs: ${e.message}`);
        }
    }
}

// Python was only used by pgAdmin; no longer bundled.
async function installPython(_targetOS) {
    console.log('[setup] Python is no longer bundled (pgAdmin removed); skipping.');
}

// pgAdmin has been removed from the bundle; the app uses the built-in database browser only.
async function installPgAdmin(_targetOS) {
    console.log('[setup] pgAdmin is no longer bundled; skipping.');
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
