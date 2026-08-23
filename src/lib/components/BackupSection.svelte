<script lang="ts">
	import type { BackupImportMode, MailPalBackup } from '$lib/types.js';

	let { demo = false }: { demo?: boolean } = $props();

	let fileInput = $state<HTMLInputElement | null>(null);
	let exporting = $state(false);
	let importing = $state(false);
	let error = $state('');
	let success = $state('');
	let pendingBackup = $state<MailPalBackup | null>(null);
	let pendingFilename = $state('');
	let importMode = $state<BackupImportMode>('merge');

	const MAX_FILE_SIZE = 10 * 1024 * 1024;

	const backupCounts = $derived.by(() => {
		const entries = pendingBackup?.entries ?? [];
		return {
			domains: entries.filter((entry) => entry.key.startsWith('domain:')).length,
			aliases: entries.filter((entry) => entry.key.startsWith('alias:')).length,
			logs: entries.filter((entry) => entry.key.startsWith('log:')).length,
			other: entries.filter((entry) =>
				!entry.key.startsWith('domain:') &&
				!entry.key.startsWith('alias:') &&
				!entry.key.startsWith('log:')
			).length
		};
	});

	function downloadFilename(response: Response): string {
		const disposition = response.headers.get('content-disposition') ?? '';
		const match = disposition.match(/filename="([^"]+)"/i);
		return match?.[1]?.replace(/[^a-zA-Z0-9._-]/g, '') || `mailpal-backup-${new Date().toISOString().slice(0, 10)}.json`;
	}

	async function exportBackup() {
		exporting = true;
		error = '';
		success = '';
		try {
			const response = await fetch('/api/settings/backup');
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body.error ?? '匯出備份失敗');
			}
			const blob = await response.blob();
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = downloadFilename(response);
			document.body.appendChild(link);
			link.click();
			link.remove();
			URL.revokeObjectURL(url);
			success = '備份已下載。';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : '匯出備份失敗';
		} finally {
			exporting = false;
		}
	}

	function clearPendingBackup() {
		pendingBackup = null;
		pendingFilename = '';
		importMode = 'merge';
		if (fileInput) fileInput.value = '';
	}

	async function selectBackup(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		error = '';
		success = '';
		pendingBackup = null;
		pendingFilename = '';
		importMode = 'merge';
		if (!file) return;
		if (file.size > MAX_FILE_SIZE) {
			error = '備份檔案不可超過 10 MB。';
			if (fileInput) fileInput.value = '';
			return;
		}

		try {
			const parsed: unknown = JSON.parse(await file.text());
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw new Error('備份檔案必須是 JSON 物件。');
			}
			const candidate = parsed as Partial<MailPalBackup>;
			if (candidate.format !== 'mailpal-backup' || candidate.version !== 1 || !Array.isArray(candidate.entries)) {
				throw new Error('這不是支援的 MailPal 備份檔案。');
			}
			pendingBackup = candidate as MailPalBackup;
			pendingFilename = file.name;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : '無法讀取備份檔案。';
			if (fileInput) fileInput.value = '';
		}
	}

	async function importBackup() {
		if (!pendingBackup || importing || demo) return;
		if (
			importMode === 'replace' &&
			!confirm('取代模式會刪除目前存在、但備份中沒有的 MailPal 資料。確定要繼續嗎？')
		) {
			return;
		}

		importing = true;
		error = '';
		success = '';
		try {
			const response = await fetch('/api/settings/backup', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ backup: pendingBackup, mode: importMode })
			});
			const body = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(body.error ?? '匯入備份失敗');
			success = `已匯入 ${body.imported ?? pendingBackup.entries.length} 筆資料${body.removed ? `，並移除 ${body.removed} 筆舊資料` : ''}。正在重新載入…`;
			setTimeout(() => window.location.reload(), 900);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : '匯入備份失敗';
		} finally {
			importing = false;
		}
	}
</script>

