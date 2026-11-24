/** A branch label dragged onto another branch label (`onto`) or a commit row (`sha`). */
export interface Drop {
  src: string;
  srcKind: 'branch' | 'remote';
  onto?: string;
  sha?: string;
}

export interface DropChoice {
  label: string;
  detail?: string;
  /** git commands run in order; stops at the first failure. */
  steps: string[][];
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * The drop menu, GitKraken-style: dropping A on B offers "Merge A into B" and "Rebase B onto A"
 * (plus a fast-forward when B is behind A); dropping a branch on a commit rebases the branch onto it
 * or merges the commit in. Work on a branch that isn't checked out switches to it first.
 * Pure (pass `current` and `canFastForward` in) so it's testable.
 */
export function dropChoices(d: Drop, current: string | null, canFastForward: boolean): DropChoice[] {
  const on = (branch: string, step: string[], what: string): Pick<DropChoice, 'detail' | 'steps'> =>
    branch === current
      ? { detail: what, steps: [step] }
      : { detail: `Switches to ${branch} first, then ${what.charAt(0).toLowerCase()}${what.slice(1)}`, steps: [['switch', branch], step] };

  if (d.onto) {
    const { src, onto } = d;
    const out: DropChoice[] = [
      { label: `Merge ${src} into ${onto}`, ...on(onto, ['merge', src], 'Fast-forwards when possible') },
      { label: `Rebase ${onto} onto ${src}`, ...on(onto, ['rebase', src], `Replays ${onto}'s commits on top, rewriting them`) },
    ];
    if (canFastForward) {
      const srcRef = `${d.srcKind === 'remote' ? 'refs/remotes/' : 'refs/heads/'}${src}`;
      out.push({
        label: `Fast-forward ${onto} to ${src}`,
        detail: `Moves ${onto} up to ${src}; no new commits`,
        // Not checked out: move the ref directly (fetch refuses anything but a fast-forward).
        steps: [onto === current ? ['merge', '--ff-only', src] : ['fetch', '.', `${srcRef}:refs/heads/${onto}`]],
      });
    }
    return out;
  }

  if (!d.sha || d.srcKind !== 'branch') return [];
  const { src, sha } = d;
  return [
    { label: `Rebase ${src} onto ${short(sha)}`, ...on(src, ['rebase', sha], `Replays ${src}'s commits on top, rewriting them`) },
    { label: `Merge ${short(sha)} into ${src}`, ...on(src, ['merge', sha], 'Fast-forwards when possible') },
  ];
}
