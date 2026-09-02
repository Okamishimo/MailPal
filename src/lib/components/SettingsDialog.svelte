<script lang="ts">
	import type { DestinationAddress, GlobalSenderBlocklist, Tag } from '$lib/types.js';
	import Dialog from './Dialog.svelte';
	import ColorPicker from './ColorPicker.svelte';
	import BackupSection from './BackupSection.svelte';
  import { randomSwatchColor, SWATCHES } from '$lib/constants';
	import { pollCascadeDelete } from '$lib/cascade-delete.js';

	let {
		open,
		destinations,
		tags,
		onClose,
		onAdded,
		onRemoved,
		onTagCreated,
		onTagDeleted,
		onTagUpdated,
		globalSenderBlocklist,
		onGlobalSenderBlocklistUpdated,
		demo = false
	}: {
		open: boolean;
		destinations: DestinationAddress[];
		tags: Tag[];
		onClose: () => void;
		onAdded: (dest: DestinationAddress) => void;
		onRemoved: (email: string) => void;
		onTagCreated: (tag: Tag) => void;
		onTagDeleted: (name: string) => void;
		onTagUpdated: (tag: Tag) => void;
		globalSenderBlocklist: GlobalSenderBlocklist;
		onGlobalSenderBlocklistUpdated: (blocklist: GlobalSenderBlocklist) => void;
		demo?: boolean;
	} = $props();

	let newEmail = $state('');
	let adding = $state(false);
	let addError = $state('');
	let justAdded = $state<string | null>(null);
	let deletingEmail = $state<string | null>(null);

	// Tag form state
	let newTagName = $state('');
	let newTagColor = $state<string | undefined>(randomSwatchColor());
	let addingTag = $state(false);
	let addTagError = $state('');
	let showTagForm = $state(false);
	let showDestinationForm = $state(false);
	let deletingTag = $state<string | null>(null);
	// Kept separate from addTagError, which only renders inside the add-tag form.
	let deleteTagError = $state('');
	let deleteController: AbortController | null = null;

	function abortTagDelete() {
		deleteController?.abort();
		deleteController = null;
		deletingTag = null;
	}

	// Abandon an in-flight cascade when the dialog closes or unmounts: a late
	// response must not fire onTagDeleted after the user has moved on.
	$effect(() => {
		if (!open) abortTagDelete();
		return abortTagDelete;
	});

	// Global sender blocklist form state
	let globalBlockedAddresses = $state('');
	let globalBlockedDomains = $state('');
	let savingGlobalBlocklist = $state(false);
	let globalBlocklistError = $state('');
	let globalBlocklistSaved = $state(false);

	function rulesToText(rules: string[]): string {
		return rules.join('\n');
	}

	function textToRules(value: string): string[] {
		return value.split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean);
	}

	$effect(() => {
		if (!open) return;
		globalBlockedAddresses = rulesToText(globalSenderBlocklist.blockedSenderAddresses);
		globalBlockedDomains = rulesToText(globalSenderBlocklist.blockedSenderDomains);
		globalBlocklistError = '';
		globalBlocklistSaved = false;
	});

	async function saveGlobalBlocklist() {
		savingGlobalBlocklist = true;
		globalBlocklistError = '';
		globalBlocklistSaved = false;
		try {
			const res = await fetch('/api/settings/sender-blocklist', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					blockedSenderAddresses: textToRules(globalBlockedAddresses),
					blockedSenderDomains: textToRules(globalBlockedDomains)
				})
			});
			const body = await res.json();
			if (!res.ok) {
				globalBlocklistError = body.error ?? '儲存全域封鎖清單失敗';
				return;
			}
			const updated = body as GlobalSenderBlocklist;
			onGlobalSenderBlocklistUpdated(updated);
			globalBlockedAddresses = rulesToText(updated.blockedSenderAddresses);
			globalBlockedDomains = rulesToText(updated.blockedSenderDomains);
			globalBlocklistSaved = true;
		} catch {
			globalBlocklistError = '網路連線錯誤';
		} finally {
			savingGlobalBlocklist = false;
		}
	}

	async function handleAdd(e: Event) {
		e.preventDefault();
		adding = true;
		addError = '';
		try {
			const res = await fetch('/api/destinations', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: newEmail.trim() })
			});
			const body = await res.json();
			if (!res.ok) {
				addError = body.error ?? '新增地址失敗';
			} else {
				onAdded(body as DestinationAddress);
				justAdded = newEmail.trim();
				newEmail = '';
			}
		} catch {
			addError = '網路連線錯誤';
		} finally {
			adding = false;
			showDestinationForm = false;
		}
	}

	async function handleDelete(email: string) {
		const confirmDelete = confirm(`確定要刪除轉寄地址「${email}」嗎？之後所有信件都不會再轉寄到此地址。`);
		if (!confirmDelete) return;

		deletingEmail = email;
		try {
			await fetch('/api/destinations/' + encodeURIComponent(email), { method: 'DELETE' });
			onRemoved(email);
			if (justAdded === email) justAdded = null;
		} finally {
			deletingEmail = null;
		}
	}

	async function handleAddTag(e: Event) {
		e.preventDefault();
		if (!newTagName.trim()) return;
		addingTag = true;
		addTagError = '';
		try {
			const res = await fetch('/api/tags', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newTagName.trim(), color: newTagColor ?? '#3b82f6' })
			});
			const body = await res.json();
			if (!res.ok) {
				addTagError = body.error ?? '建立標籤失敗';
			} else {
				onTagCreated(body as Tag);
				newTagName = '';
				newTagColor = '#3b82f6';
				showTagForm = false;
			}
		} catch {
			addTagError = '網路連線錯誤';
		} finally {
			addingTag = false;
		}
	}

	async function handleDeleteTag(name: string) {
		const confirmDelete = confirm(`確定要刪除標籤「${name}」嗎？所有地址上的這個標籤都會一併移除。`);
		if (!confirmDelete) return;

		abortTagDelete();
		const controller = new AbortController();
		deleteController = controller;
		deletingTag = name;
		deleteTagError = '';
		try {
			const result = await pollCascadeDelete('/api/tags/' + encodeURIComponent(name), {
				signal: controller.signal,
				failureMessage: '刪除標籤失敗'
			});
			if (result.ok) onTagDeleted(name);
			else deleteTagError = result.error;
		} catch {
			if (!controller.signal.aborted) deleteTagError = '網路連線錯誤，請重試以繼續清理';
		} finally {
			// Only the current run may clear the busy state — an abandoned one
			// unwinding late must not stop a delete the user has since restarted.
			if (deleteController === controller) {
				deleteController = null;
				deletingTag = null;
			}
		}
	}

	async function handleUpdateTag(tag: Tag) {
		onTagUpdated(tag);
	}

	function handleShowAddTag() {
		newTagName = '';
		newTagColor = randomSwatchColor();
		addTagError = '';
		showTagForm = true;
	}

	function handleShowDestinationForm() {
		newEmail = '';
		addError = '';
		showDestinationForm = true;
	}

	function handleClose() {
		newEmail = '';
		addError = '';
		justAdded = null;
		newTagName = '';
		newTagColor = '#3b82f6';
		showTagForm = false;
		addTagError = '';
		globalBlocklistError = '';
		globalBlocklistSaved = false;
		onClose();
	}
