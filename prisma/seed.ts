import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { buildDatabaseUrl } from '../src/config/database-url';
import { countries, timezones } from './seed-data';
import { plans } from './plans-seed-data';

const prisma = new PrismaClient({
  datasources: { db: { url: buildDatabaseUrl() } },
});

async function main() {
  console.log(`Sembrando ${timezones.length} zonas horarias...`);
  for (const tz of timezones) {
    await prisma.timezone.upsert({
      where: { id: tz.id },
      update: tz,
      create: tz,
    });
  }

  console.log(`Sembrando ${countries.length} países...`);
  for (const country of countries) {
    await prisma.country.upsert({
      where: { isoCode: country.isoCode },
      update: country,
      create: country,
    });
  }

  console.log(`Sembrando ${plans.length} planes...`);
  for (const { entitlements, ...plan } of plans) {
    const record = await prisma.plan.upsert({
      where: { code: plan.code },
      update: plan,
      create: plan,
    });

    for (const [key, value] of Object.entries(entitlements)) {
      await prisma.planEntitlement.upsert({
        where: { planId_key: { planId: record.id, key } },
        update: { value },
        create: { planId: record.id, key, value },
      });
    }
  }

  console.log('Listo.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
