const path = require('path');
const os = require('os');

// Detect if we are running in a packaged environment (ASAR)
// By checking if __dirname contains 'app.asar'
const isPackaged = __dirname.includes('app.asar');

const IS_WIN = process.platform === 'win32';

// In dev: __dirname is src-main/, so .. is root.
// In prod (ASAR): __dirname is resources/app.asar/src-main, so .. is app.asar, ../.. is resources.
const ROOT_DIR = isPackaged 
    ? path.join(__dirname, '..', '..') 
    : path.join(__dirname, '..');

const BIN_DIR = path.join(ROOT_DIR, 'bin', IS_WIN ? 'win' : 'mac');

// Fix for Windows ASAR path issue:
// If we are in ASAR on Windows, path.join might produce mixed slashes or issues if ROOT_DIR has weird casing.
// But mostly, let's just ensure we rely on standard path module behavior.

const DATA_DIR = path.join(ROOT_DIR, 'data');

module.exports = {
    IS_WIN,
    isPackaged,
    PATHS: {
        ROOT: ROOT_DIR,
        BIN: BIN_DIR,
        DATA: DATA_DIR,
        // Postgres: usually bin/postgres/bin/postgres
        POSTGRES_BIN: IS_WIN
            ? path.join(BIN_DIR, 'postgres', 'bin', 'postgres.exe')
            : path.join(BIN_DIR, 'postgres', 'bin', 'postgres'),
    },
    PORTS: {
        POSTGRES: 5432,
        PGADMIN: 5050
    }
};
