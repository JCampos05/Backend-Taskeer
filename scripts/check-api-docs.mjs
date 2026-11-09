// Detecta desfases entre el código y el contrato de la API para móvil.
//
//   node scripts/check-api-docs.mjs      (o: pnpm docs:api-check)
//
// Compara las rutas declaradas en Backend/src (`*.routes.ts` y routes/*.ts)
// con `document/API/openapi.yaml`, y comprueba que cada `$ref` apunte a algo
// que existe. Sale con código 1 si encuentra diferencias. No modifica nada.
//
// No valida los cuerpos ni los DTO (eso exige revisión humana o del agente
// `docs-keeper`): solo atrapa lo más fácil de olvidar, un endpoint añadido,
// renombrado o borrado sin tocar el contrato.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rutaOpenApi = resolve(raiz, '..', 'document', 'API', 'openapi.yaml');
const METODOS = ['get', 'post', 'put', 'patch', 'delete'];

function archivosDeRutas() {
  const archivos = [];
  const modulos = join(raiz, 'src', 'modules');
  for (const carpeta of readdirSync(modulos, { withFileTypes: true })) {
    if (!carpeta.isDirectory()) continue;
    for (const f of readdirSync(join(modulos, carpeta.name))) {
      if (f.endsWith('.routes.ts')) archivos.push(join(modulos, carpeta.name, f));
    }
  }
  const sueltas = join(raiz, 'src', 'routes');
  if (existsSync(sueltas)) {
    for (const f of readdirSync(sueltas)) {
      if (f.endsWith('.routes.ts')) archivos.push(join(sueltas, f));
    }
  }
  return archivos;
}

function rutasDelCodigo() {
  const encontradas = new Set();
  const patron = /Router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
  for (const archivo of archivosDeRutas()) {
    const texto = readFileSync(archivo, 'utf8');
    for (const m of texto.matchAll(patron)) {
      encontradas.add(`${m[1].toUpperCase()} ${m[2].replace(/:([A-Za-z]+)/g, '{$1}')}`);
    }
  }
  return encontradas;
}

function leerContrato() {
  const lineas = readFileSync(rutaOpenApi, 'utf8').split(/\r?\n/);
  const rutas = new Set();
  const definidos = new Map(); // seccion -> Set(nombres)
  const refs = [];
  let zona = '';
  let rutaActual = '';
  let seccionActual = '';

  for (const [i, linea] of lineas.entries()) {
    if (/^paths:\s*$/.test(linea)) zona = 'paths';
    else if (/^components:\s*$/.test(linea)) zona = 'components';
    else if (/^\S/.test(linea) && !linea.startsWith('#')) zona = '';

    if (zona === 'paths') {
      const p = linea.match(/^ {2}(\/\S*):\s*$/);
      if (p) rutaActual = p[1];
      const m = linea.match(/^ {4}(get|post|put|patch|delete):\s*$/);
      if (m && rutaActual) rutas.add(`${m[1].toUpperCase()} ${rutaActual}`);
    }

    if (zona === 'components') {
      const s = linea.match(/^ {2}(\w+):\s*$/);
      if (s) {
        seccionActual = s[1];
        definidos.set(seccionActual, new Set());
      }
      const n = linea.match(/^ {4}([\w-]+):/);
      if (n && seccionActual) definidos.get(seccionActual).add(n[1]);
    }

    for (const r of linea.matchAll(/\$ref:\s*'#\/components\/(\w+)\/([\w-]+)'/g)) {
      refs.push({ seccion: r[1], nombre: r[2], linea: i + 1 });
    }
  }
  return { rutas, definidos, refs };
}

if (!existsSync(rutaOpenApi)) {
  console.error(`No existe el contrato: ${rutaOpenApi}`);
  process.exit(1);
}

const codigo = rutasDelCodigo();
const { rutas: contrato, definidos, refs } = leerContrato();

const sinDocumentar = [...codigo].filter((r) => !contrato.has(r)).sort();
const sobrantes = [...contrato].filter((r) => !codigo.has(r)).sort();
const refsRotas = refs.filter((r) => !definidos.get(r.seccion)?.has(r.nombre));

console.log(`Rutas en el código: ${codigo.size} · en el contrato: ${contrato.size}`);

let hayError = false;
if (sinDocumentar.length) {
  hayError = true;
  console.error('\nEndpoints del código que NO están en openapi.yaml:');
  for (const r of sinDocumentar) console.error(`  + ${r}`);
}
if (sobrantes.length) {
  hayError = true;
  console.error('\nEndpoints de openapi.yaml que ya NO existen en el código:');
  for (const r of sobrantes) console.error(`  - ${r}`);
}
if (refsRotas.length) {
  hayError = true;
  console.error('\n$ref que apuntan a algo inexistente:');
  for (const r of refsRotas) console.error(`  línea ${r.linea}: #/components/${r.seccion}/${r.nombre}`);
}

if (hayError) {
  console.error(
    '\nActualiza document/API/openapi.yaml y anota el cambio en document/API/CHANGELOG.md.',
  );
  process.exit(1);
}
console.log('Contrato sincronizado con las rutas del código.');
