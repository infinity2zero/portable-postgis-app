# Portable PostGIS App

![Portable PostGIS Demo](src/assets/portablepostgres-rec.gif)

A self-contained, portable application bundling PostgreSQL and PostGIS with a built-in database browser. Run a spatial database environment without complex installation or system-level dependencies.

## Default Connection Details

Use these details to connect to the database programmatically or via external tools:

| Parameter | Value |
|-----------|-------|
| **Host** | `localhost` |
| **Port** | `5432` |
| **User** | `postgres` |
| **Password** | `postgres` |
| **Database** | `postgres` |

## Features

- **Portable PostgreSQL**: Runs a local instance of PostgreSQL with PostGIS extensions pre-installed.
- **Built-in database browser**: Query editor, schema explorer, ER diagram, and table import/export wizards (no pgAdmin required).
- **Zero Installation**: No system services or registry changes required.
- **Cross-Platform**: Windows, macOS, and Linux (Unix).
- **User-Friendly Dashboard**: Manage services, ports, and extensions from a simple UI.

## Getting Started

### Download

Download the latest version for your operating system from the [Releases Page](https://github.com/infinity2zero/portable-postgis-app/releases):

- **Windows**: `.exe` installer or portable zip
- **macOS**: `.dmg` or `.zip`
- **Linux**: AppImage or archive (see [Building for Linux](#building-for-linux))

### Installation

1. Download the latest release for your operating system.
2. Extract the archive (if zipped).
3. Run the application:
   - **Windows**: `Portable PostGIS.exe`
   - **macOS**: `Portable PostGIS.app`
   - **Linux**: Run the AppImage or extracted executable.

### macOS Troubleshooting ("App is damaged")

If you see an error saying **"Portable PostGIS.app is damaged and can't be opened. You should move it to the Trash"** when trying to launch on macOS, this is because the app is not code-signed with an Apple Developer Certificate.

To fix this, you need to remove the quarantine attribute from the app. Open your **Terminal** and run the following command:

```bash
xattr -cr /Applications/Portable\ PostGIS.app
```
*(Replace `/Applications/Portable\ PostGIS.app` with the actual path to where you placed the app)*

Alternatively, if you haven't moved it to Applications yet and it's in your Downloads folder:

```bash
xattr -cr ~/Downloads/Portable\ PostGIS.app
```

### Usage

1. **Dashboard**: On launch, the dashboard shows PostgreSQL status.
2. **Start PostgreSQL**: Click "Start" next to PostgreSQL.
3. **Database tab**: Switch to the **Database** tab for the built-in browser (schema tree, query editor, ER diagram, import/export). User: `postgres`, Password: `postgres`.
4. **Settings**: Configure port (default 5432) and appearance.

## Development


### Prerequisites

- Node.js (v16 or higher)
- npm or yarn

### Setup

1.  Clone the repository:
    ```bash
    git clone https://github.com/infinity2zero/portable-postgis-app.git
    cd portable-postgis-app
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3. **Resource setup**: The app expects PostgreSQL (and optionally Python) in `bin/<platform>/`. Run the setup script or place binaries manually:
   - `bin/win/postgres/`, `bin/win/python/` (Windows)
   - `bin/mac/postgres/`, `bin/mac/python/` (macOS)

### Running Locally

The UI is an Angular app in `renderer/`. Build it once so Electron loads the new interface:

```bash
cd renderer && npm install && npm run build && cd ..
npm start
```

Or from the repo root after renderer is built: `npm start`. If `dist/renderer` is missing, the app falls back to the legacy renderer in `src/`.

### Development (Angular live reload)

To have Angular changes reflect in Electron without rebuilding each time, run:

```bash
npm run dev
```

This starts the Angular dev server (`ng serve`) and then launches Electron loading `http://localhost:4200`. Edit files in `renderer/src/` and the app will hot-reload. Use Ctrl+C to stop both.

## Building

### Windows

1. Ensure you have the Windows binaries in `bin/win/` (or run `node scripts/setup-resources.js --target=win`).
2. Run:

```bash
npm run build:win
```

This produces the installer and portable zip in `dist/`.

### macOS

```bash
npm run build:mac
```

Generates `.dmg` and `.zip` in `dist/`.

### Building for Linux

To build for Linux (AppImage or other formats):

1. Build the Angular renderer: `npm run build:renderer`
2. Ensure `bin/linux/` exists (CI creates a placeholder; for full functionality you may need to add PostgreSQL/Python binaries for Linux).
3. Run:

```bash
electron-builder --linux
```

Outputs will be in `dist/` (e.g. AppImage). Linux builds are also produced by [GitHub Actions](.github/workflows/build.yml) on push/tag.

### Configuration

Build configuration is in `package.json` under the `build` key. The app bundles the `bin` and `data` directories for the target OS.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md) before opening a pull request or issue.

## Credits

- **Author**: [infinity2zero](https://github.com/infinity2zero)
- **PostgreSQL**: https://www.postgresql.org/
- **PostGIS**: https://postgis.net/
