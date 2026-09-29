/**
 * Claude CLI stream events the plugin used to drop: `rate_limit_event`,
 * `system`/`init`, `system`/`compact_boundary`, and a `result` whose subtype
 * is not `success`.
 *
 * Every payload here is the shape read out of the CLI's own zod schemas in the
 * installed 2.1.263 bundle, so a parser that stops matching is a real drift
 * signal and not a fixture that went stale on its own.
 *
 * Usage: npx tsx --test test-cli-events.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  API_KEY_SOURCES,
  COMPACT_BOUNDARY_MARKER,
  RATE_LIMIT_MARKER,
  RESULT_ERROR_MARKER,
  _resetRateLimitReports,
  _resetSystemInitReports,
  _resetUnrecognizedModelReports,
  apiKeySourceWarning,
  describeRateLimit,
  describeResultFailure,
  formatCompactBoundaryNote,
  formatResetsAt,
  formatResultFailureNote,
  isRateLimitRejected,
  parseCompactBoundary,
  parseRateLimitEvent,
  parseMcpServerErrors,
  parseSystemInit,
  parseUnrecognizedModel,
  reportUnrecognizedModel,
  snapshotPluginLoadFailures,
  rateLimitKey,
  reportCompactBoundary,
  reportRateLimitEvent,
  reportSystemInit,
  describeMcpServerError,
  snapshotMcpServerErrors,
} from "./src/cli-events.js"
import { _resetLoggerForTests, configureLogger } from "./src/logger.js"
import type { ClaudeStreamMessage } from "./src/types.js"

/** Capture what reaches the TUI: only warn/error are unconditionally on stderr. */
function captureStderr<T>(run: () => T): { value: T; lines: string[] } {
  const lines: string[] = []
  const original = console.error
  console.error = (line: unknown) => {
    lines.push(String(line))
  }
  try {
    return { value: run(), lines }
  } finally {
    console.error = original
  }
}

const rejected: ClaudeStreamMessage = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "rejected",
    rateLimitType: "five_hour",
    resetsAt: 1_757_000_000,
    overageStatus: "rejected",
    overageDisabledReason: "org_level_disabled",
    isUsingOverage: false,
  },
}

test("parseRateLimitEvent reads the documented rate_limit_info shape", () => {
  const info = parseRateLimitEvent(rejected)
  assert.equal(info?.status, "rejected")
  assert.equal(info?.rateLimitType, "five_hour")
  assert.equal(info?.overageDisabledReason, "org_level_disabled")
  assert.equal(info?.resetsAt, 1_757_000_000)
  assert.equal(parseRateLimitEvent({ type: "result" }), null)
  assert.equal(parseRateLimitEvent({ type: "rate_limit_event" }), null)
})

test("formatResetsAt reads unix seconds and tolerates milliseconds", () => {
  assert.equal(formatResetsAt(1_757_000_000), "2025-09-04T15:33:20.000Z")
  assert.equal(formatResetsAt(1_757_000_000_000), "2025-09-04T15:33:20.000Z")
  assert.equal(formatResetsAt(undefined), undefined)
})

test("a rejection warns, explains the reason, and says what can be done", () => {
  const report = describeRateLimit(parseRateLimitEvent(rejected)!)
  assert.equal(report?.level, "warn")
  assert.match(report!.message, /out of usage in the 5-hour window/)
  assert.match(report!.message, /extra usage is disabled for your organization/)
  assert.match(report!.message, /Resets at 2025-09-04T15:33:20\.000Z/)
  assert.match(report!.message, /wait for the window to reset/)
  assert.ok(report!.transcript?.startsWith(`\n${RATE_LIMIT_MARKER} `))
})

test("an overage rejection on an allowed request is not a rejection", () => {
  // Measured on CLI 2.1.280 (2026-09-23) on a turn that was served: extra
  // usage being disabled for the org is a steady state, not a refusal.
  const served = parseRateLimitEvent({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      rateLimitType: "five_hour",
      resetsAt: 1_790_186_400,
      isUsingOverage: false,
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
    },
  })!
  assert.equal(isRateLimitRejected(served), false)
  const report = describeRateLimit(served)
  assert.notEqual(report?.level, "warn")
  assert.equal(report?.transcript, null)

  assert.equal(isRateLimitRejected({ ...served, status: "allowed_warning" }), false)
  assert.equal(isRateLimitRejected({ ...served, status: "rejected" }), true)
  // With no verdict of its own, an overage rejection still counts.
  assert.equal(isRateLimitRejected({ overageStatus: "rejected" }), true)
})

