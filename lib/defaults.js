/**
 * Default configuration for dsh-repeat-tool-breaker, plus the fail-loud
 * merge/validate pair used by `apply`.
 *
 * The model here is:
 *   - a bounded per-agent WINDOW of recent calls (not a consecutive-run
 *     counter), and
 *   - a set of FINGERPRINTS per call (`exact:`, `cmd:`, `net:`, `host:`,
 *     `site:`, `sink:`, `family:*`, `verb:*`), each with a `limits` entry.
 *
 * File operations (`read`/`write`/`edit`) are covered by `exact:` alone, which
 * identifies them by POSITION: an identical re-read or re-edit is denied, while a
 * different offset or a different edited region is a different action.
 *
 * A call is denied when any one of its fingerprints has ALREADY appeared
 * `limit` times in the window — i.e. the current call would be the `limit`-th
 * occurrence. The first occurrence of any fingerprint is therefore always
 * allowed.
 *
 * ## The two escalating tracks
 *
 * The OCCURRENCE track (0.4.0) — `limits` is the only threshold for the hard step;
 * the two advisory stages sit below it and never block:
 *
 *   - `warnAt`      (7)  — a light warning: you are repeating, consider another route
 *   - `summarizeAt` (11) — a demand: summarise progress, list untried alternatives
 *   - `limits[k]`   (12, `host` 16) — the gate: ask (`onLimit: ask`) or deny
 *
 * All three are ordinary, independent settings. **None is checked against
 * another**, on purpose: a `limits` entry at or below `warnAt` means the operator
 * does not want an escalation for that measure, and second-guessing a deliberate
 * choice would be worse than accepting it. A stage is simply "on" when its value
 * is a positive integer; `0`, a negative number, or `null` turns it off silently.
 *
 * One consequence is worth knowing rather than enforcing: the gate fires first, so
 * a `summarizeAt` at or above every cap can never speak. The shipped defaults keep
 * it strictly below, and moving one without the other is the operator's call.
 *
 * The FAILURE track (0.5.0) counts consecutive failures of one measure instead of
 * occurrences, on its own two settings — `failWarnAt` (3) and `failLimit` (5). It is
 * tighter because failure is the stronger signal, and it shares the measure set, the
 * gate, the exemptions and the refusal set with the occurrence track.
 *
 * ## The seven fingerprints, and the eighth
 *
 * `host:` is new in 0.4.0. `net:` keeps the query by design (`?page=2` is a
 * different resource), which makes it useless for spotting a fixed strategy: an
 * agent grinding one API produces entirely distinct `net:` strings. `site:`
 * collapses to the last two DNS labels, which merges unrelated services
 * (`api.weather.gc.ca` and every other `*.gc.ca` host become one identity). The
 * host is the level that actually identifies "the same target again".
 */

/** Recursively freeze a plain value graph (arrays included). */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

/**
 * Accepted values for `localHosts`. Since 0.4.0 this is only about whether local
 * traffic is fingerprinted at all; asking the operator moved to `onLimit`.
 */
export const LOCAL_HOST_POLICIES = Object.freeze(['deny', 'allow'])

/** Accepted values for `onLimit`: what happens when a `limits` entry is reached. */
export const ON_LIMIT_POLICIES = Object.freeze(['ask', 'deny'])

/**
 * Fields that are presentation or transport noise rather than action identity.
 * They are stripped before the `exact:` fingerprint is computed, which is what
 * defeats the "same command, `description: '1st'|'2nd'|'3rd'`" loop: those
 * values end up in NO fingerprint string at all.
 */
