import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { userRoleSchema } from '@wayora/contracts';
import { createPrismaClient } from '@wayora/database';
import { loadEnvFile } from '../config/load-env-file.js';
import { RoleChangeError, listStaff, setUserRole } from '../modules/admin/roles.js';

/*
 * Grant or remove staff roles (docs/admin.md#provisioning).
 *
 *   npm run admin:role -- --email ops@example.com --role admin --reason "On-call lead"
 *   npm run admin:role -- --email ops@example.com --role user --reason "Left the team"
 *   npm run admin:role -- --list
 *
 * Uses DATABASE_URL (apps/api/.env or the environment). The person must
 * already have an account. Prints no secrets.
 */

const USAGE =
  'Usage: npm run admin:role -- --email <email> --role <user|support|admin> --reason "<why>" [--actor <name>]\n       npm run admin:role -- --list';

async function main(): Promise<number> {
  loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      role: { type: 'string' },
      reason: { type: 'string' },
      actor: { type: 'string' },
      list: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const url = process.env.DATABASE_URL;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    process.stderr.write('DATABASE_URL is not set (apps/api/.env or the environment).\n');
    return 1;
  }
  const prisma = createPrismaClient({ url, maxConnections: 1 });
  try {
    if (values.list) {
      const staff = await listStaff(prisma);
      if (staff.length === 0) process.stdout.write('No staff accounts.\n');
      for (const s of staff)
        process.stdout.write(
          `${s.role.toLowerCase().padEnd(8)} ${s.status.toLowerCase().padEnd(10)} ${s.email}\n`,
        );
      return 0;
    }
    const role = userRoleSchema.safeParse(values.role);
    if (!values.email || !role.success || !values.reason) {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
    const result = await setUserRole(prisma, {
      email: values.email,
      role: role.data,
      reason: values.reason,
      actor: values.actor ?? `cli:${os.userInfo().username}`,
    });
    process.stdout.write(
      result.changed
        ? `Changed ${values.email.trim().toLowerCase()} from ${result.from} to ${result.to}. Recorded in the audit log.\n`
        : `${values.email.trim().toLowerCase()} is already ${result.from}; nothing changed.\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof RoleChangeError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    process.stderr.write(`Failed: ${(error as Error).message.split('\n')[0]}\n`);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

process.exitCode = await main();
