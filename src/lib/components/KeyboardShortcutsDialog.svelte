<script lang="ts">
	let { show, onClose }: { show: boolean; onClose: () => void } = $props();

	const SHORTCUTS: [string, string][] = [
		['/', '移至搜尋欄'],
		['c', '移至快速建立'],
		['j / k', '瀏覽別名清單'],
		['s', '展開或收合目前別名'],
		['e', '啟用目前別名'],
		['d', '停用目前別名'],
		['t', '切換啟用或停用'],
		['Backspace', '刪除目前別名'],
		['x', '選取或取消目前別名'],
		['Escape', '清除或關閉'],
		['?', '顯示這份說明'],
	];
</script>

{#if show}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 bg-black/65 backdrop-blur-sm z-50 flex items-center justify-center"
		onclick={onClose}
	>
		<div
			class="rounded-2xl border border-app-border bg-app-surface shadow-2xl w-full max-w-sm p-6 text-app-text"
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			aria-label="鍵盤快速鍵"
			tabindex="-1"
		>
			<div class="flex items-center justify-between mb-4">
				<h2 class="font-semibold text-base">鍵盤快速鍵</h2>
				<button
					onclick={onClose}
					class="p-1 rounded text-app-muted hover:text-app-text hover:bg-app-hover transition-colors"
					aria-label="關閉"
				>
					<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>
			<dl class="space-y-2.5">
				{#each SHORTCUTS as [key, desc]}
					<div class="flex items-center justify-between gap-4">
						<dt class="text-sm text-app-muted">{desc}</dt>
						<dd>
							{#each key.split(' / ') as k, i}
								<kbd class="inline-flex items-center px-1.5 py-0.5 rounded border border-app-border bg-app-hover text-xs font-mono text-app-text">{k}</kbd>
								{#if i < key.split(' / ').length - 1}<span class="text-app-muted text-xs mx-0.5">/</span>{/if}
							{/each}
						</dd>
					</div>
				{/each}
			</dl>
		</div>
	</div>
{/if}
