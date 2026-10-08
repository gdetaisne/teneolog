#!/usr/bin/env node
/**
 * L'inventaire des modes « en silence » — principe 22 : tout mécanisme livré éteint a une
 * date de décision.
 *
 * Un drapeau à `false` dans la policy, c'est du code qui tourne à vide, ou une règle qui
 * attend son A/B. Sans inventaire, ces drapeaux s'accumulent et plus personne ne sait
 * lesquels sont des retours arrière gardés exprès et lesquels sont oubliés. Ce script
 * refuse la CI dès qu'un drapeau à `false` de `config/policy.example.json` n'est pas nommé
 * dans `docs/METIER.md` (section « Mécanismes en silence »).
 *
 * Dans l'application complète, la même garde est un test Vitest qui lit la policy de
 * production et le registre des principes.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(readFileSync(resolve(ROOT, 'config/policy.example.json'), 'utf8'));
const metier = readFileSync(resolve(ROOT, 'docs/METIER.md'), 'utf8');

/** Chemins pointés de chaque `false`, commentaires exclus. */
function falseFlags(node, path = []) {
  if (node === false) return [path.join('.')];
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    return Object.entries(node)
      .filter(([key]) => !key.startsWith('_') && !key.endsWith('Comment'))
      .flatMap(([key, value]) => falseFlags(value, [...path, key]));
  }
  return [];
}

const flags = falseFlags(policy);
const missing = flags.filter(
  (flag) => !metier.includes(`\`${flag}\``) && !metier.includes(`\`${flag.replace(/\.enabled$/, '')}\``),
);

if (missing.length > 0) {
  console.error(`✗ ${missing.length} drapeau(x) en silence sans décision écrite dans docs/METIER.md :`);
  for (const flag of missing) console.error(`  · ${flag}`);
  process.exit(1);
}
console.log(`✓ silence : ${flags.length} drapeau(x) à false, tous nommés et datés dans docs/METIER.md.`);
