-- Run this in Neon SQL Editor. Safe to run on an existing deployment.
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, username TEXT NOT NULL, password_hash TEXT,
 trial_used BOOLEAN NOT NULL DEFAULT FALSE, premium_until BIGINT NOT NULL DEFAULT 0, balance BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, reference_id TEXT UNIQUE NOT NULL, provider_transaction_id TEXT,
 amount BIGINT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('deposit','plan','owner_test')), plan_days INTEGER,
 status TEXT NOT NULL DEFAULT 'pending', checkout_url TEXT, created_at BIGINT NOT NULL, paid_at BIGINT
);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT;
CREATE TABLE IF NOT EXISTS pairings (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT, phone TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_user_idx ON payments(user_id);
CREATE INDEX IF NOT EXISTS pairings_created_idx ON pairings(created_at DESC);
