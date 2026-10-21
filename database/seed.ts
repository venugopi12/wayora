/**
 * Development seed. Idempotent: safe to run repeatedly.
 * Creates one fictional user and traveller — no orders, no fake bookings.
 * Refuses to run when NODE_ENV=production.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createPrismaClient } from './src/index.js';

const envFile = path.join(import.meta.dirname, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed: NODE_ENV is "production".');
  process.exit(1);
}

const prisma = createPrismaClient();

async function main(): Promise<void> {
  const user = await prisma.user.upsert({
    where: { email: 'dev.traveller@wayora.local' },
    update: {},
    create: {
      email: 'dev.traveller@wayora.local',
      displayName: 'Dev Traveller',
      emailVerifiedAt: new Date(),
    },
  });

  const existingTraveller = await prisma.traveller.findFirst({ where: { userId: user.id } });
  if (!existingTraveller) {
    await prisma.traveller.create({
      data: { userId: user.id, firstName: 'Dev', lastName: 'Traveller', nationality: 'IN' },
    });
  }

  await prisma.auditLog.create({
    data: {
      actorType: 'SYSTEM',
      action: 'database.seeded',
      entityType: 'user',
      entityId: user.id,
    },
  });

  console.log(`Seeded development user ${user.email} (${user.id}).`);
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
