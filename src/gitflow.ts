// Git-flow with plain git: plans the commands, the caller runs them. No git-flow CLI needed.
import { git } from './git';

export type FlowKind = 'feature' | 'release' | 'hotfix';
export const FLOW_KINDS: FlowKind[] = ['feature', 'release', 'hotfix'];

export interface FlowConfig {
  develop: string;
  main: string;
  prefix: Record<FlowKind, string>;
  /** Prefix for release/hotfix tags, e.g. `v`. */
  versionTag: string;
}

/** Applies git-flow's config keys (`gitflow.branch.*`, `gitflow.prefix.*`) over the defaults. */
export function resolveFlowConfig(config: Record<string, string>, branches: string[]): FlowConfig {
  const main =
    config['gitflow.branch.master'] || config['gitflow.branch.main'] || (!branches.includes('main') && branches.includes('master') ? 'master' : 'main');
  return {
    develop: config['gitflow.branch.develop'] || 'develop',
    main,
    prefix: {
      feature: config['gitflow.prefix.feature'] || 'feature/',
      release: config['gitflow.prefix.release'] || 'release/',
      hotfix: config['gitflow.prefix.hotfix'] || 'hotfix/',
    },
    versionTag: config['gitflow.prefix.versiontag'] ?? '',
  };
}

/** Config plus the repo's local branch names. */
export async function readFlowConfig(cwd: string): Promise<FlowConfig & { branches: string[] }> {
  const config: Record<string, string> = {};
  try {
    const out = await git(cwd, ['config', '-z', '--get-regexp', '^gitflow\\.']);
    for (const entry of out.split('\0')) {
      const nl = entry.indexOf('\n');
      if (nl > 0) config[entry.slice(0, nl)] = entry.slice(nl + 1);
    }
  } catch {
    // exit code 1: no gitflow keys
  }
  const branches = (await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter(Boolean);
  return { ...resolveFlowConfig(config, branches), branches };
}

export interface FlowChoice {
  action: 'start' | 'finish';
  kind: FlowKind;
  /** For finish: the name after the prefix. */
  name?: string;
}

/** Finish for the flow branch you're on (if any), then every Start. */
export function flowChoices(cfg: FlowConfig, current: string | null): FlowChoice[] {
  const choices: FlowChoice[] = [];
  const on = current ? FLOW_KINDS.find((k) => current.startsWith(cfg.prefix[k]) && current.length > cfg.prefix[k].length) : undefined;
  if (on) choices.push({ action: 'finish', kind: on, name: current!.slice(cfg.prefix[on].length) });
  for (const kind of FLOW_KINDS) choices.push({ action: 'start', kind });
  return choices;
}

/** Creates the flow branch from develop (feature, release) or main (hotfix) and switches to it. */
export function planStart(cfg: FlowConfig, kind: FlowKind, name: string, branches: string[]): string[][] {
  const base = kind === 'hotfix' ? cfg.main : cfg.develop;
  const cmds: string[][] = [];
  if (base === cfg.develop && !branches.includes(cfg.develop)) cmds.push(['branch', cfg.develop, cfg.main]);
  cmds.push(['switch', '-c', cfg.prefix[kind] + name, base]);
  return cmds;
}

/**
 * Feature: merge into develop. Release/hotfix: merge into main, tag there, merge into develop.
 * Merges are --no-ff; a conflict stops the run and leaves the merge to finish by hand.
 */
export function planFinish(
  cfg: FlowConfig,
  kind: FlowKind,
  branch: string,
  opts: { tag?: string; deleteBranch: boolean },
): string[][] {
  const merge = (into: string, what = branch) => [['switch', into], ['merge', '--no-ff', '--no-edit', what]];
  const cmds: string[][] = [];
  if (kind === 'feature') {
    cmds.push(...merge(cfg.develop));
  } else {
    cmds.push(...merge(cfg.main));
    if (opts.tag) cmds.push(['tag', '-a', opts.tag, '-m', `${kind === 'release' ? 'Release' : 'Hotfix'} ${opts.tag}`]);
    // Like git-flow, develop gets the tag (main's merge commit), so it contains the release.
    cmds.push(...merge(cfg.develop, opts.tag || branch));
  }
  if (opts.deleteBranch) cmds.push(['branch', '-d', branch]);
  return cmds;
}

/** Tag to prefill when finishing a release or hotfix. */
export function suggestedTag(cfg: FlowConfig, kind: FlowKind, branch: string): string {
  return cfg.versionTag + branch.slice(cfg.prefix[kind].length);
}
