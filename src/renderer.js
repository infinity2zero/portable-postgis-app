// DOM Elements
if (!window.api) {
    console.error("preload.js did not load correctly! API is missing.");
    document.body.innerHTML = '<h1 style="color:red; padding:20px;">Fatal Error: preload.js failed to load. Check console.</h1>';
}

const views = {
    dashboard: document.getElementById('dashboard-view'),
    pgadmin: document.getElementById('pgadmin-view'),
    settings: document.getElementById('settings-view'),
    onboarding: document.getElementById('onboarding-view')
};

const navItems = {
    dashboard: document.getElementById('nav-dashboard'),
    pgadmin: document.getElementById('nav-pgadmin'),
    settings: document.getElementById('nav-settings')
};

const floatingNav = document.getElementById('floating-nav');
const carouselSlides = document.querySelectorAll('.carousel-slide');
const btnOnboardingPrev = document.getElementById('btn-onboarding-prev');
const btnOnboardingNext = document.getElementById('btn-onboarding-next');

const pgAdminWebview = document.getElementById('pgadmin-webview');
const btnWipeData = document.getElementById('btn-wipe-data');
const logsContainer = document.getElementById('logs');
const postgresStatus = document.getElementById('postgres-status');
const pgadminStatus = document.getElementById('pgadmin-status');
const extensionsContainerDashboard = document.getElementById('extensions-container');
const extensionsContainerSettings = document.getElementById('settings-extensions-list');
const btnRefreshExtensions = document.getElementById('btn-refresh-extensions');
const btnSetPass = document.getElementById('btn-set-pass');
const settingDbPass = document.getElementById('setting-db-pass');
const btnShowGuide = document.getElementById('btn-show-guide');
const btnFinishOnboarding = document.getElementById('btn-finish-onboarding');

// Connection Details Elements
const btnGotoConnection = document.getElementById('btn-goto-connection');
const connHost = document.getElementById('conn-host');
const connPort = document.getElementById('conn-port');
const connUser = document.getElementById('conn-user');
const connPass = document.getElementById('conn-pass');
const connDb = document.getElementById('conn-db');
const btnCopyConnString = document.getElementById('btn-copy-conn-string');
const btnCopyConnJson = document.getElementById('btn-copy-conn-json');

// Status & Version Elements
const statusPgPort = document.getElementById('status-pg-port');
const statusPgUrl = document.getElementById('status-pg-url');
const statusPgaPort = document.getElementById('status-pga-port');
const statusPgaUrl = document.getElementById('status-pga-url');
const verPostgres = document.getElementById('ver-postgres');
const verPostgis = document.getElementById('ver-postgis');
const verPgadmin = document.getElementById('ver-pgadmin');

// Settings Elements
const themeToggles = document.querySelectorAll('.theme-btn');
const settingPgPort = document.getElementById('setting-pg-port');
const settingPgAdminPort = document.getElementById('setting-pgadmin-port');
const btnSavePorts = document.getElementById('btn-save-ports');

// Service Control Elements
const btnControlPostgres = document.getElementById('btn-control-postgres');
const btnControlPgAdmin = document.getElementById('btn-control-pgadmin');
const inputServicePgPort = document.getElementById('service-pg-port');
const inputServicePgAdminPort = document.getElementById('service-pgadmin-port');
const postgresError = document.getElementById('postgres-error');
const pgadminError = document.getElementById('pgadmin-error');

// State
let pgAdminUrl = null;
let currentSettings = null;
let isPostgresRunning = false;
let isPgAdminRunning = false;

// --- CRITICAL: Initialize Logging First ---
function addLog(message) {
    if (!logsContainer) return;
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    
    const time = document.createElement('span');
    time.className = 'log-time';
    time.innerText = new Date().toLocaleTimeString();
    
    const msg = document.createElement('span');
    msg.innerText = message;
    
    entry.appendChild(time);
    entry.appendChild(msg);
    
    logsContainer.appendChild(entry);
    logsContainer.scrollTop = logsContainer.scrollHeight;
}

if (window.api) {
    window.api.onLog((message) => {
        console.log(message);
        addLog(message);
    });
}
// ------------------------------------------

