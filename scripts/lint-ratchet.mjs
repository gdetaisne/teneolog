#!/usr/bin/env node
/**
 * Le cliquet de taille — principe 26 (docs/METIER.md §9).
 *
 * `npm run lint`           vérifie que la dette n'a pas bougé d'un cran vers le haut.
 * `npm run lint:baseline`  reprend la photo, à commiter avec le travail qui l'a changée.
 *
 * Pourquoi un script maison plutôt que le paquet `eslint-baseline` (0.4.0) : celui-ci gèle
 * la *présence* d'une violation, pas sa *taille*. Or ce qu'on veut interdire ici, c'est
 * exactement qu'un fichier déjà trop long grossisse encore. Le cliquet a donc besoin du
 * nombre — combien de violations, et la pire — et il le compare dans les deux sens :
 *   · une violation nouvelle, plus nombreuse ou plus grosse  → la CI refuse ;
 *   · une violation disparue ou réduite                      → la CI réclame la photo,
 *     pour qu'on ne garde jamais de dette fantôme qui rouvrirait la porte.
 * Cent lignes lisibles valent mieux qu'une dépendance de plus sur un mécanisme aussi
 * structurant (et c'est le même raisonnement que `explain-imports.test.ts`).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';

import { LIMITS, LINT_FILES } from './lint-scope.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'eslint-baseline.json');
const REGEN = 'npm run lint:baseline';

/**
 * Le nombre que porte chaque règle. Il est dans le message d'ESLint : le lire là évite de
 * recompter nous-mêmes, donc de compter autrement que la règle qui décide.
 */
const MEASURE = {
  'max-lines': { re: /too many lines \((\d+)\)/, unit: 'lignes' },
  'max-lines-per-function': { re: /too many lines \((\d+)\)/, unit: 'lignes de fonction' },
  complexity: { re: /complexity of (\d+)/, unit: 'de complexité' },
  'max-depth': { re: /nested too deeply \((\d+)\)/, unit: "d'imbrication" },
};

/** Chemin POSIX relatif à la racine : une baseline lisible et identique sous tout OS. */
function key(filePath) {
  return relative(ROOT, filePath).split(sep).join('/');
}

/**
 * Relève la dette telle qu'elle est aujourd'hui : fichier → règle → { nombre, pire }.
 * Toute surprise (erreur de parsing, message qu'on ne sait plus lire) fait tomber le
 * script plutôt que de produire une photo silencieusement fausse.
 */
async function measure() {
  const eslint = new ESLint({ cwd: ROOT, errorOnUnmatchedPattern: false });
  const results = await eslint.lintFiles(LINT_FILES);
  const files = {};
  for (const result of results) {
    for (const message of result.messages) {
      if (message.fatal === true) {
        throw new Error(
          `ESLint n'a pas pu lire ${key(result.filePath)}:${message.line ?? '?'} — ${message.message}`,
        );
      }
      // Sans `ruleId`, c'est ESLint qui parle de lui-même : un `eslint-disable` hérité qui
      // ne sert plus à rien depuis `noInlineConfig`. Rien à geler là-dedans.
      if (message.ruleId === null) continue;
      const measure = MEASURE[message.ruleId];
      if (measure === undefined) {
        throw new Error(`règle inattendue dans eslint.config.mjs : ${message.ruleId}`);
      }
      const found = measure.re.exec(message.message);
      if (found === null) {
        throw new Error(
          `message ESLint illisible pour ${message.ruleId} : « ${message.message} ». ` +
            'Le format a changé : corriger MEASURE dans scripts/lint-ratchet.mjs.',
        );
      }
      const value = Number(found[1]);
      const file = (files[key(result.filePath)] ??= {});
      const entry = (file[message.ruleId] ??= { nombre: 0, pire: 0 });
      entry.nombre += 1;
      entry.pire = Math.max(entry.pire, value);
    }
  }
  return files;
}

/** Tri stable : la baseline doit produire le même fichier à chaque régénération. */
function sorted(files) {
  const out = {};
  for (const file of Object.keys(files).sort()) {
    out[file] = {};
    for (const rule of Object.keys(files[file]).sort()) out[file][rule] = files[file][rule];
  }
  return out;
}

function totals(files) {
  let violations = 0;
  for (const rules of Object.values(files)) {
    for (const entry of Object.values(rules)) violations += entry.nombre;
  }
  return { fichiers: Object.keys(files).length, violations };
}

