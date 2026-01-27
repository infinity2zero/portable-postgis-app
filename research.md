# Research & Enhancement Plan

## 1. Pending Enhancements & Features

Based on current progress and requirements, the following features are planned for implementation:

### 1.1 Automated Extension Management
*   **Goal**: One-click enable/disable for PostGIS, pgRouting, etc.
*   **Status**: Backend logic exists; UI needs verification and smoothing.

### 1.2 Configuration & Security (Settings)
*   **Goal**: Allow users to change ports (5432/5050) and manage database passwords.
*   **Implementation**: New "Settings" modal/tab in the dashboard.
    *   **Port Management**: Text inputs for Postgres and pgAdmin ports (requires restart).
    *   **Password Management**: "Set/Change Password" button for the `postgres` user.

### 1.3 First-Run Wizard
*   **Goal**: Secure onboarding for new users.
*   **Flow**:
    1.  Detect fresh install (missing `data/postgres`).
    2.  Show "Welcome" modal.
    3.  Prompt: "Set a secure password for the database administrator?" (Optional but recommended).
    4.  Initialize DB with this password (using `pg_ctl initdb --auth-host=md5` or `ALTER USER` after startup).

### 1.4 Native & Consistent UI
*   **Goal**: Unify the look of the Dashboard and pgAdmin.
*   **Actions**:
    *   **Unified Font**: Enforce a consistent system font stack (San Francisco/Segoe UI) across both.
    *   **Compact Styling**: Reduce padding/margins in the Dashboard to match pgAdmin's density.
    *   **Bottom Navigation Bar**: A persistent toolbar visible in **both** the Dashboard and pgAdmin views.
        *   *Icons*: Dashboard (Home), pgAdmin (Database), Settings (Gear).
        *   *Behavior*: Acts as the primary navigation controller, allowing instant switching between views.

---

## 2. Design & Architecture

### 2.1 Navigation Flow (Bottom Bar)

```mermaid
graph TD
    A[App Launch] --> B{First Run?}
    B -- Yes --> C[First-Run Wizard]
    B -- No --> D[Dashboard (Home)]
    C --> D

    subgraph "Main Window Layout"
        D -- "Switch View" --> E[pgAdmin View (Webview/Iframe)]
        E -- "Switch View" --> D
        
        D -- "Open Modal" --> F[Settings Modal]
        E -- "Open Modal" --> F
        
        G[Bottom Toolbar] -.-> D
        G -.-> E
        G -.-> F
    end
```

### 2.2 UI Layout Mockup

**Dashboard View:**
```
+-------------------------------------------------------+
|  Portable PostGIS                              [ - □ x ]|
+-------------------------------------------------------+
|  [ Status: RUNNING ]   [ Port: 5432 ]                 |
|                                                       |
|  +-------------------+   +-----------------------+    |
|  |  Service Status   |   |  Quick Actions        |    |
|  |  Postgres: OK     |   |  [ Restart Server ]   |    |
|  |  pgAdmin:  OK     |   |  [ Open SQL Shell ]   |    |
|  +-------------------+   +-----------------------+    |
|                                                       |
|  +--------------------------------------------------+ |
|  |  Extension Manager                               | |
|  |  [x] PostGIS       [x] pgRouting                 | |
|  |  [ ] Topology      [ ] FuzzyMatch                | |
|  +--------------------------------------------------+ |
|                                                       |
+-------------------------------------------------------+
|  [Home]      [Database (pgAdmin)]      [Settings]     |  <-- Bottom Bar
+-------------------------------------------------------+
```

**pgAdmin View:**
```
+-------------------------------------------------------+
|  Portable PostGIS                              [ - □ x ]|
+-------------------------------------------------------+
|                                                       |
|  ( pgAdmin 4 UI loaded here via Webview/IFrame )      |
|  ( Custom CSS injected to match Dark Theme )          |
|                                                       |
|                                                       |
|                                                       |
+-------------------------------------------------------+
|  [Home]      [Database (pgAdmin)]      [Settings]     |  <-- Bottom Bar
+-------------------------------------------------------+
```

---

## 3. Implementation Plan

### Phase 1: Core UI & Navigation (Completed)
1.  **Refactor `index.html`**:
    *   Implement the **Bottom Navigation Bar**. (Done)
    *   Create a "View Switcher" mechanism. (Done)
    *   Load pgAdmin in a `<webview>`. (Done)

2.  **Style Unification** (Completed):
    *   Update `renderer.js` to inject CSS into the pgAdmin view. (Done)
    *   Compact the Dashboard layout. (Done)

### Phase 2: Settings & Configuration (In Progress)
1.  **Settings UI** (Completed):
    *   Create the Settings Modal. (Done)
    *   Add "Wipe Data" functionality with double confirmation. (Done)
    *   Add form fields for Ports and Password (UI only).
2.  **Backend Logic (`ipcMain`)**:
    *   Handle "Wipe Data": Implemented and verified.
    *   Handle "Save Settings": Update `config.json` (need to implement persistence).
    *   Handle "Set Password": Run `ALTER USER postgres ...` command.

### Phase 3: First-Run Experience
1.  **Detection**: Check for `first-run` flag or absence of data.
2.  **Wizard UI**: Simple 2-step modal (Welcome -> Password).
3.  **Initialization**: Run `initdb` with appropriate flags based on user choice.

---

## 4. Technical Details for Node.js Connection

For users wanting to connect an external Node.js app:

*   **Host**: `localhost`
*   **Port**: `5432` (default)
*   **User**: `postgres`
*   **Password**: *Empty* (default) or *User Set* (via new Settings).
*   **Database**: `postgres`

**Code Example:**
```javascript
const { Client } = require('pg');
const client = new Client({
  user: 'postgres',
  host: 'localhost',
  database: 'postgres',
  password: 'your_password_here', // Leave empty if default
  port: 5432,
});
await client.connect();
const res = await client.query('SELECT $1::text as message', ['Hello World!']);
console.log(res.rows[0].message);
await client.end();
```
