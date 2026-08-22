<script lang="ts">
	import type { PageData } from './$types';
	import type { LogEntry } from '$lib/types.js';
	import DemoBanner from '$lib/components/DemoBanner.svelte';

	let { data }: { data: PageData } = $props();

	let filter = $state<'all' | 'forwarded' | 'blocked'>('all');

	const entries = $derived(
		filter === 'all' ? data.entries : data.entries.filter((e) => e.action === filter)
	);

	const forwardedCount = $derived(data.entries.filter((e) => e.action === 'forwarded').length);
	const blockedCount = $derived(data.entries.filter((e) => e.action === 'blocked').length);

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
</script>

<svelte:head>
	<title>活動紀錄 — MailPal</title>
</svelte:head>

{#if data.demo}
	<DemoBanner />
{/if}

<div class="min-h-screen bg-app-bg text-app-text">
	<div class="max-w-3xl mx-auto px-6 py-10 space-y-6">

		<!-- Header -->
		<div class="flex items-center gap-4">
			<a
				href="/"
				class="p-1.5 rounded-lg text-app-muted hover:text-app-text hover:bg-app-hover transition-colors"
				aria-label="返回首頁"
			>
				<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
				</svg>
			</a>
			<div>
				<h1 class="text-lg font-bold">活動紀錄</h1>
				<p class="text-sm text-app-muted">所有地址最近的電子郵件事件</p>
			</div>
		</div>

		<!-- Summary + filter -->
		<div class="flex items-center gap-2 flex-wrap">
			{#each ([
				{ value: 'all', label: '全部', count: data.entries.length },
				{ value: 'forwarded', label: '已轉寄', count: forwardedCount },
				{ value: 'blocked', label: '已封鎖', count: blockedCount },
			] as const) as opt}
				<button
					type="button"
					onclick={() => (filter = opt.value)}
					class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs transition-colors
						{filter === opt.value
							? 'border-app-hover bg-app-hover text-app-text font-medium'
							: 'border-app-border text-app-muted hover:border-app-hover hover:text-app-text'}"
				>
					{#if opt.value === 'forwarded'}
						<span class="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" aria-hidden="true"></span>
					{:else if opt.value === 'blocked'}
						<span class="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" aria-hidden="true"></span>
					{/if}
					{opt.label}
					<span class="tabular-nums text-app-muted/70">{opt.count}</span>
				</button>
			{/each}
		</div>

		<!-- Log -->
		{#if entries.length === 0}
			<div class="text-center py-20 rounded-xl border border-app-border bg-app-surface/40">
				<svg class="w-10 h-10 mx-auto text-app-muted/40 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
				</svg>
				<p class="text-sm text-app-muted">目前尚無活動紀錄。</p>
				<p class="text-xs text-app-muted/70 mt-1">收到電子郵件後，相關事件會顯示在這裡。</p>
			</div>
		{:else}
			<ol class="space-y-2" aria-label="活動紀錄">
				{#each entries as entry (`${entry.domain}/${entry.localPart}/${entry.at}`)}
					<li class="flex items-start gap-3 px-4 py-3 rounded-xl border border-app-border bg-app-surface hover:border-app-hover transition-colors">
						<!-- Action dot -->
						<span
							class="mt-[0.4rem] w-2 h-2 rounded-full shrink-0 {entry.action === 'forwarded' ? 'bg-green-400' : 'bg-red-400'}"
							aria-label={entry.action === 'forwarded' ? '已轉寄' : '已封鎖'}
						></span>

						<!-- Main content -->
						<div class="flex-1 min-w-0 space-y-0.5">
							<div class="flex items-center gap-2 flex-wrap">
								<span class="font-mono text-sm text-app-text">{entry.localPart}@{entry.domain}</span>
								<span class="text-xs px-1.5 py-0.5 rounded font-medium
									{entry.action === 'forwarded'
										? 'bg-green-400/10 text-green-400'
										: 'bg-red-400/10 text-red-400'}">
									{entry.action === 'blocked' ? blockReasonLabel(entry.reason) : entry.action}
								</span>
							</div>
							{#if entry.subject}
								<p class="text-sm text-app-text/90 truncate" title={entry.subject}>{entry.subject}</p>
							{/if}
							<div class="flex items-center gap-3 text-xs text-app-muted flex-wrap">
								<span class="truncate" title={entry.from || undefined}>寄件者：{entry.from || '（無效的寄件者）'}</span>
								<span class="shrink-0">→</span>
								<span class="truncate" title={entry.to}>{entry.to}</span>
							</div>
							{#if entry.action === 'blocked' && entry.matchedRule}
								<p class="text-[11px] text-app-muted/70 truncate" title={entry.matchedRule}>
									符合的規則：{entry.matchedRule}
								</p>
							{/if}
						</div>

						<!-- Timestamp -->
						<time
							datetime={new Date(entry.at).toISOString()}
							title={new Date(entry.at).toLocaleString('zh-TW')}
							class="text-xs text-app-muted/70 shrink-0 tabular-nums"
						>
							{relativeTime(entry.at)}
						</time>
					</li>
				{/each}
			</ol>
			<p class="text-center text-xs text-app-muted/70 pt-2">
				顯示最近 {entries.length} 筆事件
				{#if filter !== 'all'}（{filter === 'forwarded' ? '已轉寄' : '已封鎖'}）{/if}。
				每個別名最多保留 50 筆事件。
			</p>
		{/if}
	</div>
</div>