test("a warning state is a notice with nothing in the transcript", () => {
  const report = describeRateLimit(
    parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.82 },
    })!,
  )
  assert.equal(report?.level, "notice")
  assert.match(report!.message, /82% used/)
  assert.equal(report!.transcript, null)
})

test("rate limits warn once per identity per process", () => {
  _resetLoggerForTests()
  _resetRateLimitReports()
  configureLogger({ file: false, mode: "silent", level: "info" })

  const first = captureStderr(() => reportRateLimitEvent(rejected))
  assert.ok(first.value?.includes(RATE_LIMIT_MARKER), "the first rejection is surfaced")
  assert.equal(first.lines.length, 1, "and warns in the TUI")

  const second = captureStderr(() => reportRateLimitEvent(rejected))
  assert.equal(second.value, null, "the same rejection is not repeated")
  assert.equal(second.lines.length, 0)

  const other = captureStderr(() =>
    reportRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "seven_day" },
    }),
  )
  assert.ok(other.value, "a different window is its own warning")
  assert.equal(other.lines.length, 1)
  _resetLoggerForTests()
})

test("rateLimitKey separates the window, the overage status and the reason", () => {
  assert.notEqual(
    rateLimitKey({ status: "rejected", rateLimitType: "five_hour" }),
    rateLimitKey({ status: "rejected", rateLimitType: "seven_day" }),
  )
  assert.notEqual(
    rateLimitKey({ status: "rejected", overageDisabledReason: "out_of_credits" }),
    rateLimitKey({ status: "rejected", overageDisabledReason: "org_level_disabled" }),
  )
})

const init: ClaudeStreamMessage = {
  type: "system",
  subtype: "init",
  apiKeySource: "ANTHROPIC_API_KEY",
  permissionMode: "default",
  model: "claude-opus-5",
  claude_code_version: "2.1.263",
  tools: ["Bash", "Read", "Write"],
  mcp_servers: [
    { name: "github", status: "connected" },
    { name: "slack", status: "failed" },
  ],
}

test("parseSystemInit reads the init fields worth reporting", () => {
  const info = parseSystemInit(init)
  assert.equal(info?.apiKeySource, "ANTHROPIC_API_KEY")
  assert.equal(info?.permissionMode, "default")
  assert.equal(info?.model, "claude-opus-5")
  assert.equal(info?.cliVersion, "2.1.263")
  assert.equal(info?.toolCount, 3)
  assert.deepEqual(info?.mcpServers, [
    { name: "github", status: "connected" },
    { name: "slack", status: "failed" },
  ])
  assert.equal(parseSystemInit({ type: "system", subtype: "compact_boundary" }), null)
  assert.deepEqual(info?.mcpServerErrors, [], "the key is omitted when nothing was skipped")
})

/**
 * Verbatim from a live 2.1.280 probe: `claude -p --output-format stream-json
 * --verbose --mcp-config bad-mcp.json --strict-mcp-config`, where bad-mcp.json
 * declared a `url` entry with no `type` and an entry with an invented `type`.
 * Both servers were absent from `mcp_servers`, which was `[]`.
 */
const initWithSkips: ClaudeStreamMessage = {
  type: "system",
  subtype: "init",
  apiKeySource: "none",
  claude_code_version: "2.1.280",
  tools: ["Bash"],
  mcp_servers: [],
  mcp_server_errors: [
    {
      name: "no_type_entry",
      type: "url_missing_type",
      message:
        'Skipped - MCP server "no_type_entry" has a "url" but no "type"; add "type": "http" (or "sse" / "ws") to this entry',
    },
    { name: "bogus", type: "unknown_type", message: 'Skipped - unknown MCP server type "nonsense_type" for server "bogus"' },
  ],
}

test("mcp_server_errors is parsed off the init frame and survives junk", () => {
  const errors = parseMcpServerErrors(initWithSkips)
  assert.equal(errors.length, 2)
  assert.deepEqual(
    errors.map((error) => [error.name, error.type]),
    [
      ["no_type_entry", "url_missing_type"],
      ["bogus", "unknown_type"],
    ],
  )
  // The key is optional, so its absence is the common case and never an error.
  assert.deepEqual(parseMcpServerErrors(init), [])
  assert.deepEqual(parseMcpServerErrors({ type: "system", subtype: "init" }), [])
  // Defensive: a future CLI that changes the element shape must not throw.
  assert.deepEqual(
    parseMcpServerErrors({ type: "system", subtype: "init", mcp_server_errors: "nope" as never }),
    [],
  )
  const partial = parseMcpServerErrors({
    type: "system",
    subtype: "init",
    mcp_server_errors: [{}, null as never, { name: "x" }],
  })
  assert.deepEqual(partial, [
    { name: "unknown", type: "unknown", message: "" },
    { name: "x", type: "unknown", message: "" },
  ])
})