function write(files) {
  const photo = {
    _lire: [
      'Photo de la dette de taille et de complexité — principe 26.',
      "Ce fichier ne s'édite pas à la main : `npm run lint:baseline` le régénère.",
      'Chaque entrée gèle un fichier : il ne peut plus grossir, seulement maigrir.',
      '`nombre` = combien de fois la règle est enfreinte ; `pire` = la plus grosse valeur mesurée',
      "(lignes hors vides et commentaires pour max-lines et max-lines-per-function).",
    ],
    prise_le: '2026-09-12',
    limites: {
      'max-lines': LIMITS.maxLines,
      'max-lines-per-function': LIMITS.maxLinesPerFunction,
      complexity: LIMITS.complexity,
      'max-depth': LIMITS.maxDepth,
    },
    total: totals(files),
    fichiers: sorted(files),
  };
  writeFileSync(BASELINE, `${JSON.stringify(photo, null, 2)}\n`, 'utf8');
  const { fichiers, violations } = photo.total;
  console.log(`eslint-baseline.json régénéré : ${fichiers} fichiers gelés, ${violations} violations.`);
}

function read() {
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf8')).fichiers ?? {};
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`eslint-baseline.json est absent. Le créer : ${REGEN}`);
    }
    throw error;
  }
}

/**
 * Le cliquet. Deux sens, deux messages : ce qui grossit est refusé sèchement, ce qui a
 * maigri demande simplement la photo — c'est une bonne nouvelle, pas une faute.
 */
function compare(current, baseline) {
  const refus = [];
  const aRegenerer = [];
  for (const [file, rules] of Object.entries(current)) {
    for (const [rule, now] of Object.entries(rules)) {
      const was = baseline[file]?.[rule];
      const { unit } = MEASURE[rule];
      if (was === undefined) {
        refus.push(
          `${file} — ${rule} : ${now.nombre} violation(s), la pire à ${now.pire} ${unit}. ` +
            "Ce fichier n'était pas en dette sur cette règle : découper avant de commiter " +
            '(docs/METIER.md §9, principe 26).',
        );
        continue;
      }
      if (now.nombre > was.nombre) {
        refus.push(
          `${file} — ${rule} : ${was.nombre} → ${now.nombre} violations. Un fichier gelé ne gagne ` +
            'pas de dette : découper la partie ajoutée.',
        );
      }
      if (now.pire > was.pire) {
        refus.push(
          `${file} — ${rule} : ${was.pire} → ${now.pire} ${unit}. Un fichier gelé ne grossit pas : ` +
            'sortir ce qui a été ajouté dans un module à part.',
        );
      }
      if (now.nombre < was.nombre || now.pire < was.pire) {
        aRegenerer.push(
          `${file} — ${rule} : ${was.nombre}×/${was.pire} → ${now.nombre}×/${now.pire}`,
        );
      }
    }
  }
  for (const [file, rules] of Object.entries(baseline)) {
    for (const rule of Object.keys(rules)) {
      if (current[file]?.[rule] === undefined) {
        aRegenerer.push(`${file} — ${rule} : réglé, l'entrée n'a plus lieu d'être`);
      }
    }
  }
  return { refus, aRegenerer };
}

async function check() {
  const current = await measure();
  const { refus, aRegenerer } = compare(current, read());

  if (refus.length > 0) {
    console.error(`\n✗ ${refus.length} violation(s) nouvelle(s) — principe 26 :\n`);
    for (const line of refus) console.error(`  · ${line}`);
    console.error(
      "\nRien ne doit être gelé de plus aujourd'hui. Si l'écart est assumé, il se dit avant\n" +
        "(ÉCART AU PRINCIPE 26, tranché côté produit) et alors seulement : " + `${REGEN}\n`,
    );
  }
  if (aRegenerer.length > 0) {
    console.error(`\n✗ ${aRegenerer.length} entrée(s) de baseline périmée(s) — dette fantôme :\n`);
    for (const line of aRegenerer) console.error(`  · ${line}`);
    console.error(
      `\nLa dette a baissé : reprendre la photo pour que le cliquet la garde basse — ${REGEN}\n`,
    );
  }
  if (refus.length > 0 || aRegenerer.length > 0) process.exitCode = 1;
  else {
    const { fichiers, violations } = totals(current);
    console.log(
      `✓ lint : rien de neuf. ${violations} violations gelées sur ${fichiers} fichiers ` +
        '(eslint-baseline.json).',
    );
  }
}

const mode = process.argv[2] ?? '--check';
if (mode === '--write') write(await measure());
else if (mode === '--check') await check();
else {
  console.error('usage : node scripts/lint-ratchet.mjs [--check|--write]');
  process.exitCode = 2;
}
