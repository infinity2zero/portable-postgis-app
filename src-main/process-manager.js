const { spawn } = require('child_process');
const config = require('./config');
const EventEmitter = require('events');

class ProcessManager extends EventEmitter {
    constructor() {
        super();
        this.processes = {};
    }

    /**
     * Start a process
     * @param {string} id - Unique ID for the process (e.g., 'postgres', 'pgadmin')
     * @param {string} command - Path to executable
     * @param {string[]} args - Arguments
     * @param {object} options - Spawn options (env, cwd, etc.)
     * @param {function} onLog - Callback for stdout/stderr
     */
    start(id, command, args, options = {}, onLog = console.log) {
        if (this.processes[id]) {
            onLog(`[${id}] Process already running.`);
            return;
        }

        onLog(`[${id}] Starting ${command} ${args.join(' ')}`);

        const child = spawn(command, args, options);

        child.stdout.on('data', (data) => {
            onLog(`[${id}] ${data.toString().trim()}`);
        });

        child.stderr.on('data', (data) => {
            // Postgres logs to stderr usually, so don't treat it as fatal error
            onLog(`[${id}] ${data.toString().trim()}`);
            // console.error(`[${id}] ERROR: ${data.toString().trim()}`);
        });

        child.on('close', (code) => {
            onLog(`[${id}] Process exited with code ${code}`);
            delete this.processes[id];
            this.emit('process-exit', { id, code });
        });

        child.on('error', (err) => {
            onLog(`[${id}] Failed to start: ${err.message}`);
        });

        this.processes[id] = child;
        return child;
    }

    stop(id) {
        const child = this.processes[id];
        if (child) {
            console.log(`[${id}] Stopping...`);
            // Windows often needs SIGTERM or even SIGKILL if it doesn't listen to SIGINT
            // Python/pgAdmin might be stubborn
            child.kill('SIGTERM'); 
            delete this.processes[id];
        }
    }

    stopAll() {
        Object.keys(this.processes).forEach(id => this.stop(id));
    }
}

module.exports = new ProcessManager();