// --- Initialization ---
async function init() {
    try {
        // Platform Detection for UI
        if (window.api.platform) {
            document.body.classList.add(`platform-${window.api.platform}`);
        }

        // Load Settings
        if (window.api.getSettings) {
            currentSettings = await window.api.getSettings();
            console.log("Settings loaded:", currentSettings);
            
            // Apply Theme
            applyTheme(currentSettings.theme || 'auto');
            
            // Populate Port Settings
            if (settingPgPort) settingPgPort.value = currentSettings.ports?.postgres || 5432;
            if (settingPgAdminPort) settingPgAdminPort.value = currentSettings.ports?.pgadmin || 5050;

            // Populate Service Control Inputs (Dashboard)
            if (inputServicePgPort) inputServicePgPort.value = currentSettings.ports?.postgres || 5432;
            if (inputServicePgAdminPort) inputServicePgAdminPort.value = currentSettings.ports?.pgadmin || 5050;

            updateAllStatusUI();
        }

        // Check First Run / Onboarding
        const hasSeenOnboarding = localStorage.getItem('hasSeenOnboarding');
        if (!hasSeenOnboarding) {
            console.log("First launch detected. queuing onboarding...");
            // Use a slightly longer delay to ensure DOM is fully painted and transitions work
            setTimeout(() => {
                console.log("Showing onboarding view...");
                switchView('onboarding');
            }, 500);
        }

        // Signal UI Ready
        if (window.api.signalUiReady) {
            console.log("Signaling UI Ready...");
            window.api.signalUiReady();
        }

        // Auto-start disabled by user request to prevent loops
        // await attemptAutoStart();

        // Initial Extensions Check
        setTimeout(updateExtensionsUI, 2000);

    } catch (e) {
        console.error("Initialization failed:", e);
        addLog("Error initializing application: " + e.message);
    }
}

// --- Theme Logic ---
function applyTheme(theme) {
    // Update local state
    if (currentSettings) currentSettings.theme = theme;
    
    updateThemeUI(theme);
}

function updateThemeUI(theme) {
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = theme === 'dark' || (theme === 'auto' && systemDark);
    
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    
    // Update buttons state
    themeToggles.forEach(btn => {
        const btnTheme = btn.dataset.theme;
        if (btnTheme === theme) {
            btn.classList.add('btn--primary');
            btn.classList.remove('btn--secondary');
        } else {
            btn.classList.add('btn--secondary');
            btn.classList.remove('btn--primary');
        }
    });

    // Update pgAdmin theme if running
    // updatePgAdminTheme(isDark); // Manual trigger required to avoid race conditions
}

function updatePgAdminTheme(isDark) {
    // Native theme sync is now handled by main process updating pgAdmin DB.
    // We no longer inject CSS hacks.
    console.log("Theme updated. pgAdmin will reflect this on next reload.");
    
    // Reload pgAdmin webview to pick up the new theme from DB
    if (isPgAdminRunning && pgAdminWebview) {
        console.log("Reloading pgAdmin webview to apply theme change...");
        pgAdminWebview.reload();
    }
}

function updateConnectionDetailsUI() {
    // Only show if Postgres is running
    const container = document.getElementById('settings-connection-section');
    if (!container) return;

    if (!isPostgresRunning) {
        container.style.opacity = '0.5';
        container.style.pointerEvents = 'none';
        if (connHost) connHost.innerText = '-';
        if (connPort) connPort.innerText = '-';
        if (connUser) connUser.innerText = '-';
        if (connPass) connPass.innerText = '-';
        if (connDb) connDb.innerText = '-';
        
        // Disable header icon
        if (btnGotoConnection) {
            btnGotoConnection.style.opacity = '0.3';
            btnGotoConnection.style.cursor = 'not-allowed';
            btnGotoConnection.title = "Start PostgreSQL to view connection details";
        }
    } else {
        container.style.opacity = '1';
        container.style.pointerEvents = 'auto';
        
        // Enable header icon
        if (btnGotoConnection) {
            btnGotoConnection.style.opacity = '1';
            btnGotoConnection.style.cursor = 'pointer';
            btnGotoConnection.title = "Connection Details";
        }

        if (connHost) connHost.innerText = 'localhost';
        
        // Use the actual running port, not just settings
        // If we have a running port input, use that, otherwise fallback
        const runningPort = inputServicePgPort ? inputServicePgPort.value : (currentSettings?.ports?.postgres || 5432);
        if (connPort) connPort.innerText = runningPort;
        
        if (connUser) connUser.innerText = 'postgres';
        
        // Check if password is set in settings
        // TODO: This should ideally come from a secure store or the actual config if possible
        // For now, we rely on what the user saved in settings, defaulting to 'postgres' if not set
        // NOTE: The user mentioned "if user sets it should come". 
        // We have 'setting-db-pass' input. Let's see if we store it.
        // We don't seem to store the password in `currentSettings` explicitly in the previous code?
        // Wait, `currentSettings` is loaded from `SettingsStore`.
        // If the user sets a password via "Set Password" button, we should store it.
        // Let's assume we might have it in `currentSettings.dbPassword` or similar if implemented.
        // If not, we default to 'postgres' or '(none)'?
        // The previous code had `btnSetPass` which just alerted "coming soon".
        // So for now, we'll default to 'postgres' (the default for the portable app) or '********'
        // User asked: "Let's say if user sets any password that should also come"
        // Since the set password feature isn't fully implemented (it alerts), we can't show a *changed* password yet.
        // But we can show the default 'postgres'.
        if (connPass) connPass.innerText = 'postgres'; 
        
        if (connDb) connDb.innerText = 'postgres';
    }
}