test("a skipped server says what to fix, and the plugin's own proxy says more", () => {
  const theirs = describeMcpServerError({
    name: "github",
    type: "url_missing_type",
    message: "Skipped - ...",
  })
  assert.match(theirs, /skipped MCP server "github"/)
  assert.match(theirs, /has a `url` but no `type`/)
  assert.match(theirs, /Fix the entry in your MCP config/)

  // The plugin writes its own --mcp-config, so this one is never the user's
  // fault and the consequence is every proxied tool call, not a few tools.
  const ours = describeMcpServerError({
    name: "opencode_proxy",
    type: "invalid_config",
    message: "Skipped - ...",
  })
  assert.match(ours, /plugin's own MCP server/)
  assert.match(ours, /every proxied tool call this session will fail/)
  assert.doesNotMatch(ours, /your own MCP settings\./)

  // An unrecognised category is a generic skip, as the CLI's schema instructs.
  const unknown = describeMcpServerError({ name: "x", type: "brand_new_thing", message: "" })
  assert.match(unknown, /\(brand_new_thing\)/)
  assert.doesNotMatch(unknown, /because/)
})

test("a skipped server warns once per identity per process and is kept for the doctor", () => {
  _resetLoggerForTests()
  _resetSystemInitReports()
  configureLogger({ file: false, mode: "silent", level: "info" })

  const first = captureStderr(() => reportSystemInit(initWithSkips, {}))
  assert.equal(first.lines.length, 2, "one warning per skipped entry, and no MCP-status noise")
  assert.ok(first.lines.some((line) => line.includes("no_type_entry")))
  assert.ok(first.lines.some((line) => line.includes("bogus")))

  const second = captureStderr(() => reportSystemInit(initWithSkips, {}))
  assert.equal(second.lines.length, 0, "a respawn must not repeat the warning")

  // The WARN only reaches stderr and a log file that is off by default, so the
  // doctor needs its own copy or the diagnostic is unretrievable.
  assert.deepEqual(
    snapshotMcpServerErrors().map((error) => error.name),
    ["no_type_entry", "bogus"],
  )
  _resetSystemInitReports()
  assert.deepEqual(snapshotMcpServerErrors(), [])
  _resetLoggerForTests()
})

test("apiKeySourceWarning fires for a key and stays quiet for the subscription", () => {
  assert.equal(apiKeySourceWarning("oauth", false), null)
  assert.equal(apiKeySourceWarning("none", false), null)
  assert.equal(apiKeySourceWarning(undefined, false), null)
  for (const source of API_KEY_SOURCES) {
    assert.ok(apiKeySourceWarning(source, false), `expected a warning for ${source}`)
  }
  assert.match(apiKeySourceWarning("ANTHROPIC_API_KEY", false)!, /ignoreAnthropicApiKey: true/)
  // Already stripping the env vars, so the key came from the CLI's own config
  // and the option is not the fix to suggest.
  assert.match(apiKeySourceWarning("ANTHROPIC_API_KEY", true)!, /claude config/)
})

test("init warns once per failed MCP server and once per api key source", () => {
  _resetLoggerForTests()
  _resetSystemInitReports()
  configureLogger({ file: false, mode: "silent", level: "info" })

  const first = captureStderr(() => reportSystemInit(init, {}))
  assert.equal(first.lines.length, 2, "one for the failed MCP server, one for the API key")
  assert.ok(first.lines.some((line) => line.includes('"slack" is failed')))
  assert.ok(first.lines.some((line) => line.includes("apiKeySource: ANTHROPIC_API_KEY")))
  assert.equal(
    first.lines.some((line) => line.includes("github")),
    false,
    "a connected server is not a warning",
  )

  const second = captureStderr(() => reportSystemInit(init, {}))
  assert.equal(second.lines.length, 0, "a respawn must not repeat either warning")
  _resetLoggerForTests()
})

test("compact_boundary is parsed from either spelling of its metadata", () => {
  const streamShape = parseCompactBoundary({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "auto", pre_tokens: 180_000, post_tokens: 40_000 },
  })
  assert.deepEqual(streamShape, { trigger: "auto", preTokens: 180_000, postTokens: 40_000 })

  const transcriptShape = parseCompactBoundary({
    type: "system",
    subtype: "compact_boundary",
    compactMetadata: { trigger: "manual" },
  })
  assert.deepEqual(transcriptShape, {
    trigger: "manual",
    preTokens: undefined,
    postTokens: undefined,
  })

  assert.equal(parseCompactBoundary({ type: "system", subtype: "init" }), null)
})

