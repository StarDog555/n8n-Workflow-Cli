import { UserRepository, WorkflowRepository } from '@n8n/db';
import { Command } from '@n8n/decorators';
import { Container } from '@n8n/di';

import { PasswordUtility } from '@/services/password.utility';

import { BaseCommand } from '../base-command';

/** Marker so the root CLI can find our JSON line among n8n's own log output. */
const MARK = '@@N8NCLI@@';

/**
 * Used by the root `cli/cli.ts`.
 *
 * - Verifies the credentials passed via N8N_CLI_EMAIL / N8N_CLI_PASSWORD (when set).
 * - Prints the list of workflows.
 *
 * It only opens the database. No HTTP server is started, so n8n does NOT need to be running.
 * Credentials go through env vars (not flags) so they never show up in the process list.
 */
@Command({
	name: 'bg:info',
	description: 'Internal: verify a login and list workflows for the background CLI',
})
export class BgInfo extends BaseCommand {
	async run() {
		const email = process.env.N8N_CLI_EMAIL;
		const password = process.env.N8N_CLI_PASSWORD;

		if (email !== undefined) {
			const user = await Container.get(UserRepository).findOne({ where: { email } });
			const valid =
				!!user &&
				!user.disabled &&
				!!password &&
				(await Container.get(PasswordUtility).compare(password, user.password));

			if (!valid) {
				this.emit({ ok: false, error: 'Invalid email or password' });
				return;
			}
		}

		const rows = await Container.get(WorkflowRepository).find({
			select: { id: true, name: true, isArchived: true },
		});

		const workflows = rows
			.filter((w) => !w.isArchived)
			.map((w) => ({ id: w.id, name: w.name }))
			.sort((a, b) => a.name.localeCompare(b.name));

		this.emit({ ok: true, workflows });
	}

	async catch(error: Error) {
		this.emit({ ok: false, error: error.message });
	}

	private emit(payload: unknown) {
		process.stdout.write(`${MARK}${JSON.stringify(payload)}\n`);
	}
}
