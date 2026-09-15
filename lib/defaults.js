/**
 * Default configuration for dsh-repeat-tool-breaker v2, plus the fail-loud
 * merge/validate pair used by `apply`.
 *
 * The model here is:
 *   - a bounded per-agent WINDOW of recent calls (not a consecutive-run
 *     counter), and
 *   - a set of FINGERPRINTS per call (`exact:`, `cmd:`, `net:`, `site:`,
 *     `sink:`, `family:*`, `verb:*`), each with a cap.
 *
 * File operations (`read`/`write`/`edit`) are covered by `exact:` alone, which
 * identifies them by POSITION: an identical re-read or re-edit is denied, while a
 * different offset or a different edited region is a different action.
 *
 * A call is denied when any one of its fingerprints has ALREADY appeared
 * `limit` times in the window — i.e. the current call would be the `limit`-th
 * occurrence. The first occurrence of any fingerprint is therefore always
 * allowed.
 */

/** Recursively freeze a plain value graph (arrays included). */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

/**
 * Fields that are presentation or transport noise rather than action identity.
 * They are stripped before the `exact:` fingerprint is computed, which is what
 * defeats the "same command, `description: '1st'|'2nd'|'3rd'`" loop: those
 * values end up in NO fingerprint string at all.
 */
export const DEFAULTS = deepFreeze({
  /** How many recent calls per agent participate in the counts. */
  window: 12,
  /** Head-truncation caps for text quoted back to the model. */
  previewChars: 400,
  resultPreviewChars: 800,
  /** Tool names never tracked (exact names or `*`-wildcard patterns). */
  exclude: ['todo_write'],
  /** When non-empty, ONLY these names/patterns are tracked. */
  include: [],
  /**
   * Argument keys deleted before fingerprinting. `'*'` applies to every tool;
   * a tool name (or shell name) adds its own list on top.
   */
  ignoreArgs: {
    '*': ['description', 'timeoutMs', 'run_in_background', 'justification', 'reason', 'title', 'comment'],
    bash: ['description', 'timeoutMs', 'run_in_background', 'justification'],
    pwsh: ['description', 'timeoutMs', 'run_in_background', 'justification'],
    shell: ['description', 'timeoutMs', 'run_in_background', 'justification'],
  },
  /** Host spellings that mean the same origin, folded to one canonical host. */
  hostAliases: {
    'open-data.canada.ca': 'open.canada.ca',
    'www.open.canada.ca': 'open.canada.ca',
    'www.open-data.canada.ca': 'open.canada.ca',
  },
  /**
   * Per-fingerprint caps. A key is either a complete fingerprint (`cmd`, `net`,
   * … or an exact `family:x` / `verb:x`) or `null` to disable that kind.
   * A numeric cap must be a finite number >= 2, so the first call always
   * survives.
   *
   * The precise caps (`exact`, `cmd`, `net`, `sink`) are what actually catch a
   * loop, and they are **3, not 2**, because a cap of 2 has no room for the most
   * common non-loop repeat: the first attempt fails for a reason unrelated to
   * looping (a precondition the harness enforces, a DNS failure) and the correct
   * response is to retry the same call. At 2 that retry is what gets blocked, and
   * the only way forward is to cosmetically change the call — the behaviour this
   * plugin exists to stop. At 3 the retry fits, while a call that keeps failing
   * is still blocked on its third attempt, so nothing loops forever.
   *
   * The volume caps (`site`, `family:*`, `verb:*`) are budgets, not repetition
   * detectors, and a measured run showed the cost of setting them tight: a task
   * that fetched four DIFFERENT URLs with `curl` tripped `family:http-fetch: 4`
   * on the fourth. They are kept as a runaway-crawl backstop, one above the
   * largest ordinary batch.
   *
   * There is deliberately NO cap on file operations. `read`/`write`/`edit` are
   * identified by POSITION through `exact:` — same file at the same offset, or
   * the same replacement string, is the same action and is denied; a different
   * offset or a different region is a different action and must never be
   * blocked. A path-only counter cannot make that distinction, so 0.2.0's
   * `readpath`/`writepath` limits were removed in 0.2.2 after both were
   * observed blocking ordinary work on the reference deployment.
   */
  limits: {
    exact: 3,
    cmd: 3,
    net: 3,
    sink: 3,
    site: 3,
    'family:http-fetch': 6,
    'verb:curl': 6,
    'verb:wget': 6,
  },
})

/**
 * Config keys removed in 0.2.0. A profile that still carries them would
 * silently lose its tuning when it upgrades, so each one fails the load with a
 * pointer at its replacement instead of being ignored.
 */
const REMOVED_KEYS = Object.freeze({
  denyAfter: 'use `limits.exact` (2 = deny the 2nd identical call)',
  warnAfter: 'the advisory tier was removed; the guard now denies instead of warning',
  registerAdvisory: 'the advisory tier was removed',
  maxSamePath: 'there is no path-only read cap; file actions are identified by position via `exact:`',
  readTools: 'read-like tools are detected from the tool name by `fingerprints()`',
  matchReadBySubstring: 'read-like tools are detected from the tool name by `fingerprints()`',
})

/** True for a non-null, non-array object. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Merge user config over {@link DEFAULTS}. Scalars replace; the three lookup
 * maps (`ignoreArgs`, `hostAliases`, `limits`) merge one level deep so a user
 * can add a host alias or retune one cap without restating the whole table;
 * everything else is copied.
 * @param config - raw plugin config from the patch.
 * @returns a detached, validated configuration.
 */
export function mergeDefaults(config = {}) {
  if (!isPlainObject(config)) throw new Error('repeat-tool-breaker: config must be an object')
  for (const key of Object.keys(config)) {
    if (key in REMOVED_KEYS) {
      throw new Error(
        `repeat-tool-breaker: \`${key}\` was removed in 0.2.0 — ${REMOVED_KEYS[key]}`,
      )
    }
  }
  const merged = { ...DEFAULTS, ...config }
  for (const key of ['ignoreArgs', 'hostAliases', 'limits']) {
    const value = config[key]
    if (value === undefined) {
      merged[key] = { ...DEFAULTS[key] }
      continue
    }
    if (!isPlainObject(value)) throw new Error(`repeat-tool-breaker: \`${key}\` must be an object`)
    merged[key] = { ...DEFAULTS[key], ...value }
  }
  for (const key of ['exclude', 'include']) {
    if (!Array.isArray(merged[key]) || merged[key].some((entry) => typeof entry !== 'string')) {
      throw new Error(`repeat-tool-breaker: \`${key}\` must be an array of strings`)
    }
    merged[key] = [...merged[key]]
  }
  return merged
}

/**
 * Fail-loud validation of a merged configuration. Everything the engine relies
 * on is checked here, at load time, rather than at the first denied call.
 * @param cfg - merged configuration.
 * @returns the same configuration.
 */
export function validateCfg(cfg) {
  if (!Number.isInteger(cfg.window) || cfg.window < 4) {
    throw new Error(`repeat-tool-breaker: \`window\` must be an integer >= 4 (got ${String(cfg.window)})`)
  }
  for (const key of ['previewChars', 'resultPreviewChars']) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < 1) {
      throw new Error(`repeat-tool-breaker: \`${key}\` must be an integer >= 1 (got ${String(cfg[key])})`)
    }
  }
  for (const [key, value] of Object.entries(cfg.limits)) {
    if (value === null) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 2) {
      throw new Error(
        `repeat-tool-breaker: limit "${key}" must be a finite number >= 2, or null to disable it (got ${String(value)})`,
      )
    }
  }
  return cfg
}
