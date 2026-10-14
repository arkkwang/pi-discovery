English | [简体中文](README.zh-CN.md)

# pi-discovery

A unified capability discovery and trajectory review extension for the Pi coding agent, delivering three things in a single Pi extension package:

- **Unified capability discovery**: overrides the host `tool_search`, discovering and loading Skills, MCP, and deferred tools by natural language or exact name;
- **Automatic preparation (prefetch)**: after user input is received and before the first main model request, predicts the capabilities and next actions the current task needs;
- **Periodic trajectory review**: every N steps, reviews the execution trajectory against the system prompt, Skill principles, and the user request, producing minimal two-string pair reminders.

Automatic capability/action prediction and periodic trajectory review are **different entry points, different prompt templates, different outputs**; they only share the tool-free model request adapter layer.

Built on the official `@earendil-works/pi-coding-agent` (the `openai-completions` model API); requires Node.js 22.19+. Automatic preparation and periodic review depend on the [pi-snap](https://github.com/arkkwang/pi-snap) CLI to read the execution trajectory; manual `tool_search` does not.

## Install

```bash
pi install npm:@arkkwang/pi-discovery
```

Or clone this repository and install the local package from the repository root:

```bash
pi install .
```

Trajectory-related features additionally require pi-snap **≥0.5.0** on `PATH` (`npm install -g @arkkwang/pi-snap`), with the explicit `trace` view. The retired `--preset`/`--trace` flags are not accepted. This extension does not upgrade the command itself. When the CLI is missing or fails, prediction/review fails explicitly; the surrounding warning and diagnostic fail-open keep the main task continuing.

## Configuration

```json
{
  "capabilityDiscovery": {
    "provider": "zai-coding-cn",
    "model": "glm-5.3-flash",
    "capabilityPrediction": true,
    "actionPrediction": true,
    "trajectoryWarnings": true,
    "trajectoryWarningEverySteps": 15,
    "maxSuggestedActions": 3,
    "autoRecommendThinkingLevel": "low",
    "toolSearchThinkingLevel": "medium"
  }
}
```

Write it to Pi's `settings.json`. The defaults differ from the explicit configuration above: all three features default to off, the model defaults to `llama/iq3`, the period defaults to 5, the action cap defaults to 3, and both thinking levels default to `medium`. Legacy keys (`trajectoryWarningOnUserInput`, `autoRecommend`, nested `prefetch`, and other unknown keys) are not accepted and cause the entire `capabilityDiscovery` configuration to be rejected.

| Entry point | Invocation and input | Output |
| --- | --- | --- |
| After user input is received, before the first main model request | Calls only `runPrefetch`; capability catalog, current request/recent background; when actions are enabled, additionally the project index, retained reads, and the action budget | `suggestions` and `actions` in the object, containing only enabled fields; **never warnings** |
| Every N steps | Calls only `runTrajectoryReview`; execution trajectory, a Skill-only table of names/descriptions/paths, the main agent's current system prompt, and the user request | A list of minimal two-string pairs; `[]` when there are no issues |
| Manual `tool_search` | Natural-language queries use independent semantic search; exact names/lists need no model | Capability suggestions and actual load results |

- A step is an SDK `turn_end`: one assistant round and its tool executions completed; parallel tool batches count as one step. New user input resets the counter. Review happens every time N steps are reached, without first guessing whether there are problems; no error/risk pre-filtering is added. Cancelled calls are not dispatched.
- `trajectoryWarningEverySteps` is an integer from 0–1000; 0 disables the period. `trajectoryWarnings=false` also disables the review, but does not affect the initial capability/action prediction.
- `maxSuggestedActions` is an integer from 0–8. When actions are disabled or the budget is 0, the project tree is not scanned and no actions are executed.
- Automatic preparation and periodic review use `autoRecommendThinkingLevel`; manual search uses `toolSearchThinkingLevel`. Supported values are `off/minimal/low/medium/high/xhigh/max`; mapping is decided by the model and is not affected by the main session's thinking level.
- Each trigger makes at most one model request, sharing that trigger's 60-second budget; no automatic retry/compaction. Periodic reminders enter the next naturally occurring main model request, without forcing a continuation and without being interrupted into an approval gate.
- Recommendations are not execution authorization, and structural validation cannot guarantee the model's semantic accuracy.

## Periodic review: helping do work well, completely, and correctly

The review focuses on required methods not being used in time, skipped prerequisites, direction drift, stalled progress, and false completion—not comprehensive compliance audits or checking which MCP tool should be used.

The principle sources are the actually provided system prompt, user request, and Skill table; the execution trajectory is the object being judged. A Skill description can only support methods and applicable scenarios expressed in its original text, cannot invent principles from its body content, and will not automatically read or expand sub-documents. Rules must correspond to the current task, object, and phase; other pending decision items are not carried over merely because their directory shares a parent path.

Output example:

```json
[["Began implementation before confirming the statistical criteria; ask the user to confirm the definition of active users first.", "User request: confirm the definition of active users with me first."]]
```

Each item is exactly two non-empty strings: `[where it deviated and what to do, principle source and original text]`. No multi-field objects, observed/missing-evidence, or filler targets. Work in normal progress, future obligations not yet due, summaries lacking information, already-corrected history, correct behavior, or praise produce no reminders. Reminders still rely on model judgment; they are not a deterministic safety check.

## Templates, schema, and host validation

- `prompts.js` provides separate preparation and review templates. The System part contains only fixed responsibilities and format guidance; the catalog, paths, budget, main agent system/user content, and output schema go into the User part, so dynamic material is not elevated into system-level authority for the review model.
- The preparation schema picks its shape based on enabled fields but does not grow with the catalog, paths, or budget; `suggestions.id` and `read.path` are strings. Manual search also removes the catalog ID enum. The review schema is fixed as an array of two-string arrays.
- Requests carry `response_format.type=json_schema, strict=true`; the host still validates, per call, the capability IDs for that round, actual candidate paths, the action cap, and parameter constraints. Unknown IDs/paths, extra warnings fields, or malformed two-string pairs are rejected; lenient parsing is not used to repair model output, and there is no automatic retry.
- Some compatible services do not strictly enforce the schema. An actual Flash model once output a non-empty two-string pair as the invalid `[{"string","string"}]`; the template now explicitly provides the complete `[["reminder","source and original text"]]` example, and the outer layer still strictly rejects wrong formats.

## Automatic preparation and read reuse

The isolated SDK session does not load user extensions, MCP, project instructions, or tools. The model only selects suggestions; the host then executes the allowed `read`/Bash; results are not sent back to the prediction model. The preparation feature does not perform trajectory review.

- The capability catalog contains Skills, MCP, and deferred/codemode tools; hidden tools are not included; it does not wait for MCP readiness and does not auto-activate. The main model loads them on demand via `tool_search`.
- A Skill's name, full description, and SKILL.md path are placed in the same entry; at most the entry file is read automatically, and internal reference materials are selected by the main agent.
- Project indexing is breadth-first, capped at 3 levels / 200 entries / 6000 characters / 2000 visited entries / 100 ms; it respects the local `.gitignore`, skips hidden directories, dependency/build directories, and credential names, and does not follow directory symlinks. Omission does not prove absence.
- Project files use `project:<relative-path>`; Skills use real paths inside their directories. Before reading, candidate paths, real directory scope, text type, and size are re-checked: 50,000 bytes per file, 100,000 bytes in total.
- Bash commands are model-generated, non-empty, at most 2000 characters, with no NUL; the native tool timeout is 2 seconds. The prompt prefers read-only operations, but **this is not a programmatically enforced read-only sandbox**; there is no guarantee that arbitrary commands are side-effect free.
- Read deduplication uses the current effective context projection; the historical trajectory cannot be used as evidence that content is still present. Only complete, successful reads that have not been invalidated by context edits/potential modifications directly cover a file; partial reads, failures, and compaction removals do not. Bash/opaque tools conservatively invalidate freshness; if a selected file still has complete retained content, only that file is checked, and re-reading is skipped only when the content is identical. Symlink aliases are not merged.

## Execution trajectory and events

Both entry points asynchronously invoke `pi-snap <sessionManager.getSessionFile()> --view trace --max-chars 0 --tail 160`. This explicitly selects user/assistant messages, tool-call requests, behavior recommendations, and prior corrective warnings on the current branch, excluding thinking, images, and tool results (including errors and preparation results). `--max-chars 0` avoids per-row clipping before the total budget below retains recent content. The view owns filtering and single-line presentation; rows carry the source tag chain and tool names in the body (`→ read`, `← read`); the adapter neither relies on pi-snap's default output nor infers execution success. Full evidence can be opened using the displayed record numbers. This extension does not parse historical messages to build a separate trajectory; read deduplication still independently uses the SDK's effective context projection.

The host passes independent arguments via the fixed Bash command `exec pi-snap "$@"`, compatible with Git Bash/macOS Bash; it does not concatenate paths into a shell script, does not look up installation directories, and adds no local npm dependencies. A single CLI call times out at 5 seconds, inherits the trigger's cancellation signal, and its stdout/stderr buffers are each capped at 8 MiB; this is included in the 60-second total budget. Only the most recent 6000 characters of the output string are retained, with truncation marked; semantics are not reinterpreted. The current request at the beginning independently keeps roughly the first and last 4000 characters. Omitted tool parameters or early records do not prove they did not exist.

The file contract has been verified with the SDK: messages/tool results are appended synchronously, and turn_end comes after the save; a bare branch() only changes memory, but this extension already appends `capability-prefetch-diagnostic/start` synchronously before reading, linking the file's last record to the currently active branch. If this write fails, it reports an explicit error and skips prediction/review rather than reading a possibly stale branch. When there are no historical messages before the first input, the empty background is normal and the CLI is not called; when history exists but the file is unreadable, or the CLI is missing/fails/returns empty output, each case fails explicitly, with the surrounding warning + diagnostic fail-open keeping the main task continuing—no fallback to a self-made trajectory or pretending the history is empty.

## Sessions and host integration

- Preparation and review each create a file-persisted child session, saving the actual input and raw model output; failures also leave evidence. The preparation session records the host execution source and saves real tool results. Main-session diagnostic entries record the child session's absolute path, request count, elapsed time, and failure status; they do not enter the main model context.
- Child sessions use the SDK's default `sessions` storage, with cwd fixed to `path.join(os.tmpdir(), 'pi-discovery')`; they appear normally in the Pi session list, with no custom sessionDir and no hiding. The prediction model and resource loaders reuse this cwd; project indexing and preparation actions still use the main task's cwd. File names keep the SDK default `timestamp_ID.jsonl`; the session name is `pi-discovery · preparation|trajectory · provider/model · full session ID`, and origin preserves the parent session ID/file/leaf ID. You can inspect them directly with `pi-snap <ID prefix>`.
- Input preparation runs through the `context` hook: `before_agent_start` only assembles the catalog and saves this round's request, without waiting for the recommendation model. The host first acknowledges receipt and saves the user message, then waits for the recommendation before the main model request. The current request uses the results directly; `sendMessage(..., {triggerTurn:false})` saves the same results as `capability-prefetch` at a safe turn boundary, without triggering an extra model turn. Subsequent context projections only expand tool records and do not replay execution.
- The same round shares one preparation Promise; repeated context transformations, request retries, and subsequent tool turns do not re-run recommendations or re-save. Cancellation, session switching, branch switching, and run termination invalidate pending results; once a persisted carrier has been removed by compaction or context edit, it is not revived from the memory cache. Periodic two-string pairs are still persisted in `capability-trajectory-warning`.
- `index.js` uses the running Pi's public MCP/tool-search factories and does not install a second SDK. The original tool_search schema object identity, model-only/defaultActive, MCP connection/OAuth/permissions, and BM25/activation logic are preserved.
- Wraps the MCP `before_agent_start`; after the original catalog is generated, they are merged into a single capability catalog. A Skill's `metadata.catalog-description` is only used for the main model's short catalog; semantic prediction/review still uses the host's full description. Each input reads the already-parsed Skill file metadata instead of scanning directories.
- Tool loading follows the host mechanism and does not repeatedly unload. Astra supports appending `additional_tools`; other interfaces may update top-level tools, and this plugin does not promise zero prefix-cache loss for all models.

### Investigating preparation and review from the parent session

Parent JSONL entries with `customType: capability-prefetch-diagnostic` index the evidence without entering model context. New entries carry `version: 1`, an `inputId` per user input, and the preceding `parentLeafId`. An `attempt` links one prediction/review; `preparationId` links the preparation carrier to context delivery.

| Event | Evidence |
| --- | --- |
| `input` | Full `configuredOptions`, whether preparation is scheduled, and `resetFromSteps` before the new input resets the counter |
| `gate` | Each completed round's review decision: `due`, `below-interval`, `disabled`, `zero-interval`, `cancelled`, or `invalid-settings`, with `steps` and `interval` |
| `start` | `configuredOptions` versus path-local `effectiveOptions`; preparation disabling trajectory review does not mean the global switch is off |
| `session` / `review-input` | Child session location and review input sources, character counts and trajectory truncation; exact input and raw model output remain in the child JSONL |
| `complete` / `failure` | Requests, actions, timing and failures; review distinguishes `warnings`, `no-warnings` and `failed` |
| `context-ready` | First context-hook delivery: `direct` injection, already in `history`, `removed-from-context` without revival, or `no-message`; includes projected tool-call IDs |

Use `pi-snap SESSION --only customType:capability-prefetch-diagnostic` to locate diagnostics, then `pi-snap SESSION ENTRY --json` for their fields. ENTRY accepts a displayed record number or original ID. Follow `childSession.file` / `id` for full inference evidence. Actual preparation arguments/results live in `capability-prefetch.details.prefetch.rounds[].messages`: their epoch-millisecond timestamps describe actions, while the parent timestamp may describe deferred persistence. Do not infer execution order from the carrier's position alone.

Evidence limits: `context-ready` proves this extension returned context, not provider receipt or model compliance; later host processing may change the request. Review currently receives system instructions, the current request, Skill descriptions and a bounded trajectory, not full retained Skill bodies or tool-result bodies; `review-input` makes this coverage explicit. No warning is not authorization. Missing events in older logs do not establish global settings or skip reasons; process crashes and logging failures may also leave incomplete attempts.

### Receive acknowledgment separated from recommendation latency

Real Pi SDK isolated tests replace external models with a fake provider / fake recommender and make no network inference calls: with the recommendation fixed to block for 10 seconds, the receive acknowledgment was measured to return in about 3ms, the user message and session file already existed, and the main provider request count was still 0; only after the recommendation was released did the main model receive the request with suggestions. Tool turns do not re-run recommendations, and late results after cancellation do not enter the next input. There are additional regressions covering concurrent context, session switching, and removed context not being revived. What is measured here is the SDK acknowledgment boundary, not full HTTP/mobile end-to-end latency; waits for MCP connection and session initialization can still exist.

## Manual search

```json
{"query":"Open the web page, check the interaction feedback, and fix the code issues","limit":8}
{"query":"skill:engineering-practice"}
{"query":"mcp:mcp__playwright"}
{"query":"notify"}
{"query":"*","limit":100}
```

Natural-language queries get semantic recommendations based on the full description, then native search is invoked within the selected scope; exact names ignore case, with `skill:`/`mcp:`/`tool:` disambiguation. `*` only lists the catalog, without inference/loading. Original tool parameters are preserved; limit defaults to 8, and there is no offset. Returns `mode/total/suggestions/loaded/availableTools`; already-loaded tools are not activated again, and Skills require reading their body content. confidence is an uncalibrated, model self-assessed relevance, not an execution threshold. On model failure, it returns an explicit `routingError` and attempts native search, instead of faking a complete no-match result.

## Verification

Run from the repository root:

```bash
npm test
PI_DISCOVERY_SDK_ROOT=<Pi package directory> npm test
# Four pre-fixed Flash probes; no Bash/MCP/preparation actions are executed:
PI_DISCOVERY_SDK_ROOT=<Pi package directory> PI_DISCOVERY_OBSERVER_LIVE=1 node --test test/observer-live.test.mjs
```

Tests involving trajectory use a temporary PATH shim pointing at the sibling `pi-snap` source repository; `PI_SNAP_SOURCE=<source repository>` can also be set. When the sibling checkout is absent, the affected tests skip automatically; an explicitly set `PI_SNAP_SOURCE` that does not resolve fails loudly instead. They neither depend on nor rewrite the actual installation. Real SDK tests additionally require `PI_DISCOVERY_SDK_ROOT`.

Deterministic tests and real SDK regressions run in the GitHub Actions Ubuntu/macOS/Windows matrix; live tests (real model requests) are skipped by default and run only when the corresponding environment variable is explicitly set.

### Known limitations

- Periodic reminder quality, false-positive rate, and stable latency depend on the specific model; structural validation guarantees format, not semantic correctness.
- Bash in preparation actions is not a programmatically enforced read-only sandbox; see "Automatic preparation and read reuse".
- Waits for MCP connection and Pi session initialization are not covered by promises beyond this extension's budget; actual end-to-end latency under long sessions must be confirmed in real usage.

## License

[MIT](LICENSE)
