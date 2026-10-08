/**
 * Le cliquet de taille et de complexité — principe 26 (docs/METIER.md §9).
 *
 * Quatre règles, pas une de plus. Aucune règle de style : le formatage est le travail de
 * Prettier, et une règle de style ici ferait passer le cliquet pour une question de goût.
 * Tout ce qui est signalé est une dette qui grossit.
 *
 * Le résultat ne se lit pas avec `eslint` tout court mais par `npm run lint`, qui applique
 * la baseline (`eslint-baseline.json`) : ce qui dépasse déjà est gelé, ce qui dépasse en
 * plus est refusé.
 */
import tseslint from 'typescript-eslint';

import { LIMITS, LINT_FILES, LINT_IGNORES } from './scripts/lint-scope.mjs';

export default [
  { ignores: LINT_IGNORES },
  {
    files: LINT_FILES,
    // Un cliquet qu'on éteint d'un commentaire n'est pas un cliquet : `eslint-disable` est
    // sans effet ici. Effet de bord utile : les `eslint-disable` hérités d'un ancien
    // `next lint` (react-hooks, @next/next) ne déclenchent pas « rule not found ».
    linterOptions: { noInlineConfig: true },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // Les lignes vides et les commentaires ne comptent pas : on décourage le code qui
      // s'accumule, pas la documentation qui l'explique.
      'max-lines': ['error', { max: LIMITS.maxLines, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': [
        'error',
        { max: LIMITS.maxLinesPerFunction, skipBlankLines: true, skipComments: true },
      ],
      complexity: ['error', { max: LIMITS.complexity }],
      'max-depth': ['error', { max: LIMITS.maxDepth }],
    },
  },
];
