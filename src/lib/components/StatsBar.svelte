<script lang="ts">
	import type { AliasConfig } from '$lib/types.js';

	let { aliases }: { aliases: AliasConfig[] } = $props();

	const totalAliases = $derived(aliases.length);
	const activeAliases = $derived(aliases.filter((a) => a.enabled).length);
	const totalForwarded = $derived(aliases.reduce((s, a) => s + a.forwardedCount, 0));
	const totalBlocked = $derived(aliases.reduce((s, a) => s + a.blockedCount, 0));

	function fmt(n: number): string {
		return new Intl.NumberFormat('zh-TW', {
			notation: n >= 1_000 ? 'compact' : 'standard',
			maximumFractionDigits: 1
		}).format(n);
	}

	const stats = $derived([
		{ label: '總計', value: fmt(totalAliases), title: totalAliases.toLocaleString('zh-TW') },
		{ label: '啟用中', value: fmt(activeAliases), title: activeAliases.toLocaleString('zh-TW') },
		{ label: '已轉寄', value: fmt(totalForwarded), title: totalForwarded.toLocaleString('zh-TW') },
		{ label: '已封鎖', value: fmt(totalBlocked), title: totalBlocked.toLocaleString('zh-TW') },
	]);
</script>

<dl
	class="grid grid-cols-4 divide-x divide-app-border rounded-xl border border-app-border bg-app-surface overflow-hidden"
	aria-label="總覽統計資料"
>
	{#each stats as stat (stat.label)}
		<div class="px-4 py-3 flex items-center justify-start gap-2">
			<dd class="text-lg font-bold text-app-text tabular-nums leading-tight" title={stat.title}>{stat.value}</dd>
			<dt class="text-[11px] text-app-muted uppercase tracking-wide leading-none">{stat.label}</dt>
		</div>
	{/each}
</dl>
