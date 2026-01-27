# Portable PostGIS + PostgreSQL + pgAdmin Electron App

## Goal
Build a **cross-platform (Windows/macOS) desktop application** that bundles:

- **PostgreSQL + PostGIS**
- **Portable Python runtime**
- **pgAdmin**

The app should:

- Run **without admin rights**
- Provide the **full pgAdmin UI**
- Be fully **portable**, with all binaries included

---

## 1. Core Functionality

1. Electron app acts as a **desktop wrapper** for Postgres + PostGIS + pgAdmin.
2. Starts **PostgreSQL/PostGIS server** from bundled binaries.
3. Starts **pgAdmin Python backend** using bundled Python runtime.
4. Opens **pgAdmin frontend (React UI)** in an Electron BrowserWindow (`http://localhost:5050`).
5. Stops all child processes when the app closes.
6. Stores **database files and pgAdmin configs** in a **user-writable folder** (`data/`).
7. Supports **PostGIS spatial features**.
8. Fully **portable**, no admin rights required.

---

## 2. Technical Requirements

**Electron (Node.js) Main Process**

- Launch Postgres/PostGIS using `child_process.spawn`.
- Launch Python runtime to run pgAdmin backend.
- Monitor stdout/stderr of all child processes.
- Provide start/stop controls via Electron menu or UI.

**Renderer Process (BrowserWindow / WebView)**

- Loads `http://localhost:5050` served by pgAdmin backend.
- Displays full pgAdmin UI (tables, dashboards, query tool, PostGIS maps).
- Optional: overlay basic Electron menu for starting/stopping DB.

**PostgreSQL/PostGIS**

- Windows: bundle binaries + **VC++ runtime DLLs** (`vcruntime140.dll`, `msvcp140.dll`) in the same folder.
- macOS: bundle binaries in `bin/mac/postgres/`.
- Data directory: `data/postgres/`.

**Python / pgAdmin**

- Include **portable Python runtime** (`bin/win/python/`, `bin/mac/python/`).
- Include **pgAdmin 4 source code + dependencies** (`bin/win/pgadmin4/`, `bin/mac/pgadmin4/`).
- Configure pgAdmin backend to use `data/pgadmin/` as data directory.

---

## 3. Folder Structure (Everything in One Place)

portable-postgis-app/
├─ package.json
├─ tauri.conf.json (optional if porting to Tauri)
├─ src/                  # Electron renderer 
├─ src-main/             # Electron main process (Node.js)
├─ bin/
│   ├─ win/
│   │   ├─ postgres/     # Windows Postgres/PostGIS binaries
│   │   ├─ python/       # Windows Python runtime
│   │   └─ pgadmin4/     # pgAdmin source + Python deps
│   └─ mac/
│       ├─ postgres/     # macOS Postgres/PostGIS binaries
│       ├─ python/       # macOS Python runtime
│       └─ pgadmin4/     # pgAdmin source + Python deps
├─ data/                  # user-writable DB & pgAdmin storage
│   ├─ postgres/
│   └─ pgadmin/
└─ scripts/               # Optional start/stop scripts


---

## 4. Process Flow

1. **App Launch**
   - Main process starts Postgres/PostGIS and pgAdmin backend.
   - Renderer process opens pgAdmin UI in BrowserWindow.

2. **User Interaction**
   - Users interact with pgAdmin frontend.
   - Query execution, table browsing, and PostGIS features fully functional.

3. **App Shutdown**
   - Main process gracefully stops Postgres/PostGIS and Python backend.
   - All data is saved in `data/` folder.

---

## 5. Cross-Platform Packaging

- Use **Electron-builder**:
  - Include `bin/` folder with binaries and Python runtime.
  - Include `data/` folder as writable at first run.
  - Include VC++ DLLs for Windows portability.
- Output: **single-folder app or installer per OS**.

---

## 6. Optional / Nice-to-Have Features

- Electron toolbar/menu: start/stop DB, open logs, reset DB.
- Auto-open pgAdmin on app launch.
- Detect if Postgres is already running and attach.
- Bundle example PostGIS database for testing.
- Logs from Postgres/pgAdmin visible inside the app.

---

## 7. Key Notes

- **Windows:** include VC++ redistributables DLLs (`vcruntime140.dll`, `msvcp140.dll`) for portability.
- **Python:** use portable / embeddable version with all pgAdmin dependencies pre-installed.
- **Data storage:** keep DB and pgAdmin data in `data/` folder; avoid system folders.
- **Process management:** Node.js handles start/stop, logs, and errors.
- **Portability:** works without admin rights on Windows/macOS.

---

## 8. Deliverables

- Fully functional **Electron app folder** ready for Windows and macOS.
- Bundled **Postgres/PostGIS, Python, pgAdmin source**.
- Scripts or Node.js commands to start/stop services.
- Minimal documentation for updating binaries or dependencies.

---

## 9. References

- [pgAdmin 4 source](https://www.pgadmin.org/download/pgadmin-4-source/)
- [PostgreSQL downloads](https://www.postgresql.org/download/)
- [PostGIS downloads](https://postgis.net/install/)
- [Electron documentation](https://www.electronjs.org/docs)
- [Portable Python on Windows](https://docs.python.org/3/using/windows.html#embedded-distribution)

---

## 10. Enhancements & Roadmap

### 10.1. Automated Extension Management (PostGIS / pgRouting)
**Use Case**: Users currently have to manually copy DLLs and run SQL commands to enable PostGIS.
**Benefit**:
- **True Portability**: Extensions are bundled and configured out-of-the-box.
- **User Experience**: "It just works" without complex installation steps.
- **Consistency**: Ensures the correct extension versions match the Postgres binary.

### 10.2. Dedicated Dashboard UI
**Use Case**: A central hub before launching pgAdmin, displaying server status, logs, and quick actions.
**Benefit**:
- **Visibility**: Users can see if the server is starting, running, or failed.
- **Control**: Start/Stop/Restart buttons for the database service.
- **Extensibility**: A place to add future tools (e.g., "Import Shapefile", "Reset Database").

### 10.3. Configuration Management (config.json)
**Use Case**: Users on shared machines might have port 5432 or 5050 already in use.
**Benefit**:
- **Flexibility**: Allow changing ports via a simple JSON file or UI settings without recompiling.
- **Conflict Resolution**: Gracefully handle port clashes by auto-detecting or prompting the user.

### 10.4. First-Run Wizard
**Use Case**: When the app is opened for the first time.
**Benefit**:
- **Security**: Prompt to set a secure password for the `postgres` user.
- **Onboarding**: Option to load sample spatial data or restore a backup immediately.

### 10.5. Native Menu Integration
**Use Case**: Standard OS menu bar (File, View, Help).
**Benefit**:
- **Native Feel**: familiar keyboard shortcuts (Cmd+Q, Cmd+R).
- **Accessibility**: Quick access to logs, documentation, and "About" info.

