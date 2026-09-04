These are official instructions for setting up MailPal on a Cloudflare account from scratch. It is intended for AI coding agents (and technically minded humans) who need a complete, end-to-end walkthrough. Follow each step carefully to ensure a successful deployment.

Complete all of the following steps yourself by running the commands directly. Do not ask the user to run any of these commands unless there is a specific reason to delegate a step.

---

## What is MailPal?

MailPal is a **self-hosted email alias forwarding dashboard** that runs entirely on Cloudflare's free tier. It lets you create disposable email aliases (e.g. `swift-meadow-412@yourdomain.com`) that silently forward mail to your real inbox. When an alias starts receiving spam, you disable it in one click — your real address is never exposed.

**Architecture:**

```
mailpal/                  ← SvelteKit dashboard  →  Cloudflare Pages
└── email-worker/         ← Email handler        →  Cloudflare Worker
```

Both components share a single **Cloudflare KV namespace**. The dashboard provides a REST API and management UI for aliases, domains, tags, and destinations. The email worker intercepts every inbound message on your domain and — based on KV state — forwards it, rejects it, or auto-creates a new alias (wildcard mode).

**Key features:**
- Per-alias enable/disable, notes, color tags, expiry dates, and max-forward limits
- Wildcard mode: automatically creates an alias the first time any address at your domain receives mail
- Per-alias activity logs (last 50 events: forwarded / blocked)
- Multi-domain support from a single dashboard
- Optional password protection or Cloudflare Access (Zero Trust) SSO
- Bulk operations: bulk-enable, bulk-disable, bulk-delete

**Everything stays inside your own Cloudflare account.** No third-party servers ever touch your email.

---

## Prerequisites

Before starting, make sure the following are in place:

