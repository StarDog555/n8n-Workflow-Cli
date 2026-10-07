import { WorkflowRepository } from '@n8n/db';
import type { WorkflowEntity } from '@n8n/db';
import { Command } from '@n8n/decorators';
import { Container } from '@n8n/di';
import { sleep } from '@n8n/utils/sleep';
import { z } from 'zod';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { PollJobProvider } from '@/scheduling/poll-trigger-node/poll-job-provider';

import { BaseCommand } from '../base-command';

const MARK = '@@N8NCLI@@';

const flagsSchema = z.object({
	id: z.string().describe('ID of the workflow to keep running'),
});

/**
 * Used by the root `cli/cli.ts` (spawned detached, one process per workflow).
 *
 * Boots n8n WITHOUT the HTTP server, registers this workflow's triggers
 * (schedule, polling, app triggers, ...) in-process and then stays alive until
 * it gets SIGTERM / SIGINT.
 *
 * The workflow does not have to be published. Nothing is written to the
 * workflow's published state, so stopping the process fully stops the workflow.
 */
@Command({
	name: 'bg:run',
	description: 'Internal: run one workflow in the background without an n8n server',
	examples: ['--id=5'],
	flagsSchema,
})
export class BgRun extends BaseCommand<z.infer<typeof flagsSchema>> {
	override needsCommunityPackages = true;

	override needsExpressionEngine = true;

	override needsTaskRunner = true;

	private activeWorkflowManager: ActiveWorkflowManager;

	async init() {
		await super.init();

		// Single process, no HTTP server: we are our own leader. Non-webhook triggers
		// are only registered on the leader.
		this.instanceSettings.markAsLeader();

		await this.initLicense();
		await this.initPolicyEnforcement();
		await this.initCommunityPackages();
		await this.initBinaryDataService();
		await this.initDataDeduplicationService();
		await this.initExternalHooks();

		// Needed so polling triggers can be scheduled (same as `n8n start`).
		Container.get(PollJobProvider).init();

		// Queue mode needs Redis + workers. We run executions in this process.
		if (this.globalConfig.executions.mode === 'queue') {
			this.globalConfig.executions.mode = 'regular';
		}

		// Trigger callbacks should use the in-memory workflow instead of looking for a
		// published version in the DB, because we may be running an unpublished workflow.
		this.globalConfig.workflows.useWorkflowPublicationService = false;

		this.activeWorkflowManager = Container.get(ActiveWorkflowManager);
	}

	async run() {
		const { id } = this.flags;

		const workflow = await Container.get(WorkflowRepository).findById(id);
		if (!workflow) throw new Error(`Workflow "${id}" does not exist`);

		// ActiveWorkflowManager reads the nodes from `activeVersion`. For a workflow that was
		// never published, use its current draft (in memory only, nothing is saved).
		if (!workflow.activeVersion) {
			workflow.activeVersion = {
				nodes: workflow.nodes,
				connections: workflow.connections,
			} as unknown as WorkflowEntity['activeVersion'];
		}

		await this.activeWorkflowManager.add(id, 'activate', workflow);

		const stop = async () => {
			try {
				await this.activeWorkflowManager.remove(id);
			} catch {
				/* shutting down anyway */
			}
			if (this.dbConnection.connectionState.connected) {
				await sleep(100);
				await this.dbConnection.close();
			}
			process.exit(0);
		};
		process.once('SIGTERM', () => void stop());
		process.once('SIGINT', () => void stop());

		this.emit({ event: 'ready', id, name: workflow.name });

		// Keep the process alive even if the workflow only has webhook-style triggers.
		setInterval(() => {}, 1 << 30);
	}

	async catch(error: Error) {
		this.emit({ event: 'error', message: error.message });
		this.logError(error);
	}

	/** On success stay alive (the base class would exit); on error let it exit(1). */
	override async finally(error: Error | undefined) {
		if (error) await super.finally(error);
	}

	private emit(payload: unknown) {
		process.stdout.write(`${MARK}${JSON.stringify(payload)}\n`);
	}
}