export const DEFAULTS = deepFreeze({
  /**
   * How many recent calls per agent participate in the counts. Moved from 12 to
   * 16 in 0.4.0, measured against both a corpus with known outcomes and the
   * production sessions: the wider window changed no verdict there (a failing
   * session reached a host count of 18 either way; the one successful session
   * that grinds stayed at 5), and it admits three more sessions at the gate
   * stage in production. Adopted for margin, not because 12 was shown to miss.
   */
  window: 16,
  /**
   * `deny` (default) — local traffic is counted and blocked like any other.
   * `allow`          — local hosts are never fingerprinted at all.
   *
   * The `ask` value was REMOVED in 0.4.0 and fails loud at load. Asking is no
   * longer a local-only concern: it is now what `onLimit` does for every measure,
   * so a config still carrying `localHosts: ask` is migrated to `onLimit: ask`.
   */
  localHosts: 'deny',
  /**
   * What happens when a call reaches its `limits` entry.
   *
   *   - `ask` (default) — offer the operator a turn-scoped exemption. This is
   *     FAIL-CLOSED: every unattended outcome of an approval is a denial
   *     (`rejected`, `cancelled`, and `unavailable` — the value the registry
   *     falls back to when no answerer is registered), so a headless profile
   *     denies by itself and nobody stalls. Approving exempts the fingerprints
   *     that hit, for the rest of that turn, and stops counting them; declining
   *     stops the asking for those fingerprints and behaves like `deny` until the
   *     next human message. At most one prompt per measure per turn.
   *   - `deny` — never ask; the call is denied outright.
   */
  onLimit: 'ask',
  /**
   * Stage 1: the light warning. Reach this count and the model is told it is
   * repeating and should consider another route. No block, no demand.
   *
   * A positive integer enables it; `0`, a negative number or `null` disables it
   * silently (that is the off-switch, not an error).
   */
  warnAt: 7,
  /**
   * Stage 2: the summary demand. Reach this count and the model must write its
   * progress and enumerate approaches it has not tried.
   *
   * Same on/off rule as `warnAt`.
   *
   * Must stay BELOW every `limits` entry that is meant to escalate: the gate fires
   * first, so a `summarizeAt` at or above a cap is dead code. The two move together
   * for that reason, which is why this is 11 and not the 6 it was through 0.4.1.
   */
  summarizeAt: 11,
  /**
   * Stage 1 of the FAILURE track: consecutive failures of one fingerprint. A run
   * of failures is a much stronger signal than mere repetition — repeating a call
   * that works is fixation, repeating one that fails is not learning — so the
   * failure thresholds sit well below the occurrence ones (7 / 11 / 12).
   *
   * Same on/off rule as `warnAt`.
   */
  failWarnAt: 3,
  /**
   * The FAILURE track's gate: after this many consecutive failures of one
   * fingerprint, a call carrying that fingerprint is blocked, subject to
   * `onLimit` exactly like the occurrence gate.
   *
   * Only the fingerprints that hit are blocked. A call that does not carry them —
   * reading the error log, grepping the code, trying a different endpoint — is
   * allowed, because blocking the recovery action is how a guard turns a stuck
   * model into a wedged one.
   *
   * `null` disables the gate (the advisory still works); anything else must be a
   * finite number >= 2, like a `limits` entry.
   */
  failLimit: 5,
  /**
   * Refuse HTTP fetches made FROM THE SHELL, and send the model to `web_fetch_file`.
   *
   * Detection is SEMANTIC, not by command name: a shell call is blocked when it
   * targets a non-local URL, which covers `curl`, `wget`, a `python3 -c` one-liner,
   * a `node -e`, a script written earlier and run — anything that has to name its
   * destination. Enumerating downloader names would have been trivially evaded by
   * `/usr/bin/curl`, and it would still have missed the interpreters.
   *
   * Why block at all, rather than infer failure afterwards: a shell fetch hides its
   * own outcome. `curl` exits 0 for a 404 without `--fail`, and `-o /dev/null` plus
   * `|| true` leaves NO in-band evidence whatsoever. A tool call cannot be masked
   * that way, so the block is what turns "did it fail" from a guess into a fact.
   */
  blockShellHttp: true,
  /**
   * Verbs the HTTP block leaves alone, because their network use is INCIDENTAL to a
   * local operation and there is no fetch-to-file replacement for them.
   *
   * The default is EVIDENCE-LED rather than guessed. A scan of every recorded session
   * (11006 shell calls, 3392 of them fetching a remote URL) found exactly three verbs
   * that actually make a network request: `curl` (3012), `git` (95) and `docker` (6).
   * `curl` is the block's target; the other two have no equivalent tool, so refusing
   * them would remove a capability rather than redirect one.
   *
   * Notably absent: `wget`, `npm`, `pip`, `uv`, `apt`, `go`, `cargo`, `gh`. Those never
   * carried a remote URL in the corpus, and the URL-less forms (`npm install foo`) are
   * not blocked anyway — only their URL/VCS-carrying forms are, and guessing that they
   * need the exemption would be speculation. Add them from Settings → Plugins when a
   * real workflow needs one; the box exists for exactly that.
   *
   * Set it to `[]` to refuse those two as well.
   */
  shellHttpAllow: ['git', 'docker'],
  /**
   * Whether the block also covers LOCAL addresses. Off by default, and that is a
   * functional decision rather than a lenient one: `web_fetch_file` reuses dsh's own
   * retrieval service and therefore inherits its SSRF guard, so it CANNOT reach
   * loopback or RFC1918. Blocking local fetches would leave no way to do them at
   * all — a lost capability, not a redirected one. Turn it on to forbid shell HTTP
   * outright.
   */
  blockLocalHttp: false,
  /**
   * Where `web_fetch_file` writes, relative to the workspace root unless absolute.
   *
   * It MUST be inside the workspace: `/tmp` does not survive between shell calls in
   * this harness (verified — a file written in one call is gone in the next), so a
   * fetched file there would be invisible to the command that is supposed to read it.
   */
  outputDir: 'fetched',
  /**
   * Our own byte cap on a saved body. The web provider caps first and its verdict
   * arrives as `truncated`; this is the backstop for a provider that does not.
   */
  maxBytes: 8 * 1024 * 1024,
  /** Head-truncation caps for text quoted back to the model. */
  previewChars: 400,
  resultPreviewChars: 800,
  /**
   * Whether local hosts participate in the `host:` measure. Default false: a
   * development loop against localhost is the canonical legitimate case, and the
   * documented `site:127.0.0.1` false positive came from exactly this class.
   * `localHosts: allow` still wins — it emits no target fingerprints at all.
   */
  includeLocal: false,
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
   * Per-fingerprint thresholds. A key is either a complete fingerprint (`cmd`,
   * `net`, … or an exact `family:x` / `verb:x`) or `null` to disable that kind.
   * A numeric entry must be a finite number >= 2, so the first call always
   * survives; it is the STAGE 3 threshold and nothing else — there is no separate
   * `gateAt`.
   *
   * The action-identity entries (`exact`, `cmd`, `net`, `sink`, `host`) are what
   * catch a loop. They are 12 (and `host` 16) rather than 9 because two advisory
   * stages sit underneath and must stay reachable: 7 warns, 11 demands a summary,
   * the cap gates. The history of the number: 2 was too low — it blocked the
   * ordinary retry after a failure unrelated to looping; 3 fixed that; 5 still
   * tripped dense legitimate work; 9 still fired on known-good runs, which reached
   * a peak of 6 while 10% of real work reaches 13. See docs/issue-b-thresholds.md
   * for the measurement.
   *
   * The volume budgets (`site`, `family:*`, `verb:*`) remain DISABLED (null): a
   * budget on how much one site or one verb may be used cannot tell a crawl from
   * progress, and every attempt to set one produced a false positive — four URLs
   * blocked by `family:http-fetch: 4`, a dev loop blocked by `site:127.0.0.1`, a
   * GitHub commit crawl blocked by `site:github.com`. The `host:` entry is NOT
   * one of those: it counts one target, which is what a fixed strategy looks
   * like, and it is measured (see docs/convergence-guard.md).
   *
   * `host` is higher than the rest because it is the coarser measure: it discards
   * the path, so installing many packages from one mirror and re-fetching one
   * broken URL look identical to it. It still fired on 25 of the 48
   * `(session, fingerprint)` pairs that reached a cap at 9. 16 is the window
   * itself — the whole window is one host — which is the strictest reading that
   * still escalates before saturation.
   *
   * There is deliberately NO cap on file operations. `read`/`write`/`edit` are
   * identified by POSITION through `exact:` — same file at the same offset, or
   * the same replacement string, is the same action; a different offset or region
   * is a different action and must never be blocked.
   */
  limits: {
    exact: 12,
    cmd: 12,
    net: 12,
    sink: 12,
    host: 16,
    site: null,
    'family:http-fetch': null,
    'verb:curl': null,
    'verb:wget': null,
  },
})

