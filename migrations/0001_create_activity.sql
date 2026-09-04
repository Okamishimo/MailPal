-- Activity log storage.
--
-- Previously every alias kept a `log:<domain>/<localPart>` KV key holding a
-- 50-entry ring buffer, so each delivered message cost two KV writes: one for
-- the alias counters and one read-modify-write for the log. The Workers Free
-- plan allows 1,000 KV writes a day, which capped the service at ~500 messages
-- a day. Activity is append-only time-series data, so D1 fits it better: the
-- free plan allows 100,000 row writes a day and the insert needs no prior read.
--
-- `recipient` is not stored: it is always `<local_part>@<domain>`, so it is
-- derived on read instead.

CREATE TABLE IF NOT EXISTS activity (
	id           INTEGER PRIMARY KEY AUTOINCREMENT,
	domain       TEXT    NOT NULL,
	local_part   TEXT    NOT NULL,
	at           INTEGER NOT NULL,
	action       TEXT    NOT NULL,
	from_addr    TEXT    NOT NULL,
	to_addr      TEXT    NOT NULL,
	reason       TEXT,
	matched_rule TEXT,
	subject      TEXT,
	header_from  TEXT,
	-- JSON array of `Cc:` addresses, bounded at write time by MAX_CC_ADDRESSES.
	cc           TEXT
);

-- The activity page orders every alias by recency; `id` breaks ties between
-- entries written within the same millisecond so paging stays stable.
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity (at DESC, id DESC);

-- The per-alias log endpoint and the cascade deletes both filter by alias.
CREATE INDEX IF NOT EXISTS idx_activity_alias ON activity (domain, local_part, at DESC, id DESC);