</script>

<Dialog open={open} title="設定" onClose={handleClose}>
	<div class="space-y-4 p-4 sm:p-6">

		<!-- Section header -->
		<div>
			<h3 class="text-sm font-semibold text-app-text mb-0.5">轉寄地址</h3>
			<p class="text-xs text-app-muted leading-relaxed">
				Cloudflare 電子郵件路由可將信件轉寄到這些地址。
				每個地址都必須先在 Cloudflare 完成驗證才能收信。
			</p>
		</div>

		<!-- Address list -->
		{#if destinations.length > 0}
			<ul class="space-y-2" aria-label="轉寄地址">
				{#each destinations as dest (dest.email)}
					<li class="flex flex-col gap-2">
						<div class="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-app-hover border border-app-border">
							<!-- Dot indicator -->
							<!-- <span class="w-1.5 h-1.5 rounded-full bg-app-accent/70 shrink-0" aria-hidden="true"></span> -->
							<span class="flex-1 text-sm text-app-text truncate">{dest.email}</span>
							<button
								onclick={() => handleDelete(dest.email)}
								disabled={deletingEmail === dest.email}
								aria-label="移除 {dest.email}"
								class="p-1 text-app-muted/60 hover:text-red-400 rounded transition-colors disabled:opacity-40 shrink-0"
							>
								<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
								</svg>
							</button>
						</div>

						<!-- Cloudflare setup guide for newly added address -->
						{#if justAdded === dest.email}
							<div class="ml-3 pl-3 border-l-2 border-app-accent/30 space-y-2.5">
								<p class="text-xs font-medium text-app-accent">在 Cloudflare 驗證此地址</p>
								<ol class="space-y-2">
									{#each [
										'在 Cloudflare 控制台前往「電子郵件 → 電子郵件路由 → 轉寄地址」。',
										'按下「新增轉寄地址」，輸入 ' + dest.email + '，再按下「傳送驗證電子郵件」。',
										'開啟 Cloudflare 寄到收件匣的信件，並按下驗證連結。'
									] as instruction, i}
										<li class="flex gap-2.5 text-xs text-app-muted leading-relaxed">
											<span class="flex-none w-4 h-4 rounded-full border border-app-border text-[10px] font-bold flex items-center justify-center mt-px text-app-muted/70" aria-hidden="true">
												{i + 1}
											</span>
											{instruction}
										</li>
									{/each}
								</ol>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-sm text-app-muted text-center py-4 rounded-lg border border-dashed border-app-border">
				尚未新增轉寄地址
			</p>
		{/if}

		{#if showDestinationForm}
			<!-- Add address form -->
			<form onsubmit={handleAdd} class="space-y-2">
				<label for="dest-email" class="block text-xs font-medium text-app-muted">
					新增轉寄地址
				</label>
				<div class="flex flex-wrap gap-2">
					<input
						id="dest-email"
						type="email"
						bind:value={newEmail}
						placeholder="you@gmail.com"
						required
					class="min-w-0 basis-full flex-1 rounded-lg border border-app-border bg-app-hover px-3 py-1.5 text-sm text-app-text placeholder:text-app-muted transition-colors focus:border-app-accent/60 focus:outline-none sm:basis-auto"
					/>
					<button
						type="submit"
						disabled={adding || !newEmail.trim()}
						aria-busy={adding}
						class="flex-1 whitespace-nowrap rounded-lg bg-app-accent px-4 py-1.5 text-xs font-semibold text-app-bg transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none"
					>
						{adding ? '新增中…' : '新增'}
					</button>
					<button
						type="button"
						onclick={() => { showDestinationForm = false; addError = ''; }}
						class="p-2 text-xs text-app-muted hover:text-app-text border border-app-border hover:border-app-hover rounded-lg transition-colors"
					>
						<!-- Close icon -->
						<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>
				{#if addError}
					<p role="alert" class="text-xs text-red-400">{addError}</p>
				{/if}
			</form>
		{:else}
			<button
				type="button"
				onclick={handleShowDestinationForm}
				class="text-xs text-app-accent hover:underline underline-offset-2 ml-2"
			>
				+ 新增轉寄地址
			</button>
		{/if}

		<div class="border-t border-app-border"></div>

		<!-- Global sender blocklist -->
		<div class="space-y-3">
			<div>
				<h3 class="text-sm font-semibold text-app-text mb-0.5">全域寄件者封鎖清單</h3>
				<p class="text-xs text-app-muted leading-relaxed">
					這些 SMTP 信封寄件者會套用至所有別名。每行填寫一個完整地址或網域；
					網域規則也會比對其子網域。
				</p>
			</div>
			<div class="grid gap-3 sm:grid-cols-2">
				<label class="space-y-1.5">
					<span class="block text-xs font-medium text-app-muted">封鎖的地址</span>
					<textarea
						bind:value={globalBlockedAddresses}
						rows="4"
						spellcheck="false"
						placeholder="spam@example.com"
						class="w-full resize-y px-3 py-2 rounded-lg border border-app-border bg-app-hover font-mono text-xs text-app-text placeholder:text-app-muted/70 focus:outline-none focus:border-app-accent/60 transition-colors"
					></textarea>
				</label>
				<label class="space-y-1.5">
					<span class="block text-xs font-medium text-app-muted">封鎖的網域</span>
					<textarea
						bind:value={globalBlockedDomains}
						rows="4"
						spellcheck="false"
						placeholder="spam.example"
						class="w-full resize-y px-3 py-2 rounded-lg border border-app-border bg-app-hover font-mono text-xs text-app-text placeholder:text-app-muted/70 focus:outline-none focus:border-app-accent/60 transition-colors"
					></textarea>
				</label>
			</div>
			<div class="flex flex-wrap items-center justify-end gap-2">
				{#if globalBlocklistError}
					<span role="alert" class="text-xs text-red-400">{globalBlocklistError}</span>
				{:else if globalBlocklistSaved}
					<span class="text-xs text-green-400">已儲存</span>
				{/if}
				<button
					type="button"
					onclick={saveGlobalBlocklist}
					disabled={savingGlobalBlocklist}
					class="px-3 py-1.5 text-xs font-semibold bg-app-accent text-app-bg rounded-lg hover:brightness-110 transition-all disabled:opacity-40"
				>
					{savingGlobalBlocklist ? '儲存中…' : '儲存封鎖清單'}
				</button>
			</div>
		</div>

		<div class="border-t border-app-border"></div>

		<!-- Tags section -->
		<div>
			<h3 class="text-sm font-semibold text-app-text mb-0.5">標籤</h3>
			<p class="text-xs text-app-muted leading-relaxed">
				使用彩色標籤整理地址，方便篩選與分組。
			</p>
		</div>

		{#if tags.length > 0}
			<ul class="space-y-2" aria-label="標籤">
				{#each tags as tag (tag.name)}
					<li class="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-app-hover border border-app-border">
						<ColorPicker bind:value={tag.color} size={3} onChange={(value) => { if (value) handleUpdateTag({ ...tag, color: value }); }} />
						<span class="flex-1 text-sm text-app-text">{tag.name}</span>
						{#if tag.pendingDelete}
							<span class="text-xs text-app-muted shrink-0">清理中…</span>
						{/if}
						<button
							onclick={() => handleDeleteTag(tag.name)}
							disabled={deletingTag !== null}
							aria-label={tag.pendingDelete ? `繼續清理標籤 ${tag.name}` : `刪除標籤 ${tag.name}`}
							class="p-1 text-app-muted/60 hover:text-red-400 rounded transition-colors disabled:opacity-40 shrink-0"
						>
							<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
							</svg>
						</button>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-sm text-app-muted text-center py-4 rounded-lg border border-dashed border-app-border">
				尚未新增標籤
			</p>
		{/if}

		{#if deleteTagError}
			<p role="alert" class="text-xs text-red-400">{deleteTagError}</p>
		{/if}

		{#if showTagForm}
			<form onsubmit={handleAddTag} class="space-y-2 sm:pl-3">
				<div class="flex flex-wrap items-center gap-2">
					<ColorPicker bind:value={newTagColor} />
					<input
						type="text"
						bind:value={newTagName}
						placeholder="標籤名稱"
						required
					class="min-w-[8rem] flex-1 rounded-lg border border-app-border bg-app-hover px-3 py-1.5 text-sm text-app-text placeholder:text-app-muted transition-colors focus:border-app-accent/60 focus:outline-none"
					/>
					<button
						type="submit"
						disabled={addingTag || !newTagName.trim()}
						aria-busy={addingTag}
						class="px-3 py-2 text-xs font-semibold bg-app-accent text-app-bg rounded-lg hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
					>
						{addingTag ? '儲存中…' : '儲存'}
					</button>
					<button
						type="button"
						onclick={() => { showTagForm = false; addTagError = ''; }}
						class="p-2 text-xs text-app-muted hover:text-app-text border border-app-border hover:border-app-hover rounded-lg transition-colors"
					>
						<!-- Close icon -->
						<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>
				{#if addTagError}
					<p role="alert" class="text-xs text-red-400">{addTagError}</p>
				{/if}
			</form>
		{:else}
			<button
				type="button"
				onclick={handleShowAddTag}
				class="text-xs text-app-accent hover:underline underline-offset-2 ml-2"
			>
				+ 新增標籤
			</button>
		{/if}

		<div class="border-t border-app-border"></div>

		<BackupSection {demo} />
	</div>
</Dialog>