function updateStatusAndVersionsUI() {
    // PostgreSQL Status
    if (isPostgresRunning) {
        const port = inputServicePgPort ? inputServicePgPort.value : (currentSettings?.ports?.postgres || 5432);
        if (statusPgPort) statusPgPort.innerText = port;
        if (statusPgUrl) statusPgUrl.innerText = `localhost:${port}`;
    } else {
        if (statusPgPort) statusPgPort.innerText = 'Stopped';
        if (statusPgUrl) statusPgUrl.innerText = '-';
    }

    // pgAdmin Status
    if (isPgAdminRunning) {
        const port = inputServicePgAdminPort ? inputServicePgAdminPort.value : (currentSettings?.ports?.pgadmin || 5050);
        if (statusPgaPort) statusPgaPort.innerText = port;
        if (statusPgaUrl) statusPgaUrl.innerText = `http://127.0.0.1:${port}`;
    } else {
        if (statusPgaPort) statusPgaPort.innerText = 'Stopped';
        if (statusPgaUrl) statusPgaUrl.innerText = '-';
    }

    // Versions (Static for now, but could be fetched dynamically)
    // Based on the portable-postgis-app context, we can hardcode or fetch if API exists
    // For now, placeholders or simple text
    if (verPostgres) verPostgres.innerText = "17.2 (Stable)";
    if (verPostgis) verPostgis.innerText = "3.5.0";
    if (verPgadmin) verPgadmin.innerText = "8.14";
}

function updateAllStatusUI() {
    updateConnectionDetailsUI();
    updateStatusAndVersionsUI();
}

// Theme Listeners
themeToggles.forEach(btn => {
    btn.addEventListener('click', async () => {
        const newTheme = btn.dataset.theme;
        applyTheme(newTheme);
        // Save immediately
        if (window.api.saveSettings) {
            await window.api.saveSettings({ theme: newTheme });
        }
        // Reload pgAdmin to apply changes (after DB sync)
        updatePgAdminTheme();
    });
});

// System Theme Change Listener
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
    if (currentSettings?.theme === 'auto') {
        updateThemeUI('auto');
        // Sync with DB and reload
        if (window.api.saveSettings) {
            await window.api.saveSettings({ theme: 'auto' });
            updatePgAdminTheme();
        }
    }
});

// --- Port Settings Logic ---
if (btnSavePorts) {
    btnSavePorts.addEventListener('click', async () => {
        const newPgPort = parseInt(settingPgPort.value, 10);
        const newPgAdminPort = parseInt(settingPgAdminPort.value, 10);

        if (isNaN(newPgPort) || isNaN(newPgAdminPort)) {
            alert("Please enter valid port numbers.");
            return;
        }

        if (confirm("Port changes require an application restart. Save and restart now?")) {
            await window.api.saveSettings({
                ports: {
                    postgres: newPgPort,
                    pgadmin: newPgAdminPort
                }
            });
            
            // Relaunch
            if (window.api.relaunchApp) {
                window.api.relaunchApp();
            } else {
                alert("Please restart the application manually.");
            }
        }
    });
}

// --- Service Control Logic ---

function showError(element, message) {
    if (element) {
        element.innerText = message;
        element.style.display = 'block';
    }
}

function clearError(element) {
    if (element) {
        element.style.display = 'none';
        element.innerText = '';
    }
}

