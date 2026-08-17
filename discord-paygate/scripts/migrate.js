#!/usr/bin/env node
// Explicit migration: creates the schema (CREATE TABLE IF NOT EXISTS) against
// whatever DATABASE_URL / DB_PATH points at. The same DDL also runs lazily on
// the first query of a cold start, so serverless deploys work even if this
// was never run — but running it once at deploy time surfaces connection
// problems immediately instead of on the first customer.

import { ensureSchema } from '../src/db.js';

const dialect = await ensureSchema();
console.log(`[migrate] schema ensured on ${dialect} (users, subscriptions, webhook_events)`);
process.exit(0);
