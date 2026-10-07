import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	Cancelled,
	bold,
	c256,
	checkbox,
	dim,
	green,
	input,
	password,
	red,
	select,
	spinner,
	yellow,
} from './ui';

/* ------------------------------------------------------------------ */
/* Banner                                                              */
/* ------------------------------------------------------------------ */

function PrintAscii() {
	const banner = String.raw`
 ________   ________  ________           ________  ___       ___
|\   ___  \|\   __  \|\   ___  \        |\   ____\|\  \     |\  \ 
\ \  \\ \  \ \  \|\  \ \  \\ \  \       \ \  \___|\ \  \    \ \  \   
 \ \  \\ \  \ \   __  \ \  \\ \  \       \ \  \    \ \  \    \ \  \  
  \ \  \\ \  \ \  \|\  \ \  \\ \  \       \ \  \____\ \  \____\ \  \ 
   \ \__\\ \__\ \_______\ \__\\ \__\       \ \_______\ \_______\ \__\ 
    \|__| \|__|\|_______|\|__| \|__|        \|_______|\|_______|\|__| 
`;
	const gradient = [208, 209, 205, 204, 170, 135, 99];
	const lines = banner.split('\n').filter((l) => l.trim().length > 0);

	console.log();
	lines.forEach((line, i) => console.log(c256(gradient[Math.min(i, gradient.length - 1)], line)));
	console.log(dim('    Run n8n workflows in the background - no server needed\n'));
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

/** Walk up from this file until we find the n8n monorepo root. */
function findRepoRoot(): string {
	let dir = __dirname;
	for (let i = 0; i < 6; i++) {
		if (existsSync(path.join(dir, 'packages', 'cli', 'bin', 'n8n'))) return dir;
		dir = path.dirname(dir);
	}
	throw new Error('Could not find the n8n repo root (packages/cli/bin/n8n).');
}

const ROOT = findRepoRoot();
const N8N_BIN = path.join(ROOT, 'packages', 'cli', 'bin', 'n8n');

const DIR = path.join(os.homedir(), '.n8n-cli');
const STATE_FILE = path.join(DIR, 'state.json');
const LOG_DIR = path.join(DIR, 'logs');

const MARK = '@@N8NCLI@@';

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

interface WorkflowInfo {
	id: string;
	name: string;
}

interface RunningEntry extends WorkflowInfo {
	pid: number;
	startedAt: string;
	logFile: string;
}

interface State {
	user?: string;
	running: RunningEntry[];
}

async function loadState(): Promise<State> {
	try {
		return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) as State;
	} catch {
		return { running: [] };
	}
}

// Workers start in parallel, so write the file one at a time.
let saveQueue: Promise<void> = Promise.resolve();