function updatePostgresUI(statusText, badgeClass) {
    if (postgresStatus) {
        postgresStatus.innerText = statusText;
        postgresStatus.className = `status-badge ${badgeClass}`;
    }
}

function updatePgAdminUI(statusText, badgeClass) {
    if (pgadminStatus) {
        pgadminStatus.innerText = statusText;
        pgadminStatus.className = `status-badge ${badgeClass}`;
    }
}

async function togglePostgres(forceStart = false) {
    if (isPostgresRunning && !forceStart) {
        // Stop Logic
        btnControlPostgres.disabled = true;
        btnControlPostgres.innerText = "Stopping...";
        
        const res = await window.api.stopPostgres();
        if (res.success) {
            isPostgresRunning = false;
            updatePostgresUI('Stopped', 'status-stopped');
            btnControlPostgres.innerText = "Start";
            btnControlPostgres.disabled = false;
            inputServicePgPort.disabled = false;
            
            updateAllStatusUI();

            // Also stop pgAdmin if running
            if (isPgAdminRunning) {
                await togglePgAdmin();
            }
            btnControlPgAdmin.disabled = true; // Disable pgAdmin start
            btnControlPgAdmin.title = "Start PostgreSQL first";
        } else {
            alert("Failed to stop PostgreSQL: " + res.error);
            btnControlPostgres.innerText = "Stop"; // Revert
            btnControlPostgres.disabled = false;
        }
    } else {
        // Start Logic
        const port = parseInt(inputServicePgPort.value, 10);
        if (isNaN(port)) {
            showError(postgresError, "Invalid port");
            return;
        }
        
        clearError(postgresError);
        btnControlPostgres.disabled = true;
        btnControlPostgres.innerText = "Checking...";
        
        // Check port first
        const isFree = await window.api.checkPort(port);
        if (!isFree) {
            showError(postgresError, `Port ${port} is in use.`);
            updatePostgresUI('Port Busy', 'status-error');
            btnControlPostgres.innerText = "Start";
            btnControlPostgres.disabled = false;
            return;
        }
        
        updatePostgresUI('Starting...', 'status-loading');
        btnControlPostgres.innerText = "Starting...";
        
        // Save port setting if changed
        if (currentSettings.ports?.postgres !== port) {
             await window.api.saveSettings({ ports: { ...currentSettings.ports, postgres: port } });
        }
        
        const res = await window.api.startPostgres(port);
        if (res.success) {
            isPostgresRunning = true;
            updatePostgresUI('Running', 'status-running');
            btnControlPostgres.innerText = "Stop";
            btnControlPostgres.disabled = false;
            inputServicePgPort.disabled = true;
            
            // Enable pgAdmin control
            btnControlPgAdmin.disabled = false;
            btnControlPgAdmin.title = "";

            // Refresh extensions now that DB is up
            updateExtensionsUI();
            updateAllStatusUI();
        } else {
            showError(postgresError, res.error);
            updatePostgresUI('Failed', 'status-error');
            btnControlPostgres.innerText = "Start";
            btnControlPostgres.disabled = false;
        }
    }
}

async function togglePgAdmin(forceStart = false) {
    if (isPgAdminRunning && !forceStart) {
        // Stop Logic
        btnControlPgAdmin.disabled = true;
        btnControlPgAdmin.innerText = "Stopping...";
        
        const res = await window.api.stopPgAdmin();
        if (res.success) {
            isPgAdminRunning = false;
            updatePgAdminUI('Stopped', 'status-stopped');
            btnControlPgAdmin.innerText = "Start";
            btnControlPgAdmin.disabled = false;
            inputServicePgAdminPort.disabled = false;
            updateAllStatusUI();
        } else {
            alert("Failed to stop pgAdmin: " + res.error);
            btnControlPgAdmin.innerText = "Stop";
            btnControlPgAdmin.disabled = false;
        }
    } else {
        // Start Logic
        const port = parseInt(inputServicePgAdminPort.value, 10);
        const pgPort = parseInt(inputServicePgPort.value, 10);
        
        if (isNaN(port)) {
            showError(pgadminError, "Invalid port");
            return;
        }
        
        clearError(pgadminError);
        btnControlPgAdmin.disabled = true;
        btnControlPgAdmin.innerText = "Checking...";
        
        const isFree = await window.api.checkPort(port);
        if (!isFree) {
            showError(pgadminError, `Port ${port} is in use.`);
            updatePgAdminUI('Port Busy', 'status-error');
            btnControlPgAdmin.innerText = "Start";
            btnControlPgAdmin.disabled = false;
            return;
        }
        
        updatePgAdminUI('Starting...', 'status-loading');
        btnControlPgAdmin.innerText = "Starting...";
        
        // Save port
        if (currentSettings.ports?.pgadmin !== port) {
             await window.api.saveSettings({ ports: { ...currentSettings.ports, pgadmin: port } });
        }
        
        const res = await window.api.startPgAdmin(pgPort, port);
        if (res.success) {
            // Note: pgAdmin readiness is also handled by 'pgadmin-ready' event
            isPgAdminRunning = true;
            updatePgAdminUI('Running', 'status-running');
            btnControlPgAdmin.innerText = "Stop";
            btnControlPgAdmin.disabled = false;
            inputServicePgAdminPort.disabled = true;
            updateAllStatusUI();
        } else {
            showError(pgadminError, res.error);
            updatePgAdminUI('Failed', 'status-error');
            btnControlPgAdmin.innerText = "Start";
            btnControlPgAdmin.disabled = false;
        }
    }
}