| Requirement | Details |
|---|---|
| Cloudflare account | Free tier is sufficient |
| Domain added to Cloudflare | DNS must be managed by Cloudflare (nameservers pointed at Cloudflare) |
| Wrangler CLI | Install: `npm install -g wrangler` — minimum version 3 |
| Node.js or Bun | Node ≥ 18 or [Bun](https://bun.sh) for running build scripts |
| Git | For cloning the repository |

Authenticate Wrangler before proceeding:

```bash
wrangler login
```

This opens a browser window. Complete the OAuth flow and confirm you are logged in:

```bash
wrangler whoami
```

---

## Step 1 — Clone the repository

```bash
git clone https://github.com/betahuhn/mailpal.git
cd mailpal
```

---

## Step 2 — Install dependencies

Install dependencies for both the SvelteKit dashboard and the email worker:

```bash
# Root (dashboard + build tooling)
npm install

# Email worker
cd email-worker && npm install && cd ..
```

If you prefer Bun:

```bash
bun install
cd email-worker && bun install && cd ..
```

---

## Step 3 — Create a Cloudflare KV namespace

Both the dashboard and the email worker read and write to the same KV namespace. Create it once:

```bash
wrangler kv namespace create mailpal
```

Wrangler prints a TOML snippet like:

```
{ binding = "KV", id = "a1b2c3d4e5f6..." }
```

**Copy the `id` value** — you will need it in the next step. The ID is a 32-character hexadecimal string.

If a namespace with that name already exists, list all namespaces to find the correct ID:

```bash
wrangler kv namespace list
```

---

## Step 4 — Create a D1 database for the activity log (recommended)

The activity log lives in a D1 database. Without one MailPal falls back to
storing it in KV, which works but costs a second KV write for every message it
handles — and the Workers Free plan allows 1,000 KV writes a day, so that
fallback caps the service at roughly 500 messages a day. A D1 insert needs no
prior read, and the free plan allows 100,000 row writes a day.

```bash
wrangler d1 create mailpal
```

Wrangler prints a snippet containing a `database_id` — a UUID like
`cf1f2511-4cc8-4d3d-a3f6-189fb278987f`. **Copy it**, the way you copied the KV
namespace ID. To find the ID of a database that already exists:

```bash
wrangler d1 list
```

Then create the schema:

```bash
wrangler d1 migrations apply mailpal --remote
```

The migrations live in `migrations/` in the repository, which is where Wrangler
looks by default. Omit `--remote` to apply them to the local development
database instead.

> **Skipping this step is safe.** Leave the `[[d1_databases]]` blocks out of both
> config files in the next step and everything keeps working against KV. You can
> add the database later — see *Moving an existing activity log into D1* below.

---

## Step 5 — Create the Wrangler configuration files

Two `wrangler.toml` files must be created — one for the Pages project and one for the email worker. Both must reference the **same KV namespace ID** from Step 3, and the **same D1 database ID** from Step 4.

### `wrangler.toml` (repository root — for the dashboard)

Create this file at the root of the cloned repository:

```toml
name = "mailpal"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]
pages_build_output_dir = ".svelte-kit/cloudflare"

[[kv_namespaces]]
binding = "KV"
id = "YOUR_KV_NAMESPACE_ID"

# Omit this block to keep the activity log in KV.
[[d1_databases]]
binding = "DB"
database_name = "mailpal"
database_id = "YOUR_D1_DATABASE_ID"
```

Replace `YOUR_KV_NAMESPACE_ID` with the ID from Step 3, and
`YOUR_D1_DATABASE_ID` with the one from Step 4.

### `email-worker/wrangler.toml` (for the email worker)

The `email-worker/` directory already contains a `wrangler.toml`. Update the `id` field inside `[[kv_namespaces]]` to match the same namespace ID:

```toml
name = "mailpal-email-worker"
main = "src/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "KV"
id = "YOUR_KV_NAMESPACE_ID"

# Omit this block to keep the activity log in KV.
[[d1_databases]]
binding = "DB"
database_name = "mailpal"
database_id = "YOUR_D1_DATABASE_ID"
```

**Critical:** Both files must have the identical `id` and `database_id` values. If they differ, the dashboard and the email worker will operate on separate, disconnected stores — the dashboard would show an activity log the worker never writes to.

---

## Step 6 — Deploy the email worker

From inside the `email-worker/` directory:

```bash
cd email-worker
wrangler deploy
cd ..
```

On success, Wrangler prints the worker name (`mailpal-email-worker`) and a `workers.dev` URL. Note the worker name — it is needed when configuring Email Routing.

---

## Step 7 — Configure Cloudflare Email Routing

Email Routing is the Cloudflare feature that intercepts inbound mail for your domain and hands it to a Worker.

1. Open the **Cloudflare dashboard** → select your domain → **Email** → **Email Routing**
2. Click **Get started** (or **Enable Email Routing** if shown). Cloudflare will offer to automatically update your domain's MX records — accept this.
3. Wait for the MX records to propagate (typically instant within Cloudflare's DNS).
4. Navigate to the **Routing rules** tab.
5. Add a **catch-all** rule:
   - **Expression**: Catch-all address
   - **Action**: Send to a Worker
   - **Worker**: `mailpal-email-worker`
6. Save the rule.

> Any email sent to `*@yourdomain.com` will now be handled by MailPal's email worker.

---

## Step 8 — Build and deploy the dashboard

From the repository root:

```bash
# Build the SvelteKit app for Cloudflare Pages
npm run build

# Deploy to Cloudflare Pages
wrangler pages deploy
```

On the first deploy, Wrangler creates a new Pages project named `mailpal` and prints a `*.pages.dev` URL — for example `https://mailpal-abc123.pages.dev`. This is the dashboard URL.

Subsequent deploys update the same project in-place.

---

## Step 9 — Set a login password (optional but recommended)

Without a password the dashboard is publicly accessible to anyone who knows the URL. Set a Pages secret to enable password authentication:

```bash
wrangler pages secret put AUTH_PASSWORD
# Wrangler will prompt for the value — type the password and press Enter
```

When `AUTH_PASSWORD` is set, the dashboard shows a login form. Sessions are HMAC-signed cookies; there is no server-side session store.

Skip this step if you plan to use Cloudflare Access (Zero Trust) instead — see Step 10.

---

## Step 10 — Protect with Cloudflare Access (optional alternative to password)

Cloudflare Access is an SSO layer that restricts who can open the dashboard URL, without requiring a password inside the app.

1. Open **Cloudflare dashboard → Zero Trust → Access → Applications**
2. Click **Add an application → Self-hosted**
3. Set **Application domain** to your dashboard URL (e.g. `mailpal.yourdomain.com` or the `*.pages.dev` URL)
4. Configure an identity provider and a policy — for example, allow only your email address
5. Leave `AUTH_PASSWORD` **unset** — MailPal detects the missing secret and trusts Cloudflare Access headers automatically

---

## API access for automation (Apple Shortcuts, scripts)

The dashboard's REST API can be driven by automation clients that cannot perform
the cookie-based login flow (e.g. Apple Shortcuts). Set a dedicated bearer token:

```bash
wrangler pages secret put API_TOKEN
# Use a long random value, e.g. the output of: openssl rand -hex 32
```

Requests that send `Authorization: Bearer <API_TOKEN>` are then authorized for
**`/api/` routes only** — the token never grants access to the HTML dashboard,
so a leaked token cannot be used to browse your aliases in a browser. This works
independently of `AUTH_PASSWORD`/Cloudflare Access, which continue to protect the
dashboard UI as before.

Example — create an alias (omit `localPart` to auto-generate one):

```bash
curl -X POST "https://mail.yourdomain.com/api/domains/yourdomain.com/aliases" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tags":["shopping"]}'
```

The response is `201` with the created alias; `localPart@domain` is the new
address. In Apple Shortcuts, use **Get Contents of URL** → `POST`, add the two
headers above, and set the request body to JSON.

> Treat `API_TOKEN` like a password. To revoke it, set a new value (or `wrangler
> pages secret delete API_TOKEN` to turn the feature off entirely).

---

## Step 11 — Add a custom domain to the Pages project (optional)

By default the dashboard is reachable at a `*.pages.dev` URL. To use a vanity URL:

1. Open **Cloudflare dashboard → Workers & Pages → mailpal → Custom domains**
2. Click **Set up a custom domain**
3. Enter the subdomain you want (e.g. `mail.yourdomain.com`)
4. Cloudflare automatically creates the DNS record

---

## Step 12 — Complete onboarding in the dashboard

Open the dashboard URL in a browser. The onboarding wizard guides you through:

1. **Adding your first domain** — enter the domain name (must already have Email Routing enabled and the catch-all rule pointing to `mailpal-email-worker`)
2. **Setting a default target address** — the real inbox where all aliases forward by default. This must be a verified destination address. Cloudflare will send a verification email to it; click the link to confirm.
3. **Creating your first alias** — use the Quick Create form or let MailPal generate a random slug

After onboarding, you can add more domains via the sidebar **+** button.

---

## Environment variables reference

| Variable | Where | Required | Description |
|---|---|---|---|
| `AUTH_PASSWORD` | Pages secret (`wrangler pages secret put`) | No | Enables dashboard password login. Omit to skip password auth. |
| `API_TOKEN` | Pages secret (`wrangler pages secret put`) | No | Bearer token for automation (e.g. Apple Shortcuts). Authorizes `/api/` routes only. |
| `KV` | `wrangler.toml` binding | Yes | KV namespace shared between the dashboard and the email worker. |
| `DB` | `wrangler.toml` binding | No | D1 database holding the activity log, shared between the dashboard and the email worker. Omit it to keep the log in KV. |
| `DEMO_MODE` | Pages variable | No | Set to `1` to enable read-only demo mode with seed data (no real KV writes). |

---

## KV data schema reference

The following keys are stored in the shared KV namespace:

| Key pattern | Value type | Description |
|---|---|---|
| `domain:{domain}` | `DomainConfig` JSON | Domain settings (target email, wildcard mode, enabled flag) |
| `alias:{domain}/{localPart}` | `AliasConfig` JSON | Individual alias config (enabled, target override, counts, expiry, tags) |
| `destination:{email}` | `DestinationAddress` JSON | Verified destination email addresses |
| `tag:{name}` | `Tag` JSON | Tag metadata (name, hex color) |
| `log:{domain}/{localPart}` | `LogEntry[]` JSON | **Legacy.** Per-alias activity log, ring buffer of last 50 entries. Written only when no `DB` binding is configured; still read either way, so an account that predates D1 keeps its history |
| `settings:onboarded` | `"1"` | Set after the onboarding wizard is completed |

You can inspect and edit values directly in **Cloudflare dashboard → Workers & Pages → KV → mailpal**.

---

## D1 data schema reference

With a `DB` binding configured, the activity log lives in one table instead
(`migrations/0001_create_activity.sql`):

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Autoincrementing key; also breaks ties between entries written in the same millisecond |
| `domain`, `local_part` | TEXT | The alias this entry belongs to. `recipient` is not stored — it is always `local_part@domain` |
| `at` | INTEGER | Unix milliseconds |
| `action` | TEXT | `forwarded` or `blocked` |
| `from_addr`, `to_addr` | TEXT | Envelope sender, and the destination it went to (or would have) |
| `reason`, `matched_rule` | TEXT | Why a message was blocked, and which sender rule matched |
| `subject`, `header_from`, `cc` | TEXT | Display metadata; `cc` is a JSON array |

Unlike the KV ring buffer this keeps full history rather than the last 50
entries per alias. Backups still export the most recent 50 per alias, so an
export stays a fixed size.

```bash
# Inspect it from the command line
wrangler d1 execute mailpal --remote --command "SELECT COUNT(*) FROM activity"
```

---

## Moving an existing activity log into D1

Nothing is lost by adding the `DB` binding to an account that has been running
on KV — every read merges both stores, so old entries stay visible. To retire
the leftover `log:` keys (they otherwise sit in every backup and cost a KV list
on each activity page load), call the migration route until it stops answering
`202`:

```bash
curl -X POST https://your-dashboard.pages.dev/api/settings/activity/migrate \
  -H "Authorization: Bearer $API_TOKEN"
```

Each call moves up to 100 aliases and reports
`{ migrated, aliases, failed, complete }`. Entries are appended, so anything the
worker has already written to D1 since you added the binding stays put. A `log:`
key is only deleted once its rows are in the database — `failed` counts the
aliases whose insert did not land, and they are left for the next call.

Exporting a backup and re-importing it does the same thing.

---

## How the email worker processes a message

When an email arrives at `localPart@domain`:

1. Worker reads `domain:{domain}` from KV — if missing or `enabled: false`, rejects the message
2. Worker reads `alias:{domain}/{localPart}` from KV
3. If the alias does not exist and `wildcardEnabled: true`, it auto-creates the alias and forwards
4. If the alias exists:
   - Checks `enabled`, `expiresAt`, and `maxForwards` — rejects if any limit is breached
   - Forwards to `targetEmail` (alias-level override) or falls back to `domainConfig.targetEmail`
5. Increments `forwardedCount` or `blockedCount` and updates `lastUsedAt` on the alias record — one KV write
6. Records a `forwarded` or `blocked` entry: an insert into the D1 `activity` table, or an append to the
   `log:{domain}/{localPart}` ring buffer when no `DB` binding is configured — a second KV write

Steps 5 and 6 run as background work after the message has been forwarded, so a
failure to record it never costs the recipient their mail.

---

## Next steps to communicate to the user

Once setup is complete, here is what to tell the user:

1. **Dashboard is live** at the Pages URL (or custom domain). They can log in (if a password was set) and manage all aliases from there.

2. **Creating aliases**: Use the Quick Create form at the top of the dashboard to generate a random alias instantly, or enter a custom local part. Aliases can be scoped to a specific target address or inherit the domain default.

3. **Wildcard mode**: If enabled on a domain, any email sent to an unknown address at that domain automatically creates a new alias. Great for signing up to services without visiting the dashboard first.

4. **Disabling an alias**: Click the toggle next to any alias in the list. Disabled aliases are silently rejected at the worker level — the sender gets a bounce.

5. **Tags and notes**: Aliases can be annotated with free-text notes and color-coded tags for quick filtering and organisation.

6. **Expiry and limits**: An alias can be given an expiry date or a maximum forward count. When either threshold is crossed the worker automatically rejects further mail without any manual action.

7. **Activity logs**: Expand any alias row to see its recent activity (forwarded/blocked events with timestamps and sender addresses).

8. **Multiple domains**: Additional domains can be added from the sidebar at any time. Each must have Email Routing enabled and the catch-all rule pointing to `mailpal-email-worker`.

9. **Source code and updates**: The project lives at https://github.com/betahuhn/mailpal. Pull the latest changes, rebuild (`npm run build`), and redeploy (`wrangler pages deploy`) to update the dashboard. Redeploy the email worker (`cd email-worker && wrangler deploy`) separately if `email-worker/src/index.ts` changed.