/** True for a non-null, non-array object. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Config keys removed in 0.2.0. A profile that still carries them would
 * silently lose its tuning when it upgrades, so each one fails the load with a
 * replacement rather than being ignored.
 */
const REMOVED_KEYS = Object.freeze({
  denyAfter: 'use `limits.exact` (2 = deny the 2nd identical call)',
  warnAfter: 'use `warnAt` (advisory) and `limits` (the denial)',
  registerAdvisory: 'use `warnAt` (advisory) and `limits` (the denial)',
  maxSamePath: 'there is no path-only read cap; file actions are identified by position via `exact:`',
  readTools: 'read-like tools are detected from the tool name by `fingerprints()`',
  matchReadBySubstring: 'read-like tools are detected from the tool name by `fingerprints()`',
})

/**
 * Normalize one advisory stage setting.
 *
 * `null`, `0` and negative numbers all mean "this stage is off" and are accepted
 * silently — that is the documented off-switch, not a mistake to catch. Anything
 * else must be a positive integer.
 * @param value - the raw setting.
 * @param key - the setting name, for the error message.
 * @returns `null` when disabled, otherwise the integer threshold.
 */
function stageThreshold(value, key) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `repeat-tool-breaker: \`${key}\` must be a number, or null/0/negative to disable it (got ${String(value)})`,
    )
  }
  if (value <= 0) return null
  if (!Number.isInteger(value)) {
    throw new Error(`repeat-tool-breaker: \`${key}\` must be an integer (got ${String(value)})`)
  }
  return value
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
  for (const key of ['exclude', 'include', 'shellHttpAllow']) {
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
 *
 * Each setting is checked on its own and nothing more. In particular the two
 * advisory stages are NOT compared with each other or with `limits`: inverted
 * stages simply fire in the other order, and a `limits` entry below a stage
 * simply never reaches it — both are legitimate ways to express intent.
 * @param cfg - merged configuration.
 * @returns the same configuration, with the stages normalized to integer-or-null.
 */
export function validateCfg(cfg) {
  if (!Number.isInteger(cfg.window) || cfg.window < 4) {
    throw new Error(`repeat-tool-breaker: \`window\` must be an integer >= 4 (got ${String(cfg.window)})`)
  }
  if (cfg.localHosts === 'ask') {
    throw new Error(
      'repeat-tool-breaker: `localHosts: ask` was removed in 0.4.0 — asking is now `onLimit: ask`, ' +
        'which covers every measure rather than only local addresses; `localHosts` accepts `deny` or `allow`',
    )
  }
  if (!LOCAL_HOST_POLICIES.includes(cfg.localHosts)) {
    throw new Error(
      `repeat-tool-breaker: \`localHosts\` must be one of ${LOCAL_HOST_POLICIES.join(', ')} (got ${String(cfg.localHosts)})`,
    )
  }
  if (!ON_LIMIT_POLICIES.includes(cfg.onLimit)) {
    throw new Error(
      `repeat-tool-breaker: \`onLimit\` must be one of ${ON_LIMIT_POLICIES.join(', ')} (got ${String(cfg.onLimit)})`,
    )
  }
  if (typeof cfg.includeLocal !== 'boolean') {
    throw new Error(`repeat-tool-breaker: \`includeLocal\` must be a boolean (got ${String(cfg.includeLocal)})`)
  }
  cfg.warnAt = stageThreshold(cfg.warnAt, 'warnAt')
  cfg.summarizeAt = stageThreshold(cfg.summarizeAt, 'summarizeAt')
  cfg.failWarnAt = stageThreshold(cfg.failWarnAt, 'failWarnAt')
  if (cfg.failLimit !== null) {
    if (typeof cfg.failLimit !== 'number' || !Number.isFinite(cfg.failLimit) || cfg.failLimit < 2) {
      throw new Error(
        `repeat-tool-breaker: \`failLimit\` must be a finite number >= 2, or null to disable the failure gate (got ${String(cfg.failLimit)})`,
      )
    }
  }
  for (const key of ['blockShellHttp', 'blockLocalHttp']) {
    if (typeof cfg[key] !== 'boolean') {
      throw new Error(`repeat-tool-breaker: \`${key}\` must be a boolean (got ${String(cfg[key])})`)
    }
  }
  if (typeof cfg.outputDir !== 'string' || cfg.outputDir.trim().length === 0) {
    throw new Error(`repeat-tool-breaker: \`outputDir\` must be a non-empty string (got ${String(cfg.outputDir)})`)
  }
  if (!Number.isInteger(cfg.maxBytes) || cfg.maxBytes < 1) {
    throw new Error(`repeat-tool-breaker: \`maxBytes\` must be an integer >= 1 (got ${String(cfg.maxBytes)})`)
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