// Listeners
if (btnControlPostgres) {
    btnControlPostgres.addEventListener('click', () => togglePostgres());
}

if (btnControlPgAdmin) {
    btnControlPgAdmin.addEventListener('click', () => togglePgAdmin());
}

async function attemptAutoStart() {
    // 1. Fill inputs from settings
    if (currentSettings?.ports) {
        inputServicePgPort.value = currentSettings.ports.postgres || 5432;
        inputServicePgAdminPort.value = currentSettings.ports.pgadmin || 5050;
    }
    
    // 2. Try to start Postgres
    console.log("Attempting auto-start of PostgreSQL...");
    await togglePostgres(false);
    
    // 3. If Postgres started successfully, try pgAdmin
    if (isPostgresRunning) {
        console.log("PostgreSQL started. Attempting pgAdmin...");
        await togglePgAdmin(false);
    }
}

// --- Carousel / Onboarding Logic ---
let currentSlideIndex = 0;

function updateCarousel() {
    if (!carouselSlides || carouselSlides.length === 0) return;

    carouselSlides.forEach((slide, index) => {
        if (index === currentSlideIndex) {
            slide.classList.add('active');
        } else {
            slide.classList.remove('active');
        }
    });

    if (btnOnboardingPrev) {
        btnOnboardingPrev.disabled = currentSlideIndex === 0;
    }

    if (btnOnboardingNext) {
        if (currentSlideIndex === carouselSlides.length - 1) {
            btnOnboardingNext.innerText = "Get Started";
        } else {
            btnOnboardingNext.innerText = "Next";
        }
    }
}

function goToNextSlide() {
    if (!carouselSlides || carouselSlides.length === 0) return;
    if (currentSlideIndex < carouselSlides.length - 1) {
        currentSlideIndex += 1;
        updateCarousel();
    } else {
        finishOnboarding();
    }
}

function goToPreviousSlide() {
    if (!carouselSlides || carouselSlides.length === 0) return;
    if (currentSlideIndex > 0) {
        currentSlideIndex -= 1;
        updateCarousel();
    }
}

function startOnboarding() {
    currentSlideIndex = 0;
    updateCarousel();
    if (floatingNav) {
        floatingNav.style.display = 'none';
    }
}

function finishOnboarding() {
    localStorage.setItem('hasSeenOnboarding', 'true');
    switchView('dashboard');
}

if (btnOnboardingPrev) {
    btnOnboardingPrev.addEventListener('click', goToPreviousSlide);
}

if (btnOnboardingNext) {
    btnOnboardingNext.addEventListener('click', goToNextSlide);
}


// --- Navigation Logic ---
function switchView(viewName) {
    Object.values(views).forEach(el => {
        if (el) el.classList.remove('active');
    });
    
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    
    if (views[viewName]) {
        views[viewName].classList.add('active');
    }
    
    if (navItems[viewName]) {
        navItems[viewName].classList.add('active');
    }

    if (viewName === 'onboarding') {
        startOnboarding();
    }

    if (floatingNav) {
        if (viewName === 'onboarding') {
            floatingNav.style.display = 'none';
        } else {
            floatingNav.style.display = 'flex';
        }
    }
}

