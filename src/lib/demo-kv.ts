import { buildDemoKVData } from './demo-data.js';

// Minimal subset of the KVNamespace interface that this app actually uses.
// All unused methods throw a clear error so accidental calls surface immediately.
interface MinimalKVNamespace {
	get(key: string): Promise<string | null>;
	get(keys: string[]): Promise<Map<string, string | null>>;
	put(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
	list(options: { prefix?: string; cursor?: string; limit?: number }): Promise<
		| { keys: { name: string }[]; list_complete: false; cursor: string }
		| { keys: { name: string }[]; list_complete: true }
	>;
}

/**
 * Serialised delta from the default seed state.
 * A string value means the key was set/updated; null means the key was deleted.
 */
export type DemoDelta = Record<string, string | null>;

export class DemoKV implements MinimalKVNamespace {
	private readonly store: Map<string, string>;
	private readonly mutations: Map<string, string | null>;

	constructor(savedDelta?: DemoDelta) {
		this.store = buildDemoKVData();
		this.mutations = new Map();

		if (savedDelta) {
			for (const [key, value] of Object.entries(savedDelta)) {
				if (value === null) {
					this.store.delete(key);
				} else {
					this.store.set(key, value);
				}
				this.mutations.set(key, value);
			}
		}
	}

	async get(key: string): Promise<string | null>;
	async get(keys: string[]): Promise<Map<string, string | null>>;
	async get(keyOrKeys: string | string[]): Promise<string | null | Map<string, string | null>> {
		if (Array.isArray(keyOrKeys)) {
			return new Map(keyOrKeys.map((key) => [key, this.store.get(key) ?? null]));
		}
		return this.store.get(keyOrKeys) ?? null;
	}

	async put(key: string, value: string): Promise<void> {
		this.store.set(key, value);
		this.mutations.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key);
		this.mutations.set(key, null);
	}

	async list(options: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<
		| { keys: { name: string }[]; list_complete: false; cursor: string }
		| { keys: { name: string }[]; list_complete: true }
	> {
		const prefix = options.prefix ?? '';
		const all = [...this.store.keys()]
			.filter((k) => k.startsWith(prefix))
			.sort();
		const start = options.cursor ? Number(options.cursor) : 0;
		const page = all.slice(start, start + (options.limit ?? 1000));
		const end = start + page.length;
		const keys = page.map((name) => ({ name }));
		return end < all.length
			? { keys, list_complete: false, cursor: String(end) }
			: { keys, list_complete: true };
	}

	/**
	 * Returns the complete accumulated delta from the default seed state
	 * (all keys loaded from a saved delta plus any new mutations this request).
	 * Safe to serialise and store in a cookie for the next request.
	 */
	getDelta(): DemoDelta {
		return Object.fromEntries(this.mutations);
	}
}
