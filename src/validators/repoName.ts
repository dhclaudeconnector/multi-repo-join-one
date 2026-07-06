import type {
  ExcludeRule,
  ExcludeRuleType,
  NormalizedPush,
  ValidationResult,
} from "../types.js";

/**
 * Rule matchers. Each is a pure function; add new match kinds (regex, glob...)
 * by adding a case here.
 */
const matchers: Record<
  ExcludeRuleType,
  (name: string, value: string) => boolean
> = {
  startsWith: (name, value) => name.startsWith(value),
  endsWith: (name, value) => name.endsWith(value),
  equal: (name, value) => name === value,
};

/**
 * Check a repo name against a single rule. The rule is matched against both the
 * bare repo name and the "org/repo" full name (either match counts).
 */
export function matchesRule(
  repo: string,
  fullName: string,
  rule: ExcludeRule
): boolean {
  const fn = matchers[rule.type];
  if (!fn) return false;
  return fn(repo, rule.value) || fn(fullName, rule.value);
}

export interface RepoNameOptions {
  exclude?: ExcludeRule[];
  /** if non-empty, repo must match at least one include rule to pass */
  include?: ExcludeRule[];
}

/**
 * Build a validator that skips repos matching any exclude rule, and (if an
 * include allowlist is provided) skips repos not matching any include rule.
 */
export function makeRepoNameValidator(
  opts: RepoNameOptions
): (push: NormalizedPush) => ValidationResult {
  const exclude = opts.exclude ?? [];
  const include = opts.include ?? [];

  return (push: NormalizedPush): ValidationResult => {
    const { repo, fullName } = push;

    for (const rule of exclude) {
      if (matchesRule(repo, fullName, rule)) {
        return {
          ok: false,
          reason: `excluded by rule ${rule.type}="${rule.value}"`,
        };
      }
    }

    if (include.length > 0) {
      const allowed = include.some((rule) =>
        matchesRule(repo, fullName, rule)
      );
      if (!allowed) {
        return {
          ok: false,
          reason: "not in include allowlist",
        };
      }
    }

    return { ok: true };
  };
}
