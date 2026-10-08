#!/usr/bin/env node
/**
 * Le cliquet des exports morts — principe 25.
 *
 * `npm run knip`          le rapport complet, tout le dépôt, non bloquant : on le lit.
 * `npm run knip:check`    le cliquet, bloquant, sur le `src` des paquets — le moteur.
 * `npm run knip:baseline` reprend la photo (`knip-baseline.json`).
 *
 * Pourquoi bloquant sur les paquets seulement : un paquet a une porte publique unique
 * (`src/index.ts`), donc un export que l'index ne rouvre pas et que personne n'importe est
 * mort sans ambiguïté. Côté applications (hors de cet instantané), une route Next ou un composant peuvent être atteints
 * par des chemins que knip n'a pas à deviner — on le regarde, on ne le tranche pas.
 *
 * Même mécanique que `lint-ratchet.mjs`, et même cliquet à deux sens : ce qui apparaît est
 * refusé, ce qui disparaît réclame la photo pour qu'aucune dette fantôme ne survive.
 * La baseline ne contient que de la vraie dette ; ce que knip ne peut pas deviner se
 * déclare dans `knip.jsonc`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'knip-baseline.json');
const KNIP = resolve(ROOT, 'node_modules/.bin/knip');
const REGEN = 'npm run knip:baseline';

/** Le périmètre bloquant : le code livré des paquets, pas leurs tests ni leurs scripts. */
const SCOPE = /^packages\/[^/]+\/src\//;

/**
 * Les trois familles qu'on gèle. `files` est le cas extrême d'`exports` : un module que
 * personne n'atteint. `types` compte autant — un type exporté que rien ne lit est une
 * promesse que personne ne tient.
 */
const KINDS = {
  files: 'fichier jamais atteint',
  exports: 'export jamais importé',
  types: 'type exporté jamais lu',
};

function knip() {
  const raw = execFileSync(KNIP, ['--no-exit-code', '--reporter', 'json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

/** fichier → famille → noms triés. Un seul format pour la photo et pour la mesure. */
function measure() {
  const files = {};
  for (const issue of knip().issues) {
    if (!SCOPE.test(issue.file)) continue;
    for (const kind of Object.keys(KINDS)) {
      const names = (issue[kind] ?? []).map((item) => item.name).sort();
      if (names.length === 0) continue;
      (files[issue.file] ??= {})[kind] = names;
    }
  }
  const out = {};
  for (const file of Object.keys(files).sort()) {
    out[file] = {};
    for (const kind of Object.keys(files[file]).sort()) out[file][kind] = files[file][kind];
  }
  return out;
}

function totals(files) {
  let constats = 0;
  for (const kinds of Object.values(files)) {
    for (const names of Object.values(kinds)) constats += names.length;
  }
  return { fichiers: Object.keys(files).length, constats };
}

function write(files) {
  const photo = {
    _lire: [
      'Photo des exports morts de `packages/*/src` — principe 25.',
      "Ce fichier ne s'édite pas à la main : `npm run knip:baseline` le régénère.",
      'Chaque nom listé est de la dette réelle, à retirer quand on touche au fichier.',
      "Ce que knip ne peut pas deviner se déclare dans knip.jsonc, jamais ici.",
    ],
    prise_le: '2026-09-12',
    perimetre: 'packages/*/src (le moteur) — bloquant. Le reste du dépôt est en rapport seul.',
    total: totals(files),
    fichiers: files,
  };
  writeFileSync(BASELINE, `${JSON.stringify(photo, null, 2)}\n`, 'utf8');
  const { fichiers, constats } = photo.total;
  console.log(`knip-baseline.json régénéré : ${constats} constats sur ${fichiers} fichiers.`);
}

function read() {
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf8')).fichiers ?? {};
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`knip-baseline.json est absent. Le créer : ${REGEN}`);
    }
    throw error;
  }
}

function compare(current, baseline) {
  const refus = [];
  const aRegenerer = [];
  for (const [file, kinds] of Object.entries(current)) {
    for (const [kind, names] of Object.entries(kinds)) {
      const gelés = new Set(baseline[file]?.[kind] ?? []);
      const nouveaux = names.filter((name) => !gelés.has(name));
      if (nouveaux.length > 0) {
        refus.push(`${file} — ${KINDS[kind]} : ${nouveaux.join(', ')}`);
      }
    }
  }
  for (const [file, kinds] of Object.entries(baseline)) {
    for (const [kind, names] of Object.entries(kinds)) {
      const vivants = new Set(current[file]?.[kind] ?? []);
      const partis = names.filter((name) => !vivants.has(name));
      if (partis.length > 0) {
        aRegenerer.push(`${file} — ${KINDS[kind]} : ${partis.join(', ')} — plus mort(s)`);
      }
    }
  }
  return { refus, aRegenerer };
}

function check() {
  const { refus, aRegenerer } = compare(measure(), read());

  if (refus.length > 0) {
    console.error(`\n✗ ${refus.length} export(s) mort(s) nouveau(x) dans packages/*/src :\n`);
    for (const line of refus) console.error(`  · ${line}`);
    console.error(
      "\nUn export que rien n'importe ne se livre pas : le retirer, ou l'utiliser.\n" +
        `Si knip se trompe, le dire dans knip.jsonc — pas dans la baseline. Sinon : ${REGEN}\n`,
    );
  }
  if (aRegenerer.length > 0) {
    console.error(`\n✗ ${aRegenerer.length} entrée(s) de baseline périmée(s) — dette fantôme :\n`);
    for (const line of aRegenerer) console.error(`  · ${line}`);
    console.error(`\nLa dette a baissé : reprendre la photo — ${REGEN}\n`);
  }
  if (refus.length > 0 || aRegenerer.length > 0) process.exitCode = 1;
  else {
    const { fichiers, constats } = totals(read());
    console.log(
      `✓ knip : rien de neuf dans packages/*/src. ${constats} exports morts gelés sur ` +
        `${fichiers} fichiers (knip-baseline.json).`,
    );
  }
}

const mode = process.argv[2] ?? '--check';
if (mode === '--write') write(measure());
else if (mode === '--check') check();
else {
  console.error('usage : node scripts/knip-ratchet.mjs [--check|--write]');
  process.exitCode = 2;
}
