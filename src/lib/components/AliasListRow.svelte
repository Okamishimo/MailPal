<script lang="ts">
	import type {
		AliasConfig,
		DestinationAddress,
		DomainConfig,
		LogEntry,
		SenderMode,
		Tag
	} from '$lib/types.js';
	import { AlertDialog, Tooltip } from 'bits-ui';
	import { slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import CopyButton from './CopyButton.svelte';
	import DestinationSelect from './DestinationSelect.svelte';
  import ColorPicker from './ColorPicker.svelte';

	let {
		alias,
		tags,
		destinations,
		domainTargetEmail,
		showDomain,
		color,
		onToggle,
		onTagClick,
		onAliasUpdated,
		onDeleted,
		onTagCreated,
		selected = false,
		selectionMode = false,
		onSelect,
		focused = false,
		expandTrigger = 0
	}: {
		alias: AliasConfig;
		tags: Tag[];
		destinations: DestinationAddress[];
		domainTargetEmail: string;
		showDomain: boolean;
		color: string;
		onToggle: () => Promise<void>;
		onTagClick: (name: string) => void;
		onAliasUpdated: (alias: AliasConfig) => void;
		onDeleted: (alias: AliasConfig) => void;
		onTagCreated: (tag: Tag) => void;
		selected?: boolean;
		selectionMode?: boolean;
		onSelect?: (v: boolean) => void;
		focused?: boolean;
		expandTrigger?: number;
	} = $props();

	let toggling = $state(false);
	let expanded = $state(false);

	// Programmatic expand from keyboard shortcut
	$effect(() => {
		if (expandTrigger > 0) expanded = true;
		else expanded = false;
	});

	// Editable state (synced from alias prop)
	let editTargetEmail = $state(alias.targetEmail ?? '');
	let editNote = $state(alias.note ?? '');
	let editTags = $state<string[]>(alias.tags ?? []);
	let editSenderMode = $state<SenderMode>('normal');
	let editAllowedSenderAddresses = $state('');
	let editAllowedSenderDomains = $state('');
	let editBlockedSenderAddresses = $state('');
	let editBlockedSenderDomains = $state('');
	let saving = $state(false);

	function textToRules(value: string): string[] {
		return value.split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean);
	}

	function resetSenderRuleFields(): void {
		editSenderMode = alias.senderMode === 'allowlist' ? 'allowlist' : 'normal';
		editAllowedSenderAddresses = (alias.allowedSenderAddresses ?? []).join('\n');
		editAllowedSenderDomains = (alias.allowedSenderDomains ?? []).join('\n');
		editBlockedSenderAddresses = (alias.blockedSenderAddresses ?? []).join('\n');
		editBlockedSenderDomains = (alias.blockedSenderDomains ?? []).join('\n');
	}

	// Expiry state
	type ExpiryMode = 'none' | 'date' | 'count';
	let expiryMode = $state<ExpiryMode>(
		alias.expiresAt ? 'date' : alias.maxForwards != null ? 'count' : 'none'
	);
	let editExpiresAt = $state<number | null>(alias.expiresAt ?? null);
	let editMaxForwards = $state<number | null>(alias.maxForwards ?? null);

	function tsToDateInput(ts: number | null): string {
		if (!ts) return '';
		return new Date(ts).toISOString().slice(0, 10);
	}
	function dateInputToTs(s: string): number | null {
		if (!s) return null;
		const [y, m, d] = s.split('-').map(Number);
		return new Date(y, m - 1, d).getTime(); // local midnight avoids UTC offset shifting the date
	}
	let saveError = $state('');
	let deleting = $state(false);

	// New tag inline form
	let showNewTagForm = $state(false);
	let newTagName = $state('');
	let newTagColor = $state('#6464D8');
	let creatingTag = $state(false);
	let newTagError = $state('');

	const fullAddress = $derived(`${alias.localPart}@${alias.domain}`);

	const aliasTags = $derived(
		(alias.tags ?? [])
			.map((n) => tags.find((t) => t.name === n))
			.filter((t): t is Tag => t !== undefined)
	);

	// A tag being cascade-deleted stays listed in settings as a retry handle, but
	// assigning it now would leave a reference to a tag that is about to vanish.
	const assignableTags = $derived(
		tags.filter((t) => !t.pendingDelete || (alias.tags ?? []).includes(t.name))
	);

	const expiryBadge = $derived.by((): { label: string; urgency: 'normal' | 'warn' | 'critical' } | null => {
		if (alias.expiresAt) {
			const now = Date.now();
			if (now >= alias.expiresAt) return { label: '已到期', urgency: 'critical' };
			// Compare calendar days in local time to avoid timezone-shifted "today" labels
			const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
			const expStart = new Date(alias.expiresAt); expStart.setHours(0, 0, 0, 0);
			const days = Math.round((expStart.getTime() - todayStart.getTime()) / 86_400_000);
			if (days === 0) return { label: '今天到期', urgency: 'critical' };
			if (days === 1) return { label: '明天到期', urgency: 'warn' };
			if (days <= 7) return { label: `${days} 天後到期`, urgency: 'warn' };
			return { label: `${new Date(alias.expiresAt).toLocaleDateString('zh-TW')} 到期`, urgency: 'normal' };
		}
		if (alias.maxForwards != null) {
			const left = alias.maxForwards - alias.forwardedCount;
			if (left <= 0) return { label: '已達上限', urgency: 'critical' };
			if (left <= 5) return { label: `剩餘 ${left} 次`, urgency: 'warn' };
			return { label: `已轉寄 ${alias.forwardedCount}/${alias.maxForwards}`, urgency: 'normal' };
		}
		return null;
	});

	// Dirty detection — compare local edit state against the current alias prop
	const dirty = $derived(
		editNote.trim() !== (alias.note ?? '').trim() ||
		(editTargetEmail || null) !== alias.targetEmail ||
		editTags.length !== (alias.tags?.length ?? 0) ||
		editTags.some((t) => !(alias.tags ?? []).includes(t)) ||
		(alias.tags ?? []).some((t) => !editTags.includes(t)) ||
		editSenderMode !== (alias.senderMode === 'allowlist' ? 'allowlist' : 'normal') ||
		editAllowedSenderAddresses !== (alias.allowedSenderAddresses ?? []).join('\n') ||
		editAllowedSenderDomains !== (alias.allowedSenderDomains ?? []).join('\n') ||
		editBlockedSenderAddresses !== (alias.blockedSenderAddresses ?? []).join('\n') ||
		editBlockedSenderDomains !== (alias.blockedSenderDomains ?? []).join('\n') ||
		(expiryMode === 'date' ? editExpiresAt : null) !== (alias.expiresAt ?? null) ||
		(expiryMode === 'count' ? editMaxForwards : null) !== (alias.maxForwards ?? null)
	);

	// Sync local edit state when alias prop changes (e.g. after a save)
	$effect(() => {
		editTargetEmail = alias.targetEmail ?? '';
		editNote = alias.note ?? '';
		editTags = [...(alias.tags ?? [])];
		editExpiresAt = alias.expiresAt ?? null;
		editMaxForwards = alias.maxForwards ?? null;
		expiryMode = alias.expiresAt ? 'date' : alias.maxForwards != null ? 'count' : 'none';
		resetSenderRuleFields();
	});

	async function handleToggle() {
		toggling = true;
		try {
			await onToggle();
		} finally {
			toggling = false;
		}
	}

	function toggleExpand() {
		expanded = !expanded;
		if (!expanded) {
			saveError = '';
			showNewTagForm = false;
			newTagName = '';
			newTagError = '';
		}
	}

	function activateRow() {
		if (selectionMode) onSelect?.(!selected);
		else toggleExpand();
	}

	function handleRowKeydown(e: KeyboardEvent) {
		if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
		e.preventDefault();
		activateRow();
	}

	function toggleTagOnAlias(name: string) {
		if (editTags.includes(name)) {
			editTags = editTags.filter((t) => t !== name);
		} else {
			editTags = [...editTags, name];
		}
	}

	async function saveChanges() {
		saving = true;
		saveError = '';
		try {
			const res = await fetch(`/api/domains/${alias.domain}/aliases/${alias.localPart}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					targetEmail: editTargetEmail || null,
					note: editNote.trim() || null,
					tags: editTags,
					senderMode: editSenderMode,
					allowedSenderAddresses: textToRules(editAllowedSenderAddresses),
					allowedSenderDomains: textToRules(editAllowedSenderDomains),
					blockedSenderAddresses: textToRules(editBlockedSenderAddresses),
					blockedSenderDomains: textToRules(editBlockedSenderDomains),
					expiresAt: expiryMode === 'date' ? editExpiresAt : null,
					maxForwards: expiryMode === 'count' ? editMaxForwards : null
				})
			});
			if (res.ok) {
				onAliasUpdated(await res.json());
			} else {
				const body = await res.json();
				saveError = body.error ?? '儲存失敗';
			}
		} catch {
			saveError = '網路連線錯誤';
		} finally {
			saving = false;
		}
	}

	async function handleDelete() {
		deleting = true;
		try {
			const res = await fetch(`/api/domains/${alias.domain}/aliases/${alias.localPart}`, {
				method: 'DELETE'
			});
			if (res.ok) onDeleted(alias);
		} finally {
			deleting = false;
		}
	}

	// ── Activity tab ────────────────────────────────────────────────────────
	let activeTab = $state<'settings' | 'activity'>('settings');
	let activityLog = $state<LogEntry[]>([]);
	let logLoading = $state(false);
	let logError = $state('');
	let logLoaded = $state(false);

	async function loadLog() {
		if (logLoading) return;
		logLoading = true;
		logError = '';
		try {
			const res = await fetch(`/api/domains/${alias.domain}/aliases/${alias.localPart}/log`);
			const data = await res.json();
			if (res.ok) { activityLog = data; logLoaded = true; }
			else logError = data.error ?? '載入失敗';
		} catch {
			logError = '網路連線錯誤';
		} finally {
			logLoading = false;
		}
	}

	function switchTab(tab: 'settings' | 'activity') {
		activeTab = tab;
		if (tab === 'activity' && !logLoaded) loadLog();
	}

	function expandToActivity() {
		expanded = true;
		switchTab('activity');
	}

	// Reset tab when collapsing
	$effect(() => {
		if (!expanded) {
			activeTab = 'settings';
			logLoaded = false;
			activityLog = [];
		}
	});

	function relativeTime(at: number): string {
		const diff = Date.now() - at;
		const mins = Math.floor(diff / 60_000);
		if (mins < 1) return '剛剛';
		if (mins < 60) return `${mins} 分鐘前`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs} 小時前`;
		const days = Math.floor(hrs / 24);
		if (days < 30) return `${days} 天前`;
		return new Date(at).toLocaleDateString('zh-TW');
	}

	function blockReasonLabel(reason: LogEntry['reason']): string {
		if (!reason) return '已封鎖';
		return ({
			alias_disabled: '別名已停用',
			global_sender_blocked: '全域寄件者封鎖',
			alias_sender_blocked: '別名寄件者封鎖',
			sender_not_in_allowlist: '不在允許清單中',
			alias_expired: '別名已到期',
			forwarding_limit_reached: '已達轉寄上限',
			invalid_sender: 'SMTP 信封寄件者無效'
		} as const)[reason];
	}

	async function handleCreateTag(e: Event) {
		e.preventDefault();
		if (!newTagName.trim()) return;
		creatingTag = true;
		newTagError = '';
		try {
			const res = await fetch('/api/tags', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newTagName.trim(), color: newTagColor })
			});
			const body = await res.json();
			if (res.ok) {
				onTagCreated(body);
				editTags = [...editTags, body.name];
				newTagName = '';
				newTagColor = '#6464D8';
				showNewTagForm = false;
			} else {
				newTagError = body.error ?? '建立標籤失敗';
			}
		} catch {
			newTagError = '網路連線錯誤';
		} finally {
			creatingTag = false;
		}
	}
