import { applyD1Migrations, env } from "cloudflare:test";

// Runs once per test worker before any test. applyD1Migrations records applied
// migrations in the d1_migrations table, so re-runs are no-ops; isolated
// storage gives each test a clean database seeded from these migrations.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