// Event Listeners for Navigation
if (navItems.dashboard) {
    navItems.dashboard.addEventListener('click', () => switchView('dashboard'));
}

if (navItems.pgadmin) {
    navItems.pgadmin.addEventListener('click', (e) => {
        if (navItems.pgadmin.classList.contains('disabled')) {
            e.preventDefault();
            return;
        }
        switchView('pgadmin');
        if (pgAdminUrl && pgAdminWebview.src === 'about:blank') {
            pgAdminWebview.src = pgAdminUrl;
        }
    });
}

if (navItems.settings) {
    navItems.settings.addEventListener('click', () => switchView('settings'));
}

// Gear Icon Navigation
const btnServicesSettings = document.getElementById('btn-services-settings');
if (btnServicesSettings) {
    btnServicesSettings.addEventListener('click', () => {
        switchView('settings');
        setTimeout(() => {
             document.getElementById('settings-ports-section').scrollIntoView({ behavior: 'smooth' });
        }, 100);
    });
}

const btnExtensionsSettings = document.getElementById('btn-extensions-settings');
if (btnExtensionsSettings) {
    btnExtensionsSettings.addEventListener('click', () => {
        switchView('settings');
        setTimeout(() => {
             document.getElementById('settings-extensions-section').scrollIntoView({ behavior: 'smooth' });
        }, 100);
    });
}

if (btnShowGuide) {
    btnShowGuide.addEventListener('click', () => {
        switchView('onboarding');
    });
}

if (btnFinishOnboarding) {
    btnFinishOnboarding.addEventListener('click', () => {
        finishOnboarding();
    });
}

// Password Setting
if (btnSetPass) {
    btnSetPass.addEventListener('click', () => {
        alert("Password changing functionality is coming soon!");
    });
}

// Wipe Data Logic
if (btnWipeData) {
    btnWipeData.addEventListener('click', async () => {
        if (confirm("WARNING: This will delete ALL your databases and tables permanently.\n\nAre you sure you want to proceed?")) {
            // Double confirmation
            if (confirm("FINAL WARNING: This action cannot be undone.\n\nClick OK to wipe all data and restart the application.")) {
                btnWipeData.disabled = true;
                btnWipeData.innerText = "Wiping Data...";
                addLog("Wiping data requested...");
                
                const result = await window.api.wipeData();
                if (!result.success) {
                    alert("Failed to wipe data: " + result.error);
                    btnWipeData.disabled = false;
                    btnWipeData.innerText = "Wipe All Data & Reset";
                }
            }
        }
    });
}

// Credits Link
const creditsLink = document.getElementById('credits-link');
if (creditsLink) {
    creditsLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (window.api && window.api.openExternal) {
            window.api.openExternal(creditsLink.href);
        }
    });
}

// pgAdmin Webview Styling
pgAdminWebview.addEventListener('dom-ready', () => {
    // Theme is now handled natively via database sync on startup/reload.
    // No need to inject anything here to avoid reload loops.
    console.log("pgAdmin webview loaded.");
});

window.api.onReady((url) => {
    // This might still be called if main.js emits 'ready' or 'pgadmin-ready'
    // But our new IPC start-pgadmin handles waiting. 
    // We'll keep this as a backup listener for updating state if needed.
    addLog(`pgAdmin Ready at ${url}`);
    pgAdminUrl = url;
    
    // Update UI if not already done by togglePgAdmin
    isPgAdminRunning = true;
    updatePgAdminUI('Running', 'status-running');
    btnControlPgAdmin.innerText = "Stop";
    btnControlPgAdmin.disabled = false;
    inputServicePgAdminPort.disabled = true;

    // Enable Database Tab
    if (navItems.pgadmin) {
        navItems.pgadmin.classList.remove('disabled');
        navItems.pgadmin.title = 'Database';
        navItems.pgadmin.style.opacity = '1';
        navItems.pgadmin.style.cursor = 'pointer';
        navItems.pgadmin.style.pointerEvents = 'auto';
    }

    // If user is already on pgAdmin view, load it
    if (views.pgadmin && views.pgadmin.classList.contains('active')) {
        pgAdminWebview.src = url;
    }
});

