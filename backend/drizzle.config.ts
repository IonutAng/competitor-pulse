import { defineConfig } from 'drizzle-kit';

// Used by `pnpm db:generate` to diff src/db/schema.ts against the SQL migrations in ./drizzle.
// The application applies those migrations itself at startup (see src/db/index.ts).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5439/competitorpulse',
  },
});
