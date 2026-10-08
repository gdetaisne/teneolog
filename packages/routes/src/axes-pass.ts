/**
 * UNE PASSE DE L'ÉTAGE : jusqu'où monte un axe, et
 * quelles rues locales le rejoignent.
 *
 * Une porte est une jonction **axe × rue locale** : les deux classes vont
 * ensemble, et changer l'une sans l'autre fabrique des portes qui n'en sont
 * pas (une D contre une D, ce n'est pas une sortie de secteur, c'est un
 * carrefour du réseau structurant). D'où cette dérivation, à UN SEUL ENDROIT
 * (principe 23) — elle sert deux appelants :
 *
 *  1. **l'étage**, pour sa passe structurante (`axes-stage.ts`) ;
 *  2. **le harnais**, pour sa variante `--importance-max 4`
 *     (`packages/pipeline/scripts/ab-ancres-axes.ts`), qui faisait déjà
 *     exactement ce calcul à la main.
 *
 * LA RÈGLE, celle de l'engine (principe 29) : `isLocal45Segment`
 * (`axis-gate-discovery/internal-helpers.ts`) dit qu'une rue locale est
 * d'importance 4 ou 5 QUAND les axes sont d'importance 2–3. Ce qui est
 * invariant là-bas, ce n'est pas « 4–5 », c'est « strictement moins
 * structurant que l'axe » : quand les axes montent à 4, les rues locales
 * redescendent à la seule 5.
 *
 * *Relu le 2026-09-14 au soir* : l'étage n'appelle plus cette dérivation que
 * pour sa passe STRUCTURANTE. Sa passe de classe 4 ne fait plus de jonctions du
 * tout — elle pose ses portes là où l'axe coupe la bande 1 800–2 000 m
 * (`axes-band.ts`), sans aucune rue locale — donc elle n'a rien à dire sur
 * `localImportance`. Le second appelant reste le harnais, dont la variante
 * `--importance-max 4` mesure, elle, de vraies jonctions.
 */

/** Une passe : la classe maximale d'un axe, et les classes de ses rues locales. */
export interface AxisPass {
  readonly importanceMax: number;
  readonly localImportance: { readonly min: number; readonly max: number };
}

/** La passe de l'étage pour une classe d'axe donnée — la seule définition du couple. */
export function axisPassOf(
  params: {
    readonly importanceMax: number;
    readonly localImportance: { readonly min: number; readonly max: number };
  },
  importanceMax: number,
): AxisPass {
  return {
    importanceMax,
    localImportance: {
      min: Math.max(params.localImportance.min, importanceMax + 1),
      max: Math.max(params.localImportance.max, importanceMax + 1),
    },
  };
}

/** Une rue locale de cette passe, ou non. Une importance inconnue n'en est pas une. */
export function inLocalRange(pass: AxisPass, importance: number | null): boolean {
  if (importance === null) return false;
  return importance >= pass.localImportance.min && importance <= pass.localImportance.max;
}
