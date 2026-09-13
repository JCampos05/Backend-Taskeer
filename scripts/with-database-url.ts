import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { buildDatabaseUrl } from '../src/config/database-url';

// El CLI de Prisma (a diferencia de nuestro propio código) lee
// `process.env.DATABASE_URL` directo, sin pasar por `src/config` — arma acá
// la URL a partir de las variables desglosadas del .env y se la inyecta
// antes de invocar el comando real. Uso: tsx scripts/with-database-url.ts
// migrate dev
const args = process.argv.slice(2);

const result = spawnSync('prisma', args, {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DATABASE_URL: buildDatabaseUrl() },
});

process.exit(result.status ?? 1);
