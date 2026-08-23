import { describe, expect, it } from 'vitest';
import {
	createBackup,
	restoreBackup,
	validateBackup
} from '../../src/lib/server/backup.js';
import { MemoryKV, asKV, makeAlias, makeDomain } from './helpers.js';

function seedBackupData(kv: MemoryKV): void {
	const domain = makeDomain();
	const alias = makeAlias();
	kv.store.set(`domain:${domain.domain}`, JSON.stringify(domain));
	kv.store.set(`alias:${alias.domain}/${alias.localPart}`, JSON.stringify(alias));
	kv.store.set('destination:inbox@example.net', JSON.stringify({ email: 'inbox@example.net', createdAt: 1 }));
	kv.store.set('tag:商店', JSON.stringify({ name: '商店', color: '#3b82f6', createdAt: 1 }));
	kv.store.set('settings:onboarded', '1');
	kv.store.set('settings:sender-blocklist', JSON.stringify({
		blockedSenderAddresses: ['spam@example.com'],
		blockedSenderDomains: ['evil.example']
	}));
	kv.store.set(`log:${alias.domain}/${alias.localPart}`, JSON.stringify([{
		at: 1,
		action: 'forwarded',
		from: 'sender@example.com',
		to: 'inbox@example.net'
	}]));
}

describe('MailPal backups', () => {
	it('exports all managed data and excludes temporary security keys', async () => {
		const kv = new MemoryKV();
		seedBackupData(kv);
		kv.store.set('login-attempts:203.0.113.10', '4');

		const backup = await createBackup(asKV(kv));
		const keys = backup.entries.map((entry) => entry.key);

		expect(backup.format).toBe('mailpal-backup');
		expect(backup.version).toBe(1);
		expect(backup.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(keys).toContain('domain:aliases.example.com');
		expect(keys).toContain('alias:aliases.example.com/orders');
		expect(keys).toContain('log:aliases.example.com/orders');
		expect(keys).toContain('settings:sender-blocklist');
		expect(keys).not.toContain('login-attempts:203.0.113.10');
		expect((await validateBackup(backup)).ok).toBe(true);
	});

	it('rejects a backup whose contents no longer match its checksum', async () => {
		const kv = new MemoryKV();
		seedBackupData(kv);
		const backup = await createBackup(asKV(kv));
		const domainEntry = backup.entries.find((entry) => entry.key.startsWith('domain:'))!;
		domainEntry.value = JSON.stringify({
			...JSON.parse(domainEntry.value),
			targetEmail: 'changed@example.net'
		});

		const validation = await validateBackup(backup);
		expect(validation).toMatchObject({
			ok: false,
			error: '備份校驗失敗，檔案可能已損毀或被修改'
		});
	});

	it('rejects unknown keys instead of writing arbitrary KV data', async () => {
		const kv = new MemoryKV();
		seedBackupData(kv);
		const backup = await createBackup(asKV(kv));
		backup.entries.push({ key: 'login-attempts:attacker', value: '0' });

		const validation = await validateBackup(backup);
		expect(validation).toMatchObject({
			ok: false,
			error: '備份包含不支援的設定鍵值'
		});
	});

	it('merges restored data without deleting unrelated existing MailPal data', async () => {
		const source = new MemoryKV();
		seedBackupData(source);
		const backup = await createBackup(asKV(source));
		const target = new MemoryKV();
		target.store.set('tag:保留', JSON.stringify({ name: '保留', color: '#22c55e', createdAt: 2 }));

		const summary = await restoreBackup(asKV(target), backup, 'merge');

		expect(summary.removed).toBe(0);
		expect(target.store.has('domain:aliases.example.com')).toBe(true);
		expect(target.store.has('tag:保留')).toBe(true);
	});

	it('replaces managed data while preserving temporary security keys', async () => {
		const source = new MemoryKV();
		seedBackupData(source);
		const backup = await createBackup(asKV(source));
		const target = new MemoryKV();
		target.store.set('domain:old.example.com', JSON.stringify(makeDomain({ domain: 'old.example.com' })));
		target.store.set('tag:舊資料', JSON.stringify({ name: '舊資料', color: '#ef4444', createdAt: 2 }));
		target.store.set('login-attempts:203.0.113.10', '3');

		const summary = await restoreBackup(asKV(target), backup, 'replace');

		expect(summary.removed).toBe(2);
		expect(target.store.has('domain:old.example.com')).toBe(false);
		expect(target.store.has('tag:舊資料')).toBe(false);
		expect(target.store.get('login-attempts:203.0.113.10')).toBe('3');
		expect(target.store.has('alias:aliases.example.com/orders')).toBe(true);
	});
});
