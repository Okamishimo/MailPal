import type { KVNamespace } from '@cloudflare/workers-types';

declare global {
	namespace App {
		interface Platform {
			env: {
				KV: KVNamespace;
				AUTH_PASSWORD?: string;
				DEMO_MODE?: string;
				/** Optional dedicated secret for sealing session cookies; falls back to AUTH_PASSWORD. */
				SESSION_SECRET?: string;
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
			authMode: 'password' | 'cloudflare-access';
			authenticated: boolean;
			demo?: boolean;
		}
		interface Error {}
		interface PageData {}
	}
}

export {};
