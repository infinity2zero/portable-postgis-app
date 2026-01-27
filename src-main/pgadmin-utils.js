const { execFile } = require('child_process');
const path = require('path');
const config = require('./config');
const { nativeTheme } = require('electron');

/**
 * Updates the pgAdmin SQLite database to set the theme preference.
 * @param {string} theme - 'light', 'dark', or 'auto'
 * @returns {Promise<string>} - The resolved theme ('light' or 'dark')
 */
function setPgAdminTheme(theme) {
    return new Promise((resolve, reject) => {
        // Resolve 'auto' to explicit value
        let targetTheme = theme;
        if (theme === 'auto') {
            targetTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
        }

        // Validate
        if (targetTheme !== 'dark' && targetTheme !== 'light') {
            targetTheme = 'light'; // Fallback
        }

        const dbPath = path.join(config.PATHS.DATA, 'pgadmin', 'pgadmin.db');
        
        // Use bundled Python to update SQLite to avoid dependency on system sqlite3
        const pythonScript = `
import sqlite3
import sys

try:
    db_path = sys.argv[1]
    theme_value = sys.argv[2]
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    # pid 154 is 'theme' in preferences table, uid 1 is default user
    cursor.execute("INSERT INTO user_preferences (pid, uid, value) VALUES (154, 1, ?) ON CONFLICT(pid, uid) DO UPDATE SET value=excluded.value", (theme_value,))
    conn.commit()
    conn.close()
    print("Theme updated successfully")
except Exception as e:
    print(str(e), file=sys.stderr)
    sys.exit(1)
`;

        console.log(`[pgAdmin] Setting theme to ${targetTheme} in ${dbPath}`);

        execFile(config.PATHS.PYTHON_BIN, ['-c', pythonScript, dbPath, targetTheme], (error, stdout, stderr) => {
            if (error) {
                console.error("[pgAdmin] Failed to set theme:", stderr || error);
                // Don't reject, just log, so app doesn't crash
                resolve(targetTheme); 
            } else {
                resolve(targetTheme);
            }
        });
    });
}

module.exports = {
    setPgAdminTheme
};
