import type { D1Database, KVNamespace } from '@cloudflare/workers-types';

declare global {
	namespace App {
		interface Platform {
			env: {
				KV: KVNamespace;
				/**
				 * Activity log database. Optional: without it the dashboard reads and
				 * writes the legacy `log:` KV ring buffer instead. See wrangler.jsonc.
				 */
				DB?: D1Database;
				AUTH_PASSWORD?: string;
				DEMO_MODE?: string;
				/** Optional dedicated secret for sealing session cookies; falls back to AUTH_PASSWORD. */
				SESSION_SECRET?: string;
				/** Bearer token for automation (e.g. Apple Shortcuts). Grants access to /api/ routes only. */
				API_TOKEN?: string;
				/** e.g. "myteam.cloudflareaccess.com" — enables Access JWT verification when set with CF_ACCESS_AUD. */
				CF_ACCESS_TEAM_DOMAIN?: string;
				/** The Access application AUD tag — enables Access JWT verification when set with CF_ACCESS_TEAM_DOMAIN. */
				CF_ACCESS_AUD?: string;
			};
			context: {
				waitUntil(promise: Promise<unknown>): void;
			};
			caches: CacheStorage & { default: Cache };
		}
		interface Locals {
			kv: KVNamespace;
			/** Absent in demo mode and whenever the `DB` binding is not configured. */
			db?: D1Database;
			authMode: 'password' | 'cloudflare-access';
			authenticated: boolean;
			apiTokenAuthenticated?: boolean;
			demo?: boolean;
		}
		interface Error {}
		interface PageData {}
	}
}

export {};
