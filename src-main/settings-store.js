const fs = require('fs-extra');
const path = require('path');
const { app } = require('electron');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
    ports: {
        postgres: 5432,
        pgadmin: 5050
    },
    dbUser: 'postgres',
    dbPassword: 'postgres',
    theme: 'light', // light, dark, auto (system)
    firstRun: true
};

let currentSettings = null;

async function load() {
    try {
        if (await fs.pathExists(SETTINGS_FILE)) {
            const data = await fs.readJson(SETTINGS_FILE);
            // Merge with defaults to ensure all keys exist
            currentSettings = {
            ...DEFAULT_SETTINGS,
            ...data,
            ports: { ...DEFAULT_SETTINGS.ports, ...(data.ports || {}) },
            dbUser: data.dbUser ?? DEFAULT_SETTINGS.dbUser,
            dbPassword: data.dbPassword ?? DEFAULT_SETTINGS.dbPassword
        };
        } else {
            currentSettings = { ...DEFAULT_SETTINGS };
            await save(currentSettings);
        }
    } catch (error) {
        console.error("Failed to load settings:", error);
        currentSettings = { ...DEFAULT_SETTINGS };
    }
    return currentSettings;
}

async function save(newSettings) {
    const base = currentSettings || { ...DEFAULT_SETTINGS };
    const merged = {
        ...base,
        ...newSettings,
        ports: { ...DEFAULT_SETTINGS.ports, ...(base.ports || {}), ...(newSettings.ports || {}) },
        dbUser: newSettings.dbUser !== undefined ? newSettings.dbUser : base.dbUser,
        dbPassword: newSettings.dbPassword !== undefined ? newSettings.dbPassword : base.dbPassword
    };
    try {
        await fs.writeJson(SETTINGS_FILE, merged, { spaces: 2 });
        currentSettings = merged;
        return currentSettings;
    } catch (error) {
        console.error("Failed to save settings:", error);
        return false;
    }
}

function get() {
    return currentSettings || DEFAULT_SETTINGS;
}

module.exports = {
    load,
    save,
    get
};