test("a compaction the CLI did on its own is announced in the transcript", () => {
  _resetLoggerForTests()
  configureLogger({ file: false, mode: "silent", level: "info" })
  const note = reportCompactBoundary({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "auto", pre_tokens: 180_000, post_tokens: 40_000 },
  })
  assert.ok(note?.includes(COMPACT_BOUNDARY_MARKER))
  assert.match(note!, /on its own \(180,000 tokens to 40,000\)/)
  assert.equal(reportCompactBoundary({ type: "result" }), null)
  assert.match(
    formatCompactBoundaryNote({ trigger: "manual" }),
    /on a manual request\. Earlier detail/,
  )
  _resetLoggerForTests()
})

test("a failing result subtype is named, a successful one is not", () => {
  assert.equal(describeResultFailure({ type: "result", subtype: "success" }), null)
  assert.equal(describeResultFailure({ type: "result" }), null)
  assert.equal(describeResultFailure({ type: "assistant", subtype: "error_max_turns" }), null)

  const known = describeResultFailure({ type: "result", subtype: "error_max_turns" })
  assert.match(known!, /error_max_turns/)
  assert.match(known!, /internal turn limit/)

  const unknown = describeResultFailure({ type: "result", subtype: "error_from_a_future_cli" })
  assert.equal(unknown, "Claude Code ended the turn with `error_from_a_future_cli`.")
  assert.ok(formatResultFailureNote(known!).startsWith(`\n${RESULT_ERROR_MARKER} `))
})

// Verbatim from Claude Code 2.1.280 running `claude-sonnet-5-5` in the
// plugin's own mode (`-p`, stream-json, verbose), 2026-09-30. A model the CLI
// knows writes nothing to stderr at all.
const UNRECOGNIZED_MODEL_LINE =
  '[claude-code:unrecognized_model] {"model":"claude-sonnet-5-5","query_source":"sdk"}\n'

test("the CLI's unrecognized_model stderr line names the model", () => {
  assert.deepEqual(parseUnrecognizedModel(UNRECOGNIZED_MODEL_LINE), { model: "claude-sonnet-5-5" })
  assert.deepEqual(
    parseUnrecognizedModel(`some earlier output\n${UNRECOGNIZED_MODEL_LINE}`),
    { model: "claude-sonnet-5-5" },
    "found anywhere in a stderr chunk",
  )
  assert.deepEqual(
    parseUnrecognizedModel("[claude-code:unrecognized_model] {not json"),
    { model: undefined },
    "a payload that does not parse still counts",
  )
  assert.equal(parseUnrecognizedModel("No conversation found with session ID: x"), null)
  assert.equal(parseUnrecognizedModel(""), null)
})

test("an unrecognized model warns once per model per process, with the fix", () => {
  _resetLoggerForTests()
  _resetUnrecognizedModelReports()
  configureLogger({ file: false, mode: "silent", level: "info" })

  const first = captureStderr(() => reportUnrecognizedModel(UNRECOGNIZED_MODEL_LINE))
  assert.equal(first.lines.length, 1, "the first sighting warns")
  assert.match(first.lines[0], /does not recognise the model "claude-sonnet-5-5"/)
  assert.match(first.lines[0], /200k/)
  assert.match(first.lines[0], /2\.1\.284/, "names the release that added it")

  const again = captureStderr(() => reportUnrecognizedModel(UNRECOGNIZED_MODEL_LINE))
  assert.equal(again.lines.length, 0, "the CLI repeats it every turn; the warning does not")

  const other = captureStderr(() =>
    reportUnrecognizedModel('[claude-code:unrecognized_model] {"model":"claude-next-1"}'),
  )
  assert.equal(other.lines.length, 1, "a different model is its own warning")
  assert.match(other.lines[0], /claude update/, "an unknown floor still says how to fix it")
  assert.doesNotMatch(other.lines[0], /2\.1\.284/)

  const unrelated = captureStderr(() => reportUnrecognizedModel("some other stderr"))
  assert.equal(unrelated.lines.length, 0)
  _resetLoggerForTests()
})

