/**
 * Tiny dependency-free terminal UI: colors, select, checkbox, input, password, spinner.
 * Nothing to install, nothing to bundle.
 */
import readline from 'node:readline';

/* ------------------------------ colors ------------------------------ */

const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (open: string, t: string) => (useColor ? `\x1b[${open}m${t}\x1b[0m` : t);

export const c256 = (code: number, t: string) => (useColor ? `\x1b[38;5;${code}m${t}\x1b[0m` : t);
export const green = (t: string) => sgr('32', t);
export const red = (t: string) => sgr('31', t);
export const yellow = (t: string) => sgr('33', t);
export const cyan = (t: string) => sgr('36', t);
export const dim = (t: string) => sgr('2', t);
export const bold = (t: string) => sgr('1', t);

/* ------------------------------ keypress core ------------------------------ */

export class Cancelled extends Error {
	constructor() {
		super('Cancelled');
		this.name = 'Cancelled';
	}
}

interface Key {
	name?: string;
	ctrl?: boolean;
	meta?: boolean;
}

interface Ctl<T> {
	redraw: () => void;
	done: (value: T, summary: string) => void;
}

function prompt<T>(
	render: () => string,
	onKey: (str: string | undefined, key: Key, ctl: Ctl<T>) => void,
): Promise<T> {
	if (!process.stdin.isTTY) {
		return Promise.reject(new Error('An interactive terminal is required.'));
	}

	return new Promise<T>((resolve, reject) => {
		const stdin = process.stdin;
		readline.emitKeypressEvents(stdin);
		stdin.setRawMode(true);
		stdin.resume();
		process.stdout.write('\x1b[?25l'); // hide cursor

		let lines = 0;
		const clear = () => {
			if (lines > 0) process.stdout.write(`\x1b[${lines}A\x1b[0J`);
			lines = 0;
		};
		const draw = () => {
			clear();
			const out = render();
			process.stdout.write(`${out}\n`);
			lines = out.split('\n').length;
		};
		const cleanup = () => {
			stdin.off('keypress', handler);
			stdin.setRawMode(false);
			stdin.pause();
			process.stdout.write('\x1b[?25h');
		};

		const ctl: Ctl<T> = {
			redraw: draw,
			done: (value, summary) => {
				clear();
				process.stdout.write(`${summary}\n`);
				cleanup();
				resolve(value);
			},
		};

		const handler = (str: string | undefined, key: Key = {}) => {
			if (key.ctrl && key.name === 'c') {
				clear();
				cleanup();
				reject(new Cancelled());
				return;
			}
			onKey(str, key, ctl);
		};

		stdin.on('keypress', handler);
		draw();
	});
}

/* ------------------------------ select ------------------------------ */

export interface Choice<T> {
	name: string;
	value: T;
}

export async function select<T>(message: string, choices: Array<Choice<T>>): Promise<T> {
	let index = 0;

	return await prompt<T>(
		() =>
			[
				`${cyan('?')} ${bold(message)}`,
				...choices.map((c, i) => (i === index ? `${cyan('❯')} ${cyan(c.name)}` : `  ${c.name}`)),
			].join('\n'),
		(_str, key, { redraw, done }) => {
			if (key.name === 'up' || key.name === 'k') index = (index - 1 + choices.length) % choices.length;
			else if (key.name === 'down' || key.name === 'j') index = (index + 1) % choices.length;
			else if (key.name === 'return') {
				done(choices[index].value, `${green('✔')} ${bold(message)} ${cyan(choices[index].name)}`);
				return;
			}
			redraw();
		},
	);
}

/* ------------------------------ checkbox ------------------------------ */

export async function checkbox<T>(
	message: string,
	choices: Array<Choice<T>>,
	pageSize = 12,
): Promise<T[]> {
	let cursor = 0;
	const picked = new Set<number>();

	const render = () => {
		const start = Math.min(
			Math.max(0, cursor - Math.floor(pageSize / 2)),
			Math.max(0, choices.length - pageSize),
		);
		const end = Math.min(choices.length, start + pageSize);

		const rows = choices.slice(start, end).map((c, k) => {
			const i = start + k;
			const box = picked.has(i) ? green('◉') : dim('◯');
			const label = i === cursor ? cyan(c.name) : c.name;
			return `${i === cursor ? cyan('❯') : ' '} ${box} ${label}`;
		});

		const hint = dim(
			`  ↑/↓ move · space select · a all · enter confirm${choices.length > pageSize ? ` · ${cursor + 1}/${choices.length}` : ''}`,
		);
		return [`${cyan('?')} ${bold(message)}`, ...rows, hint].join('\n');
	};

	return await prompt<T[]>(render, (str, key, { redraw, done }) => {
		if (key.name === 'up' || key.name === 'k') cursor = (cursor - 1 + choices.length) % choices.length;
		else if (key.name === 'down' || key.name === 'j') cursor = (cursor + 1) % choices.length;
		else if (key.name === 'space' || str === ' ') {
			if (picked.has(cursor)) picked.delete(cursor);
			else picked.add(cursor);
		} else if (str === 'a') {
			if (picked.size === choices.length) picked.clear();
			else choices.forEach((_, i) => picked.add(i));
		} else if (key.name === 'return') {
			const values = [...picked].sort((a, b) => a - b).map((i) => choices[i].value);
			done(values, `${green('✔')} ${bold(message)} ${cyan(`${values.length} selected`)}`);
			return;
		}
		redraw();
	});
}

/* ------------------------------ input / password ------------------------------ */

async function text(message: string, mask: boolean): Promise<string> {
	let value = '';
	const cursor = useColor ? '\x1b[7m \x1b[0m' : '_';

	return await prompt<string>(
		() => `${cyan('?')} ${bold(message)} ${mask ? '*'.repeat(value.length) : value}${cursor}`,
		(str, key, { redraw, done }) => {
			if (key.name === 'return') {
				done(value, `${green('✔')} ${bold(message)} ${mask ? dim('••••••') : cyan(value)}`);
				return;
			}
			if (key.name === 'backspace') value = value.slice(0, -1);
			else if (str && !key.ctrl && !key.meta && /^[\x20-\x7e\u00a0-\uffff]+$/.test(str)) value += str;
			redraw();
		},
	);
}

export const input = (message: string) => text(message, false);
export const password = (message: string) => text(message, true);

/* ------------------------------ spinner ------------------------------ */

export function spinner(label: string) {
	const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
	let i = 0;
	let current = label;
	const tty = !!process.stdout.isTTY;

	const tick = () => process.stdout.write(`\r\x1b[2K${cyan(frames[i++ % frames.length])} ${current}`);
	if (tty) tick();
	else console.log(current);
	const timer = tty ? setInterval(tick, 80) : undefined;

	return {
		update(next: string) {
			current = next;
		},
		stop() {
			if (timer) clearInterval(timer);
			if (tty) process.stdout.write('\r\x1b[2K');
		},
	};
}