<section class="space-y-3" aria-labelledby="backup-heading">
	<div>
		<h3 id="backup-heading" class="mb-0.5 text-sm font-semibold text-app-text">資料備份</h3>
		<p class="text-xs leading-relaxed text-app-muted">
			匯出網域、別名、轉寄地址、標籤、寄件者規則與活動紀錄。備份包含電子郵件地址與寄件者紀錄，請妥善保管。
		</p>
	</div>

	<div class="grid gap-2 sm:grid-cols-2">
		<button
			type="button"
			onclick={exportBackup}
			disabled={exporting}
			class="flex items-center justify-center gap-2 rounded-lg border border-app-border px-3 py-2.5 text-xs font-medium text-app-text transition-colors hover:border-app-hover hover:bg-app-hover disabled:opacity-40"
		>
			<svg class="h-4 w-4 text-app-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" />
			</svg>
			{exporting ? '正在匯出…' : '匯出備份'}
		</button>

		<button
			type="button"
			onclick={() => fileInput?.click()}
			disabled={importing || demo}
			class="flex items-center justify-center gap-2 rounded-lg border border-app-border px-3 py-2.5 text-xs font-medium text-app-text transition-colors hover:border-app-hover hover:bg-app-hover disabled:cursor-not-allowed disabled:opacity-40"
		>
			<svg class="h-4 w-4 text-app-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 20V9m0 0l-4 4m4-4l4 4M5 5h14" />
			</svg>
			選擇備份檔案
		</button>
		<input
			bind:this={fileInput}
			type="file"
			accept="application/json,.json"
			onchange={selectBackup}
			class="sr-only"
			aria-label="選擇 MailPal 備份檔案"
		/>
	</div>

	{#if demo}
		<p class="text-xs text-amber-400">展示模式可以匯出，但不支援匯入備份。</p>
	{/if}

	{#if pendingBackup}
		<div class="space-y-3 rounded-xl border border-app-border bg-app-bg/40 p-3">
			<div class="flex min-w-0 items-start justify-between gap-3">
				<div class="min-w-0">
					<p class="truncate text-xs font-medium text-app-text" title={pendingFilename}>{pendingFilename}</p>
					<p class="mt-0.5 text-[11px] text-app-muted">
						備份時間：{new Date(pendingBackup.exportedAt).toLocaleString('zh-TW')}
					</p>
				</div>
				<button
					type="button"
					onclick={clearPendingBackup}
					class="shrink-0 rounded p-1.5 text-app-muted transition-colors hover:bg-app-hover hover:text-app-text"
					aria-label="取消匯入"
				>
					<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>

			<div class="grid grid-cols-4 gap-1.5 text-center">
				{#each [
					['網域', backupCounts.domains],
					['別名', backupCounts.aliases],
					['紀錄', backupCounts.logs],
					['其他', backupCounts.other]
				] as item (item[0])}
					<div class="rounded-lg bg-app-hover/60 px-1 py-2">
						<p class="text-sm font-bold tabular-nums text-app-text">{item[1]}</p>
						<p class="text-[10px] text-app-muted">{item[0]}</p>
					</div>
				{/each}
			</div>

			<fieldset class="space-y-1.5">
				<legend class="text-xs font-medium text-app-muted">匯入方式</legend>
				<label class="flex cursor-pointer items-start gap-2 rounded-lg border border-app-border p-2.5 transition-colors hover:bg-app-hover/50">
					<input type="radio" bind:group={importMode} value="merge" class="mt-0.5 accent-app-accent" />
					<span>
						<span class="block text-xs font-medium text-app-text">合併（建議）</span>
						<span class="block text-[11px] leading-relaxed text-app-muted">更新同名資料並加入缺少的資料，不刪除目前其他內容。</span>
					</span>
				</label>
				<label class="flex cursor-pointer items-start gap-2 rounded-lg border border-red-400/20 p-2.5 transition-colors hover:bg-red-400/5">
					<input type="radio" bind:group={importMode} value="replace" class="mt-0.5 accent-red-400" />
					<span>
						<span class="block text-xs font-medium text-red-400">取代現有資料</span>
						<span class="block text-[11px] leading-relaxed text-app-muted">寫入備份後，刪除備份中不存在的 MailPal 資料。</span>
					</span>
				</label>
			</fieldset>

			<div class="flex justify-end">
				<button
					type="button"
					onclick={importBackup}
					disabled={importing || demo}
					class="rounded-lg bg-app-accent px-4 py-2 text-xs font-semibold text-app-bg transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{importing ? '正在匯入…' : '開始匯入'}
				</button>
			</div>
		</div>
	{/if}

	{#if error}
		<p role="alert" class="rounded-lg bg-red-400/10 px-3 py-2 text-xs text-red-400">{error}</p>
	{:else if success}
		<p role="status" class="rounded-lg bg-green-400/10 px-3 py-2 text-xs text-green-400">{success}</p>
	{/if}
</section>