// Listener for pgAdmin specific ready event if distinct from 'ready'
if (window.api.onPgAdminReady) {
    window.api.onPgAdminReady((url) => {
        // Same logic as above
        addLog(`pgAdmin Ready at ${url}`);
        pgAdminUrl = url;

        // Update UI
        isPgAdminRunning = true;
        updatePgAdminUI('Running', 'status-running');
        btnControlPgAdmin.innerText = "Stop";
        btnControlPgAdmin.disabled = false;
        inputServicePgAdminPort.disabled = true;

        if (navItems.pgadmin) {
            navItems.pgadmin.classList.remove('disabled');
            navItems.pgadmin.title = 'Database';
            navItems.pgadmin.style.opacity = '1';
            navItems.pgadmin.style.cursor = 'pointer';
            navItems.pgadmin.style.pointerEvents = 'auto';
        }

        if (views.pgadmin && views.pgadmin.classList.contains('active')) {
            pgAdminWebview.src = url;
        }
    });
}

// Listener for Service Exit/Crash
if (window.api.onServiceExit) {
    window.api.onServiceExit(({ id, code }) => {
        console.log(`Service ${id} exited with code ${code}`);
        addLog(`Service [${id}] exited with code ${code}`);
        
        if (id === 'postgres') {
            isPostgresRunning = false;
            updatePostgresUI(code === 0 ? 'Stopped' : 'Crashed', code === 0 ? 'status-stopped' : 'status-error');
            btnControlPostgres.innerText = "Start";
            btnControlPostgres.disabled = false;
            inputServicePgPort.disabled = false;
            
            // If postgres crashes, pgadmin might still be running but useless
            // Or we force stop pgadmin?
            // For now, just disable pgadmin start button
            btnControlPgAdmin.disabled = true;
            btnControlPgAdmin.title = "Start PostgreSQL first";
        } else if (id === 'pgadmin') {
            isPgAdminRunning = false;
            updatePgAdminUI(code === 0 ? 'Stopped' : 'Crashed', code === 0 ? 'status-stopped' : 'status-error');
            btnControlPgAdmin.innerText = "Start";
            btnControlPgAdmin.disabled = false;
            inputServicePgAdminPort.disabled = false;
        }
    });
}

// Extension Management
const KNOWN_EXTENSIONS = [
    { name: 'postgis', label: 'PostGIS' },
    { name: 'pgrouting', label: 'pgRouting' },
    { name: 'postgis_topology', label: 'Topology' },
    { name: 'fuzzystrmatch', label: 'Fuzzy Match' }
];

async function updateExtensionsUI() {
    if (!window.api.checkExtensions) return;

    try {
        const installed = await window.api.checkExtensions();
        const installedMap = new Map(installed.map(e => [e.name, e.version]));
        
        // Clear containers
        if(extensionsContainerDashboard) extensionsContainerDashboard.innerHTML = '';
        if(extensionsContainerSettings) extensionsContainerSettings.innerHTML = '';
        
        KNOWN_EXTENSIONS.forEach(ext => {
            const isInstalled = installedMap.has(ext.name);
            const version = isInstalled ? installedMap.get(ext.name) : '';

            // --- Dashboard Chip ---
            const chip = document.createElement('span');
            chip.className = 'ext-tag';
            
            if (isInstalled) {
                chip.classList.add('installed');
                chip.style.backgroundColor = 'rgba(var(--color-success-rgb), 0.2)';
                chip.style.color = 'var(--color-success)';
                chip.style.border = '1px solid var(--color-success)';
                chip.innerHTML = `${ext.label}`;
            } else {
                chip.classList.add('not-installed');
                chip.style.backgroundColor = 'rgba(var(--color-text-secondary-rgb), 0.1)';
                chip.style.color = 'var(--color-text-secondary)';
                chip.style.border = '1px solid var(--color-border)';
                chip.innerText = ext.label;
            }
            
            chip.style.cursor = 'pointer';
            chip.style.padding = '4px 8px';
            chip.style.borderRadius = '0px'; // Sharp edges
            chip.style.fontSize = 'var(--font-size-sm)'; // Consistent size
            chip.title = isInstalled ? 'Click to disable' : 'Click to enable';
            
            chip.onclick = () => toggleExtension(ext, !isInstalled);
            
            if(extensionsContainerDashboard) extensionsContainerDashboard.appendChild(chip);

            // --- Settings List Item ---
            const item = document.createElement('div');
            item.style.display = 'flex';
            item.style.justifyContent = 'space-between';
            item.style.alignItems = 'center';
            item.style.padding = '12px';
            item.style.border = '1px solid var(--color-border)';
            item.style.backgroundColor = 'var(--color-surface)';
            item.style.marginBottom = '8px';

            item.innerHTML = `
                <div>
                    <div style="font-weight:bold;">${ext.label}</div>
                    <div style="font-size:0.85em; color:var(--color-text-secondary);">${isInstalled ? 'Installed v' + version : 'Not installed'}</div>
                </div>
            `;
            
            const toggleBtn = document.createElement('button');
            toggleBtn.className = isInstalled ? 'btn btn--danger btn--sm' : 'btn btn--primary btn--sm';
            toggleBtn.innerText = isInstalled ? 'Disable' : 'Enable';
            toggleBtn.onclick = () => toggleExtension(ext, !isInstalled);
            
            item.appendChild(toggleBtn);
            if(extensionsContainerSettings) extensionsContainerSettings.appendChild(item);
        });
    } catch (e) {
        console.error("Failed to update extensions:", e);
        const errHtml = '<span style="color:#ef4444">Error checking extensions</span>';
        if(extensionsContainerDashboard) extensionsContainerDashboard.innerHTML = errHtml;
        if(extensionsContainerSettings) extensionsContainerSettings.innerHTML = errHtml;
    }
}

