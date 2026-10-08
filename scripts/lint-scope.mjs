/**
 * Le périmètre et les bornes du cliquet de taille — principe 26 (docs/METIER.md §9).
 *
 * Une seule source de vérité (principe 23) : `eslint.config.mjs` en fait sa configuration,
 * `scripts/lint-ratchet.mjs` en fait la liste des fichiers à passer à ESLint. Les deux ne
 * peuvent pas diverger.
 */

/** Ce qui est tenu : le code livré. */
export const LINT_FILES = ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'];

/**
 * Ce qui ne l'est pas : un test long n'est pas une dette (il est souvent long exprès),
 * un script d'atelier non plus, et le généré n'appartient à personne.
 */
export const LINT_IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/*.d.ts',
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/test/**',
  '**/scripts/**',
  '**/fixtures/**',
  '**/__fixtures__/**',
];

/** Les bornes, mot pour mot celles du principe 26. */
export const LIMITS = {
  maxLines: 600,
  maxLinesPerFunction: 80,
  complexity: 12,
  maxDepth: 4,
};