async function saveState(state: State) {
	saveQueue = saveQueue.then(async () => {
		await fs.mkdir(DIR, { recursive: true });
		await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
	});
	await saveQueue;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Forget workers that died (crash, reboot, killed by hand). */
async function pruneDead(state: State) {
	state.running = state.running.filter((e) => isAlive(e.pid));
	await saveState(state);
}

/* ------------------------------------------------------------------ */
/* Talking to n8n (no server: we run n8n's own commands)               */
/* ------------------------------------------------------------------ */

function lastMarker(text: string): Record<string, unknown> | undefined {
	const line = text
		.split(/\r?\n/)
		.reverse()
		.find((l) => l.includes(MARK));
	if (!line) return undefined;
	try {
		return JSON.parse(line.slice(line.indexOf(MARK) + MARK.length)) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** Run `n8n bg:info` once. Optional credentials are passed through env vars, never argv. */
async function queryN8n(credentials?: { email: string; password: string }) {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (credentials) {
		env.N8N_CLI_EMAIL = credentials.email;
		env.N8N_CLI_PASSWORD = credentials.password;
	}

	const child = spawn(process.execPath, [N8N_BIN, 'bg:info'], {
		cwd: ROOT,
		env,
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	let out = '';
	let err = '';
	child.stdout.on('data', (d: Buffer) => (out += d.toString()));
	child.stderr.on('data', (d: Buffer) => (err += d.toString()));

	await new Promise<void>((resolve) => child.on('close', () => resolve()));

	const result = lastMarker(out);
	if (!result) {
		const hint = (err || out).trim().split('\n').slice(-3).join('\n');
		throw new Error(
			`n8n did not answer. Is the project built (pnpm build)?${hint ? `\n${dim(hint)}` : ''}`,
		);
	}
	return result as { ok: boolean; error?: string; workflows?: WorkflowInfo[] };
}

async function fetchWorkflows(): Promise<WorkflowInfo[]> {
	const s = spinner('Loading workflows...');
	try {
		const res = await queryN8n();
		if (!res.ok) throw new Error(res.error ?? 'Unknown error');
		return res.workflows ?? [];
	} finally {
		s.stop();
	}
}

/* ------------------------------------------------------------------ */
/* Login                                                               */
/* ------------------------------------------------------------------ */

async function login(state: State): Promise<WorkflowInfo[]> {
	console.log(bold('Login'));
	console.log(dim('Use your n8n account (the same email and password as the editor).\n'));

	while (true) {
		const email = (await input('Email:')).trim();
		const pass = await password('Password:');

		const s = spinner('Checking credentials...');
		try {
			const res = await queryN8n({ email, password: pass });
			s.stop();

			if (res.ok) {
				state.user = email;
				await saveState(state);
				console.log(green('\n✔ Logged in\n'));
				return res.workflows ?? [];
			}
			console.log(red(`\n✖ ${res.error ?? 'Login failed'}\n`));
		} catch (e) {
			s.stop();
			console.log(red(`\n✖ ${(e as Error).message}\n`));
		}
	}
}

/* ------------------------------------------------------------------ */
/* Start / stop                                                        */
/* ------------------------------------------------------------------ */

const sleep = async (ms: number) => await new Promise((r) => setTimeout(r, ms));

/** Spawn one detached worker and wait until it reports "ready" (or fails). */
async function startWorker(state: State, wf: WorkflowInfo, brokerPort: number): Promise<void> {
	await fs.mkdir(LOG_DIR, { recursive: true });
	const logFile = path.join(LOG_DIR, `${wf.id}.log`);
	await fs.writeFile(logFile, ''); // fresh log per start
	const fd = openSync(logFile, 'a');

	const child = spawn(process.execPath, [N8N_BIN, 'bg:run', `--id=${wf.id}`], {
		cwd: ROOT,
		detached: true, // keeps running after this CLI exits
		windowsHide: true,
		stdio: ['ignore', fd, fd],
		env: {
			...process.env,
			// every worker needs its own task-runner broker port
			N8N_RUNNERS_BROKER_PORT: String(brokerPort),
		},
	});
	child.unref();
	closeSync(fd);

	const pid = child.pid;
	if (!pid) throw new Error('Could not spawn the worker process');

	// Wait up to 2 minutes for the worker to boot and register its triggers
	for (let i = 0; i < 240; i++) {
		await sleep(500);
		const log = await fs.readFile(logFile, 'utf8').catch(() => '');
		const marker = lastMarker(log);

		if (marker?.event === 'ready') {
			state.running.push({
				id: wf.id,
				name: wf.name,
				pid,
				startedAt: new Date().toISOString(),
				logFile,
			});
			await saveState(state);
			return;
		}
		if (marker?.event === 'error') {
			throw new Error(String(marker.message ?? 'Failed to start'));
		}
		if (!isAlive(pid)) throw new Error(`Process exited early (see ${logFile})`);
	}

	try {
		process.kill(pid, 'SIGKILL');
	} catch {
		/* ignore */
	}
	throw new Error('Timed out while starting');
}

async function stopWorker(state: State, entry: RunningEntry): Promise<void> {
	try {
		process.kill(entry.pid, 'SIGTERM');
	} catch {
		/* already gone */
	}

	for (let i = 0; i < 50 && isAlive(entry.pid); i++) await sleep(100);

	if (isAlive(entry.pid)) {
		try {
			process.kill(entry.pid, 'SIGKILL');
		} catch {
			/* ignore */
		}
	}

	state.running = state.running.filter((e) => e.pid !== entry.pid);
	await saveState(state);
}

/* ------------------------------------------------------------------ */
/* Menu actions                                                        */
/* ------------------------------------------------------------------ */

async function actionStart(state: State, known?: WorkflowInfo[]) {
	const all = known ?? (await fetchWorkflows());
	const runningIds = new Set(state.running.map((e) => e.id));
	const available = all.filter((w) => !runningIds.has(w.id));

	if (available.length === 0) {
		console.log(yellow('No workflows available to start.\n'));
		return;
	}

	const chosen = await checkbox(
		'Select workflows to run in the background',
		available.map((w) => ({ name: `${w.name} ${dim(`(${w.id})`)}`, value: w })),
	);

	if (chosen.length === 0) {
		console.log(dim('Nothing selected.\n'));
		return;
	}

	const s = spinner(`Starting ${chosen.length} workflow(s)...`);
	const basePort = 5700 + Math.floor(Math.random() * 200) * 10;
	const results = await Promise.allSettled(
		chosen.map(async (wf, i) => await startWorker(state, wf, basePort + i)),
	);
	s.stop();

	results.forEach((r, i) => {
		if (r.status === 'fulfilled') console.log(`  ${green('✔')} Started ${chosen[i].name}`);
		else console.log(`  ${red('✖')} ${chosen[i].name}: ${(r.reason as Error).message}`);
	});
	console.log();
}

async function actionStopAll(state: State) {
	for (const entry of [...state.running]) {
		await stopWorker(state, entry);
		console.log(`  ${green('✔')} Stopped ${entry.name}`);
	}
	console.log();
}

async function actionStopOne(state: State) {
	const entry = await select(
		'Which workflow do you want to stop?',
		state.running.map((e) => ({ name: e.name, value: e })),
	);
	await stopWorker(state, entry);
	console.log(`  ${green('✔')} Stopped ${entry.name}\n`);
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
	PrintAscii();

	const state = await loadState();
	await pruneDead(state);

	let workflows: WorkflowInfo[] | undefined;
	if (!state.user) workflows = await login(state);
	else console.log(dim(`Logged in as ${state.user}\n`));

	while (true) {
		await pruneDead(state);

		// Nothing running: pick workflows, start them, leave them running, exit.
		if (state.running.length === 0) {
			await actionStart(state, workflows);
			workflows = undefined;
			if (state.running.length > 0) {
				console.log(green(`${state.running.length} workflow(s) running in the background.`));
				console.log(dim('Run this CLI again to stop them.\n'));
			}
			return;
		}

		console.log(bold(`Running workflows (${state.running.length}):`));
		state.running.forEach((e) => console.log(`  ${green('●')} ${e.name} ${dim(`(pid ${e.pid})`)}`));
		console.log();

		const action = await select('What do you want to do?', [
			{ name: 'Stop all running workflows', value: 'stop-all' },
			{ name: 'Stop a specific workflow', value: 'stop-one' },
			{ name: 'Start more workflows', value: 'start' },
			{ name: 'Log out', value: 'logout' },
			{ name: 'Exit', value: 'exit' },
		]);

		if (action === 'stop-all') await actionStopAll(state);
		else if (action === 'stop-one') await actionStopOne(state);
		else if (action === 'start') await actionStart(state, workflows);
		else if (action === 'logout') {
			delete state.user;
			await saveState(state);
			console.log(green('✔ Logged out (background workflows keep running)\n'));
			return;
		} else return;
	}
}

main().catch((err: unknown) => {
	if (err instanceof Cancelled) {
		console.log(dim('\nBye!'));
		process.exit(0);
	}
	console.error(red(`\nError: ${(err as Error)?.message ?? String(err)}`));
	process.exit(1);
});
