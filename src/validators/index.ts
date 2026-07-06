import type {
  ExcludeRule,
  NormalizedPush,
  ValidationResult,
  Validator,
} from "../types.js";
import { validateHookShape } from "./hookShape.js";
import { makeRepoNameValidator } from "./repoName.js";

export { validateHookShape } from "./hookShape.js";
export { makeRepoNameValidator, matchesRule } from "./repoName.js";

export interface PipelineOptions {
  exclude?: ExcludeRule[];
  include?: ExcludeRule[];
  /** extra validators appended to the pipeline (e.g. branch/size checks) */
  extra?: Validator[];
}

/**
 * Build the default validation pipeline. Validators run in order and the first
 * failure short-circuits with its reason. All validators share the interface
 * `(push) => {ok, reason}` so they can be added/removed/reordered freely.
 */
export function buildPipeline(opts: PipelineOptions = {}): Validator[] {
  return [
    validateHookShape,
    makeRepoNameValidator({ exclude: opts.exclude, include: opts.include }),
    ...(opts.extra ?? []),
  ];
}

/**
 * Run a pipeline of validators against a push. Returns the first failure, or ok.
 */
export function runPipeline(
  pipeline: Validator[],
  push: NormalizedPush
): ValidationResult {
  for (const validate of pipeline) {
    const result = validate(push);
    if (!result.ok) return result;
  }
  return { ok: true };
}