// The init fields Claude Code 2.1.280 sent with two `--plugin-dir`s, one of
// them declaring a dependency that is not installed (2026-09-30). The demoted
// plugin is absent from `plugins[]`; a diagnostic names a plugin as
// `name@source`, which is what a loaded entry carries in `source`.
const pluginInit = {
  type: "system",
  subtype: "init",
  session_id: "s",
  tools: [],
  mcp_servers: [],
  plugins: [{ name: "probe-shadow", path: "/tmp/plugprobe/shadow", source: "probe-shadow@inline" }],
  plugin_errors: [
    {
      plugin: "probe-dep@inline",
      type: "dependency-unsatisfied",
      message:
        'Dependency "no-such-plugin-xyz" is not installed \u2014 run `claude plugin install no-such-plugin-xyz`, or check that its marketplace is added',
    },
  ],
} as unknown as ClaudeStreamMessage

test("parseSystemInit reads plugin errors, warnings and the plugins that loaded", () => {
  const info = parseSystemInit(pluginInit)!
  assert.deepEqual(info.pluginErrors.map((d) => [d.plugin, d.type]), [
    ["probe-dep@inline", "dependency-unsatisfied"],
  ])
  assert.deepEqual(info.pluginWarnings, [], "an omitted key is no warnings")
  assert.deepEqual(info.loadedPlugins, ["probe-shadow@inline", "probe-shadow"])

  const clean = parseSystemInit(init)!
  assert.deepEqual(clean.pluginErrors, [])
  assert.deepEqual(clean.loadedPlugins, [])
})

test("a plugin that did not load warns once; an advisory warning for a loaded one does not", () => {
  _resetLoggerForTests()
  _resetSystemInitReports()
  configureLogger({ file: false, mode: "silent", level: "info" })

  const first = captureStderr(() => reportSystemInit(pluginInit))
  const failed = first.lines.filter((line) => line.includes("did not load"))
  assert.equal(failed.length, 1, first.lines.join("\n"))
  assert.match(failed[0], /plugin "probe-dep@inline" \(dependency-unsatisfied\)/)
  assert.match(failed[0], /no-such-plugin-xyz/, "Claude Code's own sentence is kept")

  const again = captureStderr(() => reportSystemInit(pluginInit))
  assert.equal(again.lines.filter((line) => line.includes("did not load")).length, 0)

  // The schema: a warning whose plugin loaded is advisory; one with no match
  // in `plugins[]` describes content that did NOT load.
  const withWarnings = {
    ...(pluginInit as object),
    plugin_errors: undefined,
    plugin_warnings: [
      { plugin: "probe-shadow@inline", type: "folder-shadowed", message: "skills/ is shadowed" },
      { plugin: "workspace@settings", type: "suppressed", message: "suppressed by policy" },
    ],
  } as unknown as ClaudeStreamMessage
  const warned = captureStderr(() => reportSystemInit(withWarnings))
  const loudWarnings = warned.lines.filter((line) => line.includes("did not load"))
  assert.equal(loudWarnings.length, 1, "only the warning whose content did not load")
  assert.match(loudWarnings[0], /workspace@settings/)
  assert.equal(warned.lines.some((line) => line.includes("probe-shadow")), false)

  // The bridge's own plugin is never the user's to fix.
  const bridge = captureStderr(() =>
    reportSystemInit({
      ...(pluginInit as object),
      plugin_errors: [{ plugin: "opencode-skills@inline", type: "invalid-manifest", message: "bad" }],
    } as unknown as ClaudeStreamMessage),
  )
  const bridgeLine = bridge.lines.find((line) => line.includes("opencode-skills"))
  assert.ok(bridgeLine, bridge.lines.join("\n"))
  assert.match(bridgeLine!, /skill bridge/)
  assert.match(bridgeLine!, /report it/)

  const kept = snapshotPluginLoadFailures().map((d) => `${d.kind}:${d.plugin}`)
  assert.deepEqual(kept.sort(), [
    "error:opencode-skills@inline",
    "error:probe-dep@inline",
    "warning:workspace@settings",
  ])
  _resetLoggerForTests()
})