</script>

<div
	class="rounded-xl border bg-app-surface transition-colors duration-150
		{focused
			? 'border-app-accent/50 ring-1 ring-app-accent/20'
			: expanded
			? 'border-app-hover'
			: 'border-app-border hover:border-app-hover hover:bg-app-hover/40'}"
>
	<!-- ── Collapsed row ─────────────────────────────────────────────────── -->
	<div
		class="group flex cursor-pointer items-center gap-2 px-3 py-3 sm:gap-4 sm:px-4"
		role="button"
		tabindex="0"
		aria-label={selectionMode ? `${selected ? '取消選取' : '選取'} ${fullAddress}` : `${expanded ? '收合' : '編輯'} ${fullAddress}`}
		aria-expanded={selectionMode ? undefined : expanded}
		onclick={(e) => {
			if ((e.target as HTMLElement).closest('button, a, input, textarea, select')) return;
			activateRow();
		}}
		onkeydown={handleRowKeydown}
	>

		<div class="flex min-w-0 flex-1 shrink-0 items-center gap-2 sm:gap-3">
			<!-- Selection checkbox (only in selection mode) -->
			{#if selectionMode}
				<button
					type="button"
					onclick={(e) => { e.stopPropagation(); onSelect?.(!selected); }}
					aria-label="選取 {fullAddress}"
					aria-pressed={selected}
					class="h-5 w-5 shrink-0 rounded border transition-all sm:h-3.5 sm:w-3.5
						{selected
							? 'bg-app-accent border-app-accent flex items-center justify-center'
							: 'border-app-border bg-app-hover hover:border-app-accent/50'}"
				>
					{#if selected}
						<svg class="h-3 w-3 text-app-bg sm:h-2 sm:w-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="3.5" d="M5 13l4 4L19 7" />
						</svg>
					{/if}
				</button>
			{:else if showDomain}
				<span class="hidden sm:inline-flex items-center gap-1.5 px-1 py-1 rounded-lg bg-app-hover text-xs text-app-text/80 shrink-0">
					<span class="w-1.5 h-1.5 rounded-full shrink-0" style="background-color: {color}" aria-hidden="true"></span>
				</span>
			{/if}

			<!-- Address + inline tags + note preview -->
			<div class="flex-1 min-w-0">
				<div class="flex min-w-0 items-center gap-1.5 sm:hidden">
					<span class="truncate text-sm font-semibold text-app-text" title={fullAddress}>{fullAddress}</span>
					<div class="shrink-0">
						<CopyButton text={fullAddress} />
					</div>
				</div>
				<div class="hidden items-center gap-1.5 sm:flex sm:flex-wrap">
					<span class="font-semibold text-app-text text-sm">{alias.localPart}</span>
					<span class="text-app-muted text-sm shrink-0">@{alias.domain}</span>
					<div class="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
						<CopyButton text={fullAddress} />
					</div>
				</div>
				<!-- Note preview (collapsed only) -->
				{#if !expanded && alias.note}
					<p class="text-xs text-app-muted mt-0.5 truncate">{alias.note}</p>
				{/if}
			</div>
		</div>

		<!-- Tag pills — same style as domain badge, visible sm+ -->
		{#if aliasTags.length > 0}
			<div class="flex items-center gap-1.5 shrink-0">
				{#each aliasTags as tag (tag.name)}
					<button
						type="button"
						onclick={(e) => { e.stopPropagation(); onTagClick(tag.name); }}
						class="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-app-hover text-xs text-app-text/80 shrink-0 hover:brightness-110 transition-colors"
					>
						<span class="w-1.5 h-1.5 rounded-full shrink-0" style="background-color: {tag.color}" aria-hidden="true"></span>
						{tag.name}
					</button>
				{/each}
			</div>
		{/if}

		<!-- Auto badge -->
		{#if alias.autoCreated}
			<Tooltip.Root delayDuration={300}>
				<Tooltip.Trigger
					class="hidden sm:inline-flex items-center px-2.5 py-1 rounded-lg bg-app-hover text-xs text-app-muted shrink-0 cursor-default"
					aria-label="自動建立的別名"
				>
					自動
				</Tooltip.Trigger>
				<Tooltip.Portal>
					<Tooltip.Content
						class="z-50 px-2 py-1 rounded-md bg-app-surface border border-app-border text-xs text-app-text shadow-md"
						sideOffset={4}
					>
						首次收到信件時自動建立（萬用字元模式）
						<Tooltip.Arrow class="text-app-border" />
					</Tooltip.Content>
				</Tooltip.Portal>
			</Tooltip.Root>
		{/if}

		<!-- Expiry badge -->
		{#if expiryBadge && !expanded}
			<span
				class="hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs shrink-0
					{expiryBadge.urgency === 'critical'
						? 'bg-red-400/10 text-red-400'
						: expiryBadge.urgency === 'warn'
						? 'bg-amber-400/10 text-amber-400'
						: 'bg-app-hover text-app-muted'}"
			>
				<svg class="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
					<circle cx="12" cy="12" r="9" stroke-width="2" />
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 7v5l3 3" />
				</svg>
				{expiryBadge.label}
			</span>
		{/if}

		<!-- Stats -->
		<div class="hidden md:flex items-center gap-2 shrink-0">
			<Tooltip.Root delayDuration={300}>
				<Tooltip.Trigger
					onclick={(e) => { e.stopPropagation(); expandToActivity(); }}
					class="flex items-center gap-1 text-xs text-app-muted cursor-pointer hover:text-app-text transition-colors"
					aria-label="已封鎖 {alias.blockedCount} 封信件，按一下檢視活動紀錄"
				>
					<svg class="w-3.5 h-3.5 text-red-400/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
						<circle cx="12" cy="12" r="10" stroke-width="2" />
						<path stroke-linecap="round" stroke-width="2" d="M4.93 4.93l14.14 14.14" />
					</svg>
					{alias.blockedCount}
				</Tooltip.Trigger>
				<Tooltip.Portal>
					<Tooltip.Content class="z-50 px-2 py-1 rounded-md bg-app-surface border border-app-border text-xs text-app-text shadow-md" sideOffset={4}>
						已封鎖 {alias.blockedCount} 封，按一下檢視活動紀錄
						<Tooltip.Arrow class="text-app-border" />
					</Tooltip.Content>
				</Tooltip.Portal>
			</Tooltip.Root>

			<Tooltip.Root delayDuration={300}>
				<Tooltip.Trigger
					onclick={(e) => { e.stopPropagation(); expandToActivity(); }}
					class="flex items-center gap-1 text-xs text-app-muted cursor-pointer hover:text-app-text transition-colors"
					aria-label="已轉寄 {alias.forwardedCount} 封信件，按一下檢視活動紀錄"
				>
					<svg class="w-3.5 h-3.5 text-green-400/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
					</svg>
					{alias.forwardedCount}
				</Tooltip.Trigger>
				<Tooltip.Portal>
					<Tooltip.Content class="z-50 px-2 py-1 rounded-md bg-app-surface border border-app-border text-xs text-app-text shadow-md" sideOffset={4}>
						已轉寄 {alias.forwardedCount} 封，按一下檢視活動紀錄
						<Tooltip.Arrow class="text-app-border" />
					</Tooltip.Content>
				</Tooltip.Portal>
			</Tooltip.Root>
		</div>

		<!-- Toggle -->
		<Tooltip.Root delayDuration={300}>
			<Tooltip.Trigger
				onclick={handleToggle}
				disabled={toggling}
				aria-pressed={alias.enabled}
				aria-label={alias.enabled ? '停用別名' : '啟用別名'}
				class="group/toggle -m-2 flex min-w-0 items-center justify-end gap-2 p-2 disabled:opacity-60 sm:m-0 sm:min-w-[5.5rem] sm:p-0"
			>
				<div
					class="w-3 h-3 rounded-full shrink-0 transition-all group-hover/toggle:scale-110 group-hover/toggle:brightness-125
						{alias.enabled ? 'bg-app-accent' : 'bg-red-400/60'}"
				></div>
				<span class="hidden sm:block text-[11px] font-bold tracking-widest shrink-0 {alias.enabled ? 'text-app-accent' : 'text-red-400/80'}">
					{alias.enabled ? '啟用中' : '已停用'}
				</span>
			</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content class="z-50 px-2 py-1 rounded-md bg-app-surface border border-app-border text-xs text-app-text shadow-md" sideOffset={4}>
					{alias.enabled ? '停用別名' : '啟用別名'}
					<Tooltip.Arrow class="text-app-border" />
				</Tooltip.Content>
			</Tooltip.Portal>
		</Tooltip.Root>

		<!-- Expand chevron -->
		<Tooltip.Root delayDuration={300}>
			<Tooltip.Trigger
				onclick={toggleExpand}
				aria-expanded={expanded}
				aria-label={expanded ? '收合' : '編輯別名'}
				class="shrink-0 rounded p-2 transition-colors sm:p-1.5
					{expanded
						? 'text-app-accent bg-app-accent/10'
						: 'text-app-muted/70 hover:text-app-muted hover:bg-app-hover'}"
			>
				<svg
					class="w-3.5 h-3.5 transition-transform duration-200 {expanded ? 'rotate-180' : ''}"
					fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"
				>
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
				</svg>
			</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content class="z-50 px-2 py-1 rounded-md bg-app-surface border border-app-border text-xs text-app-text shadow-md" sideOffset={4}>
					{expanded ? '收合' : '編輯別名'}
					<Tooltip.Arrow class="text-app-border" />
				</Tooltip.Content>
			</Tooltip.Portal>
		</Tooltip.Root>
	</div>

	<!-- ── Expanded panel ────────────────────────────────────────────────── -->
	{#if expanded}
		<div
			transition:slide={{ duration: 220, easing: cubicOut }}
			class="overflow-hidden"
		>
			<!-- Tab bar -->
			<div class="flex border-t border-app-border/50">
				{#each (['settings', 'activity'] as const) as tab}
					<button
						type="button"
						onclick={() => switchTab(tab)}
						class="px-4 py-2.5 text-xs font-medium capitalize transition-colors border-b-2
							{activeTab === tab
								? 'border-app-accent text-app-accent'
								: 'border-transparent text-app-muted hover:text-app-text'}"
					>
						{tab === 'settings' ? '設定' : '活動紀錄'}
					</button>
				{/each}
			</div>

			{#if activeTab === 'settings'}
			<div class="space-y-5 px-3 pb-4 sm:px-4 sm:pb-5">
				<div class="pt-4 space-y-3">

					<!-- Destination override -->
					<div class="space-y-1.5">
						<p class="text-xs font-medium text-app-muted">轉寄至</p>
						<DestinationSelect
							{destinations}
							bind:value={editTargetEmail}
							allowEmpty={true}
							emptyLabel="沿用網域設定（{domainTargetEmail}）"
							placeholder="沿用網域設定…"
						/>
					</div>

					<!-- Note -->
					<div class="space-y-1.5">
						<label for="row-note-{alias.domain}-{alias.localPart}" class="block text-xs font-medium text-app-muted">
							備註
						</label>
						<input
							id="row-note-{alias.domain}-{alias.localPart}"
							type="text"
							bind:value={editNote}
							placeholder="這個別名的用途，例如：註冊 GitHub"
							class="w-full px-3 py-2 rounded-lg border border-app-border bg-app-hover text-sm text-app-text placeholder:text-app-muted/70 focus:outline-none focus:border-app-accent/60 transition-colors"
						/>
					</div>

					<!-- Tags -->
					<div class="space-y-1.5">
						<p class="text-xs font-medium text-app-muted">標籤</p>
						<div class="flex flex-wrap gap-1.5">
							{#each assignableTags as tag (tag.name)}
								{@const active = editTags.includes(tag.name)}
								<button
									type="button"
									onclick={() => toggleTagOnAlias(tag.name)}
									aria-pressed={active}
									class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all"
									style={active
										? `color: ${tag.color}; background-color: ${tag.color}1a; border: 1px solid ${tag.color}55`
										: 'color: var(--color-app-muted); background-color: var(--color-app-hover); border: 1px solid var(--color-app-border)'}
								>
									<span
										class="w-1.5 h-1.5 rounded-full shrink-0 transition-opacity {active ? 'opacity-100' : 'opacity-50'}"
										style="background-color: {tag.color}"
										aria-hidden="true"
									></span>
									{tag.name}
									{#if active}
										<svg class="w-2.5 h-2.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
										</svg>
									{/if}
								</button>
							{/each}

							<!-- New tag toggle -->
							{#if !showNewTagForm}
								<button
									type="button"
									onclick={() => (showNewTagForm = true)}
									class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-app-muted border border-dashed border-app-border hover:border-app-hover hover:text-app-text transition-colors"
								>
									<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4" />
									</svg>
									新增標籤
								</button>
							{/if}
						</div>

						<!-- Inline new tag form -->
						{#if showNewTagForm}
							<form
								onsubmit={handleCreateTag}
								transition:slide={{ duration: 150, easing: cubicOut }}
							class="flex flex-col gap-2 rounded-lg border border-app-border bg-app-bg/40 p-2.5 sm:flex-row sm:items-center"
							>
								<ColorPicker bind:value={newTagColor} />
								<label for="new-tag-{alias.domain}-{alias.localPart}" class="sr-only">標籤名稱</label>
								<input
									id="new-tag-{alias.domain}-{alias.localPart}"
									type="text"
									bind:value={newTagName}
									placeholder="標籤名稱"
									required
									class="flex-1 min-w-0 px-2.5 py-1.5 rounded-md border border-app-border bg-app-hover text-sm text-app-text placeholder:text-app-muted focus:outline-none focus:border-app-accent/60 transition-colors"
								/>
								{#if newTagError}
									<span class="text-xs text-red-400 shrink-0">{newTagError}</span>
								{/if}
							<div class="flex shrink-0 gap-1 self-end sm:self-auto">
									<button
										type="button"
										onclick={() => { showNewTagForm = false; newTagName = ''; newTagError = ''; }}
										class="px-2.5 py-1.5 text-xs text-app-muted hover:text-app-text border border-app-border rounded-md transition-colors"
									>
										取消
									</button>
									<button
										type="submit"
										disabled={creatingTag || !newTagName.trim()}
										class="px-2.5 py-1.5 text-xs font-semibold bg-app-accent text-app-bg rounded-md hover:brightness-110 transition-all disabled:opacity-40"
									>
										{creatingTag ? '…' : '新增'}
									</button>
								</div>
							</form>
						{/if}
					</div>
				</div>

				<!-- Sender filtering -->
				<div class="space-y-3 pt-1 border-t border-app-border/50">
					<div>
						<p class="text-xs font-medium text-app-muted">寄件者篩選</p>
						<p class="text-[11px] text-app-muted/70 mt-0.5">
							規則會比對 SMTP 信封寄件者，且封鎖規則永遠優先套用。
						</p>
					</div>
					<div class="flex gap-1.5 flex-wrap">
						{#each (['normal', 'allowlist'] as const) as mode}
							<button
								type="button"
								onclick={() => (editSenderMode = mode)}
								class="px-2.5 py-1 rounded-md text-xs transition-colors
									{editSenderMode === mode
										? 'bg-app-accent text-app-bg font-medium'
										: 'bg-app-hover text-app-muted hover:text-app-text border border-app-border'}"
							>
								{mode === 'normal' ? '一般模式' : '僅允許清單'}
							</button>
						{/each}
						<span class="self-center text-[11px] text-app-muted/70">
							{editSenderMode === 'normal'
								? '接受所有未被封鎖規則比對到的寄件者。'
								: '只接受符合允許規則的寄件者。'}
						</span>
					</div>
					<div class="grid gap-3 md:grid-cols-2">
						<label class="space-y-1.5">
							<span class="block text-xs font-medium text-app-muted">允許的地址</span>
							<textarea
								bind:value={editAllowedSenderAddresses}
								rows="3"
								spellcheck="false"
								placeholder="orders@example.com"
								class="w-full resize-y px-3 py-2 rounded-lg border border-app-border bg-app-hover font-mono text-xs text-app-text placeholder:text-app-muted/70 focus:outline-none focus:border-app-accent/60 transition-colors"
							></textarea>
						</label>
						<label class="space-y-1.5">
							<span class="block text-xs font-medium text-app-muted">允許的網域</span>
							<textarea
								bind:value={editAllowedSenderDomains}
								rows="3"
								spellcheck="false"
								placeholder="example.com"
								class="w-full resize-y px-3 py-2 rounded-lg border border-app-border bg-app-hover font-mono text-xs text-app-text placeholder:text-app-muted/70 focus:outline-none focus:border-app-accent/60 transition-colors"
							></textarea>
						</label>
						<label class="space-y-1.5">
							<span class="block text-xs font-medium text-app-muted">封鎖的地址</span>
							<textarea
								bind:value={editBlockedSenderAddresses}
								rows="3"
								spellcheck="false"
								placeholder="spam@example.com"
								class="w-full resize-y px-3 py-2 rounded-lg border border-app-border bg-app-hover font-mono text-xs text-app-text placeholder:text-app-muted/70 focus:outline-none focus:border-app-accent/60 transition-colors"
							></textarea>
						</label>
						<label class="space-y-1.5">
							<span class="block text-xs font-medium text-app-muted">封鎖的網域</span>
							<textarea
								bind:value={editBlockedSenderDomains}
								rows="3"
								spellcheck="false"
								placeholder="spam.example"
								class="w-full resize-y px-3 py-2 rounded-lg border border-app-border bg-app-hover font-mono text-xs text-app-text placeholder:text-app-muted/70 focus:outline-none focus:border-app-accent/60 transition-colors"
							></textarea>
						</label>
					</div>
					<p class="text-[11px] text-app-muted/70">
						每行填寫一個完整地址或網域；網域規則也會比對其子網域。
						若要封鎖所有信件，請使用上方的別名開關。
					</p>
				</div>

				<!-- Auto-disable -->
				<div class="space-y-1.5">
					<p class="text-xs font-medium text-app-muted">自動停用</p>
					<div class="flex gap-1.5 flex-wrap">
						{#each (['none', 'date', 'count'] as const) as mode (mode)}
							{@const label = mode === 'none' ? '永不' : mode === 'date' ? '指定日期後' : '指定信件數後'}
							<button
								type="button"
								onclick={() => { expiryMode = mode; }}
								class="px-2.5 py-1 rounded-md text-xs transition-colors
									{expiryMode === mode
										? 'bg-app-accent text-app-bg font-medium'
										: 'bg-app-hover text-app-muted hover:text-app-text border border-app-border'}"
							>
								{label}
							</button>
						{/each}
					</div>
					{#if expiryMode === 'date'}
						<div class="flex items-center gap-2 flex-wrap">
							<input
								type="date"
								value={tsToDateInput(editExpiresAt)}
								onchange={(e) => (editExpiresAt = dateInputToTs(e.currentTarget.value))}
								min={new Date().toISOString().slice(0, 10)}
								class="px-3 py-1.5 rounded-lg border border-app-border bg-app-hover text-sm text-app-text focus:outline-none focus:border-app-accent/60 transition-colors [color-scheme:dark]"
							/>
							{#if expiryBadge}
								<span class="text-xs {expiryBadge.urgency === 'critical' ? 'text-red-400' : expiryBadge.urgency === 'warn' ? 'text-amber-400' : 'text-app-muted'}">{expiryBadge.label}</span>
							{/if}
						</div>
					{:else if expiryMode === 'count'}
						<div class="flex items-center gap-2 flex-wrap">
							<input
								type="number"
								value={editMaxForwards ?? ''}
								oninput={(e) => { const v = parseInt(e.currentTarget.value, 10); editMaxForwards = isNaN(v) || v < 1 ? null : v; }}
								min="1"
								placeholder="例如 10"
								class="w-24 px-3 py-1.5 rounded-lg border border-app-border bg-app-hover text-sm text-app-text placeholder:text-app-muted/70 focus:outline-none focus:border-app-accent/60 transition-colors"
							/>
							<span class="text-xs text-app-muted">封信後停用</span>
							{#if expiryBadge}
								<span class="text-xs {expiryBadge.urgency === 'critical' ? 'text-red-400' : expiryBadge.urgency === 'warn' ? 'text-amber-400' : 'text-app-muted'}">{expiryBadge.label}</span>
							{/if}
						</div>
					{/if}
				</div>

				<!-- Stats -->
				<div class="grid grid-cols-2 gap-2 border-t border-app-border/50 pt-1 sm:grid-cols-3">
					<div class="col-span-2 rounded-lg bg-app-hover/60 p-2.5 pt-3 sm:col-span-1">
						<div class="text-[11px] text-app-muted mb-1">已轉寄</div>
						<div class="text-base font-bold text-app-text">{alias.forwardedCount}</div>
					</div>
					<div class="bg-app-hover/60 rounded-lg p-2.5 pt-3">
						<div class="text-[11px] text-app-muted mb-1">已封鎖</div>
						<div class="text-base font-bold text-app-text">{alias.blockedCount}</div>
					</div>
					<div class="bg-app-hover/60 rounded-lg p-2.5 pt-3">
						<div class="text-[11px] text-app-muted mb-1">最近使用</div>
						<div class="text-xs font-medium text-app-text leading-tight mt-0.5">
							{alias.lastUsedAt ? new Date(alias.lastUsedAt).toLocaleDateString('zh-TW') : '—'}
						</div>
					</div>
				</div>

				<!-- Footer: delete + save -->
				<div class="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
					<!-- Delete -->
					<AlertDialog.Root>
						<AlertDialog.Trigger
							type="button"
							disabled={deleting}
							class="w-full rounded-lg border border-red-400/20 px-3 py-2 text-xs text-red-400/80 transition-colors hover:border-red-400/50 hover:text-red-400 disabled:opacity-40 sm:w-auto sm:py-1.5"
						>
							{deleting ? '刪除中…' : '刪除地址'}
						</AlertDialog.Trigger>
						<AlertDialog.Portal>
							<AlertDialog.Overlay class="fixed inset-0 bg-black/65 backdrop-blur-sm z-40" />
							<AlertDialog.Content class="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-app-border bg-app-surface p-5 text-app-text shadow-2xl focus:outline-none sm:p-6">
								<AlertDialog.Title class="font-semibold text-app-text mb-1">要刪除地址嗎？</AlertDialog.Title>
								<AlertDialog.Description class="text-sm text-app-muted mb-5">
									<span class="font-mono text-app-text">{fullAddress}</span> 將會永久刪除。
								</AlertDialog.Description>
								<div class="flex justify-end gap-2">
									<AlertDialog.Cancel class="px-4 py-2 text-sm text-app-muted hover:text-app-text border border-app-border hover:border-app-hover rounded-lg transition-colors">
										取消
									</AlertDialog.Cancel>
									<AlertDialog.Action
										onclick={handleDelete}
										class="px-4 py-2 text-sm font-semibold bg-red-500 hover:bg-red-400 text-white rounded-lg transition-colors"
									>
										刪除
									</AlertDialog.Action>
								</div>
							</AlertDialog.Content>
						</AlertDialog.Portal>
					</AlertDialog.Root>

					<!-- Save / error -->
					<div class="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
						{#if saveError}
							<span class="text-xs text-red-400">{saveError}</span>
						{/if}
						{#if dirty}
							<button
								type="button"
								onclick={() => {
									editTargetEmail = alias.targetEmail ?? '';
					editNote = alias.note ?? '';
					editTags = [...(alias.tags ?? [])];
					resetSenderRuleFields();
					saveError = '';
								}}
								class="px-3 py-1.5 text-xs text-app-muted hover:text-app-text border border-app-border hover:border-app-hover rounded-lg transition-colors"
							>
								捨棄變更
							</button>
							<button
								type="button"
								onclick={saveChanges}
								disabled={saving}
								aria-busy={saving}
								class="px-3 py-1.5 text-xs font-semibold bg-app-accent text-app-bg rounded-lg hover:brightness-110 transition-all disabled:opacity-40"
							>
								{saving ? '儲存中…' : '儲存變更'}
							</button>
						{/if}
					</div>
				</div>
			</div>
			{:else}
			<!-- ── Activity tab ──────────────────────────────────────────────── -->
			<div class="px-4 py-4">
				{#if logLoading}
					<div class="flex items-center justify-center py-10 text-app-muted">
						<svg class="w-4 h-4 animate-spin mr-2" fill="none" viewBox="0 0 24 24" aria-hidden="true">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
						</svg>
						<span class="text-xs">載入中…</span>
					</div>
				{:else if logError}
					<p class="text-xs text-red-400 text-center py-6">{logError}</p>
				{:else if activityLog.length === 0}
					<div class="text-center py-10">
						<p class="text-xs text-app-muted">目前尚無活動紀錄。</p>
						<p class="text-xs text-app-muted/70 mt-1">收到電子郵件後，相關事件會顯示在這裡。</p>
					</div>
				{:else}
					<ol class="space-y-1" aria-label="近期活動紀錄">
						{#each activityLog as entry, i (i)}
							<li class="flex items-start gap-1.5 py-2 {i !== activityLog.length - 1 ? 'border-b border-app-border/40' : ''}">
								<span
									class="mt-[0.3rem] w-1.5 h-1.5 rounded-full shrink-0 {entry.action === 'forwarded' ? 'bg-green-400' : 'bg-red-400'}"
									aria-label={entry.action === 'forwarded' ? '已轉寄' : '已封鎖'}
								></span>
								<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span class="text-xs font-medium {entry.action === 'forwarded' ? 'text-green-400' : 'text-red-400'}">
										{entry.action === 'blocked' ? blockReasonLabel(entry.reason) : '已轉寄'}
									</span>
									<span class="text-xs text-app-muted truncate" title={entry.from || undefined}>
										寄件者：{entry.from || '（無效的寄件者）'}
									</span>
								</div>
								{#if entry.subject}
									<p class="text-xs text-app-text/80 truncate" title={entry.subject}>{entry.subject}</p>
								{/if}
								<p class="text-xs text-app-muted/70 truncate" title={entry.to}>→ {entry.to}</p>
								{#if entry.action === 'blocked' && entry.matchedRule}
									<p class="text-[11px] text-app-muted/70 truncate" title={entry.matchedRule}>
										符合 {entry.matchedRule}
									</p>
								{/if}
								</div>
								<time
									datetime={new Date(entry.at).toISOString()}
									title={new Date(entry.at).toLocaleString('zh-TW')}
									class="text-[11px] text-app-muted/70 shrink-0 tabular-nums"
								>
									{relativeTime(entry.at)}
								</time>
							</li>
						{/each}
					</ol>
					<!-- <p class="text-[11px] text-app-muted/40 text-center mt-3">Last {activityLog.length} event{activityLog.length === 1 ? '' : 's'}</p> -->
				{/if}
			</div>
			{/if}
		</div>
	{/if}
</div>
