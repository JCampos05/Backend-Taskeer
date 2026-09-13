function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

// Arma la URL de conexión de MySQL a partir de sus partes (host, puerto,
// usuario, contraseña, nombre de BD) en vez de leer una única DATABASE_URL
// del .env — así se puede rotar la contraseña o cambiar de proveedor
// (Aiven/Docker/local) tocando una sola variable, sin recomponer la URL a
// mano. Se usa tanto desde `config/prisma.ts` como desde `prisma/seed.ts`.
export function buildDatabaseUrl(): string {
  const host = required('DB_HOST');
  const port = process.env.DB_PORT ?? '3306';
  const user = encodeURIComponent(required('DB_USER'));
  const password = encodeURIComponent(required('DB_PASSWORD'));
  const name = required('DB_NAME');
  // Bajo a propósito: el free tier de Aiven limita las conexiones
  // concurrentes (ver docs/01-arquitectura.md, "Pooling de conexiones").
  const connectionLimit = process.env.DB_CONNECTION_LIMIT ?? '5';

  return `mysql://${user}:${password}@${host}:${port}/${name}?connection_limit=${connectionLimit}`;
}
