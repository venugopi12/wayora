import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

// Prisma CLI does not load .env files when a prisma.config.ts exists, so load
// database/.env explicitly (Node >= 20.12 built-in loader, no dotenv needed).
const envFile = path.join(import.meta.dirname, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  schema: path.join(import.meta.dirname, 'schema.prisma'),
  migrations: {
    path: path.join(import.meta.dirname, 'migrations'),
    seed: 'tsx seed.ts',
  },
  // Required by migrate/seed/studio. `prisma generate` works without it.
  ...(process.env.DATABASE_URL ? { datasource: { url: process.env.DATABASE_URL } } : {}),
});
