import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { BackupImportMode } from '$lib/types.js';
import {
	createBackup,
	MAX_BACKUP_BYTES,
	restoreBackup,
	validateBackup
} from '$lib/server/backup.js';

function backupFilename(exportedAt: string): string {
	const timestamp = exportedAt.replace(/[:.]/g, '-');
	return `mailpal-backup-${timestamp}.json`;
}

export const GET: RequestHandler = async ({ locals }) => {
	if (locals.apiTokenAuthenticated) {
		return json({ error: '備份只能從已登入的 Dashboard 操作' }, { status: 403 });
	}
	try {
		const backup = await createBackup(locals.kv, locals.db);
		return new Response(JSON.stringify(backup, null, 2), {
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				'Content-Disposition': `attachment; filename="${backupFilename(backup.exportedAt)}"`,
				'Cache-Control': 'no-store'
			}
		});
	} catch (error) {
		console.error('Backup export failed', error);
		return json({ error: error instanceof Error ? error.message : '匯出備份失敗' }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (locals.apiTokenAuthenticated) {
		return json({ error: '備份只能從已登入的 Dashboard 操作' }, { status: 403 });
	}
	if (locals.demo) return json({ error: '展示模式不支援匯入備份' }, { status: 403 });

	const contentLength = Number(request.headers.get('content-length') ?? 0);
	if (contentLength > MAX_BACKUP_BYTES) {
		return json({ error: '備份檔案超過 10 MB 上限' }, { status: 413 });
	}

	const rawBody = await request.text();
	if (new TextEncoder().encode(rawBody).byteLength > MAX_BACKUP_BYTES) {
		return json({ error: '備份檔案超過 10 MB 上限' }, { status: 413 });
	}

	let body: unknown;
	try {
		body = JSON.parse(rawBody) as unknown;
	} catch {
		return json({ error: 'JSON 內容無效' }, { status: 400 });
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return json({ error: '匯入內容格式無效' }, { status: 400 });
	}

	const wrapper = body as Record<string, unknown>;
	const mode = wrapper.mode as BackupImportMode;
	if (mode !== 'merge' && mode !== 'replace') {
		return json({ error: '匯入模式必須是 merge 或 replace' }, { status: 400 });
	}

	const validation = await validateBackup(wrapper.backup);
	if (!validation.ok) return json({ error: validation.error }, { status: 400 });

	try {
		const summary = await restoreBackup(locals.kv, validation.backup, mode, locals.db);
		return json({ ok: true, ...summary });
	} catch (error) {
		console.error('Backup restore failed', error);
		return json(
			{ error: '匯入過程中發生錯誤；部分資料可能已寫入，請重新匯入同一份備份' },
			{ status: 500 }
		);
	}
};