async function toggleExtension(ext, shouldEnable) {
    if (!shouldEnable) {
        let confirmed = false;
        if (window.api.showConfirm) {
            confirmed = await window.api.showConfirm(`Disable extension ${ext.label}? This might break features relying on it.`);
        } else {
            confirmed = confirm(`Disable extension ${ext.label}? This might break features relying on it.`);
        }

        if (confirmed) {
             if (window.api.disableExtension) {
                 const res = await window.api.disableExtension(ext.name);
                 if (res.success) {
                     updateExtensionsUI();
                 } else {
                     alert('Failed: ' + res.error);
                 }
             } else {
                 alert("Disabling extensions is not supported in this version.");
             }
        }
    } else {
        let confirmed = false;
        if (window.api.showConfirm) {
            confirmed = await window.api.showConfirm(`Enable extension ${ext.label}?`);
        } else {
            confirmed = confirm(`Enable extension ${ext.label}?`);
        }

        if (confirmed) {
            const res = await window.api.enableExtension(ext.name);
            if (res.success) {
                updateExtensionsUI();
            } else {
                alert('Failed: ' + res.error);
                updateExtensionsUI();
            }
        }
    }
}

if (btnRefreshExtensions) {
    btnRefreshExtensions.onclick = updateExtensionsUI;
}

// Connection Details Logic
if (btnGotoConnection) {
        btnGotoConnection.addEventListener('click', () => {
            if (!isPostgresRunning) return; // Prevent click if disabled
            switchView('settings');
            setTimeout(() => {
                const section = document.getElementById('settings-connection-section');
                if (section) section.scrollIntoView({ behavior: 'smooth' });
            }, 100);
        });
    }

if (btnCopyConnString) {
    btnCopyConnString.addEventListener('click', () => {
        // Use the port from the input field if available (most accurate if user changed it), 
        // otherwise fall back to settings
        const portVal = inputServicePgPort ? inputServicePgPort.value : null;
        const port = portVal ? parseInt(portVal, 10) : (currentSettings?.ports?.postgres || 5432);
        
        // Default credentials for now
        const url = `postgresql://postgres:postgres@localhost:${port}/postgres`;
        navigator.clipboard.writeText(url);
        
        const originalText = btnCopyConnString.innerText;
        btnCopyConnString.innerText = "Copied!";
        setTimeout(() => btnCopyConnString.innerText = originalText, 2000);
    });
}

if (btnCopyConnJson) {
    btnCopyConnJson.addEventListener('click', () => {
        const portVal = inputServicePgPort ? inputServicePgPort.value : null;
        const port = portVal ? parseInt(portVal, 10) : (currentSettings?.ports?.postgres || 5432);

        const json = JSON.stringify({
            host: 'localhost',
            port: port,
            user: 'postgres',
            password: 'postgres',
            database: 'postgres'
        }, null, 2);
        navigator.clipboard.writeText(json);
        
        const originalText = btnCopyConnJson.innerText;
        btnCopyConnJson.innerText = "Copied!";
        setTimeout(() => btnCopyConnJson.innerText = originalText, 2000);
    });
}

// Start Init
init();
