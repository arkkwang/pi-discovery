English | [简体中文](README.zh-CN.md)

# pi-discovery

A unified capability discovery and trajectory review extension for the Pi coding agent, delivering three things in a single Pi extension package:

- **Unified capability discovery**: overrides the host `tool_search`, discovering and loading Skills, MCP, and deferred tools by natural language or exact name;
- **Automatic preparation (prefetch)**: after user input is received and before the first main model request, predicts the capabilities and preparation actions the current task needs, and can auto-expand high-confidence suggestions — reading Skill entries, loading tool definitions, and running recommended read-only actions;
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
    "toolSearch": {
      "enabled": true,
      "model": "zai-coding-cn/glm-5.3-flash",
      "thinkingLevel": "medium"
    },
    "recommendation": {
      "enabled": true,
      "model": "zai-coding-cn/glm-5.3-flash",
      "actionPrediction": true,
      "maxSuggestedActions": 3,
      "autoExpand": { "enabled": true, "minConfidence": 0.9 },
      "thinkingLevel": "low",
      "timeoutMs": 60000,
      "disableForCwd": []
    },
    "trajectory": {
      "model": "zai-coding-cn/glm-5.3-flash",
      "enabled": true,
      "everySteps": 15,
      "thinkingLevel": "low",
      "timeoutMs": 120000,
      "disableForCwd": ["D:/work/experiments"]
    }
  }
}
```

Write it to Pi's `settings.json`. `capabilityDiscovery` accepts **only three top-level keys**: `toolSearch`, `recommendation`, and `trajectory` — one per independent feature: smarter tool search (the discovery takeover), startup-time recommendation (capability/action prediction), and in-execution checks (periodic trajectory review). Each group's model, thinking level, and switches are independent; neither inherits settings from the others. Omitted groups use their own defaults.

### Available configuration keys

All keys are optional. This table lists every supported key and its default.

| Group | Key | Default | Purpose / range |
| --- | --- | --- | --- |
| toolSearch | `enabled` | `true` | Enable smart discovery and turn the prompt's Skill/MCP directory into a capability catalog; when `false`, the host's native `tool_search` and native directory stay in place and the rest of this group is inert |
| toolSearch | `model` | `"llama/iq3"` | `provider/model` routing natural-language search |
| toolSearch | `thinkingLevel` | `"medium"` | Thinking level for semantic routing |
| recommendation | `enabled` | `false` | Enable input-time recommendation; capability suggestions are always included when enabled |
| recommendation | `model` | `"llama/iq3"` | `provider/model` for capability/action prediction |
| recommendation | `actionPrediction` | `false` | Additionally recommend action items (`read`/`bash`) inside `suggestions` when recommendation is enabled; executing them depends on `autoExpand`; boolean |
| recommendation | `maxSuggestedActions` | `3` | Maximum recommended action items per preparation; integer 0–8, 0 recommends none |
| recommendation | `autoExpand.enabled` | `false` | Auto-expand suggestions whose confidence reaches the threshold: skills read SKILL.md (non-recursive), MCP services and tools load their definitions through the host, action items run their recommended read-only actions; boolean |
| recommendation | `autoExpand.minConfidence` | `0.85` | Confidence threshold for auto-expansion; finite number 0–1; below-threshold items stay plain suggestions |
| recommendation | `thinkingLevel` | `"medium"` | Thinking level for automatic capability/action prediction |
| recommendation | `timeoutMs` | `60000` | Preparation boundary budget in ms; integer 1000–600000 |
| recommendation | `disableForCwd` | `[]` | Skip preparation for sessions whose CWD is listed; array of path strings |
| trajectory | `model` | `"llama/iq3"` | `provider/model` for periodic trajectory warnings |
| trajectory | `enabled` | `false` | Enable periodic trajectory warnings; boolean |
| trajectory | `everySteps` | `5` | Warning interval; integer 0–1000, 0 disables periodic review |
| trajectory | `thinkingLevel` | `"medium"` | Thinking level for trajectory warnings |
| trajectory | `timeoutMs` | `60000` | Review boundary budget in ms; integer 1000–600000 |
| trajectory | `disableForCwd` | `[]` | Skip periodic review for sessions whose CWD is listed; array of path strings |

- `model` must be a nonempty `provider/model` string without whitespace. Only the first `/` separates the provider, so model IDs such as `vendor/model` are supported. The model must be configured in Pi; currently only `openai-completions` APIs are supported.
- All three thinking-level fields accept `off/minimal/low/medium/high/xhigh/max`. Mapping depends on the selected model, independently of the main session's thinking level.
- `disableForCwd` lists project roots where the group performs no model work: preparation logs `disabled-by-cwd` at the input gate, review logs `disabled-by-cwd` at the step gate. Entries accept absolute paths, `~/`-prefixed paths, or relative paths (resolved against the Pi process CWD). `/` and `\` are interchangeable, and `.`/`..`, duplicate or trailing separators are normalized; on Windows, letter case is ignored. Matching is exact directory identity — a listed root does not cover its subdirectories, and the groups gate independently. Manual `tool_search` is not affected.
- When `toolSearch.enabled=false`, the registered entry delegates directly to the host's native `tool_search` (BM25 search, no routing model) and keeps its metadata, schema and results. The Skill/MCP prompt directory stays native. Settings are read at runtime: the prompt follows the next user input; search follows the next call. Invalid configuration keeps the native prompt/search and reports a warning at the input gate.
- `recommendation.enabled=false` only disables input-time capability/action prediction; `tool_search` routing and periodic review are unaffected. `trajectory.enabled=false` likewise only disables the review.
- `actionPrediction` only decides whether action items are recommended; reads, loads, and executions are decided solely by `autoExpand`. Turning `actionPrediction` off does not affect skill/mcp/tool auto-expansion; turning `autoExpand` off disables every read, load, and execution. `autoExpand` accepts only `enabled` and `minConfidence`.
- The example keeps all three groups on the same model to preserve the previous configuration's intent; change each independently.
- **Older formats are rejected, not automatically migrated.** Remove `recommendation.capabilityPrediction` and set `recommendation.enabled` to enable capability recommendation; `actionPrediction` only adds actions and cannot enable recommendation on its own. `recommendation.toolSearchThinkingLevel` moves to `toolSearch.thinkingLevel`, and the routing model now comes from `toolSearch.model`. For the older flat format: combine `provider` + `model` into each group's `model`; move the action switch and action cap into recommendation; split `autoRecommendThinkingLevel` into each group's `thinkingLevel`; rename `trajectoryWarnings` to `trajectory.enabled` and `trajectoryWarningEverySteps` to `trajectory.everySteps`. Legacy keys, wrong nesting, unknown keys, and invalid values fail explicitly rather than being silently ignored.
- **New recommendation output contract.** The recommendation model now returns a single JSON object whose only field is `suggestions`: capability items `{type: "skill"|"mcp"|"tool", name, confidence}` and, with `actionPrediction` on, action items `{type: "action", tool: "read"|"bash", arguments, confidence}`. The top-level `actions` array, the old `{id, confidence}` item shape, and any `reason` field are gone. `actionPrediction` no longer implies execution: to keep recommended reads/Bash running automatically as before, set `recommendation.autoExpand.enabled = true`; note that auto-expansion additionally loads high-confidence MCP/tool definitions through the host, not just actions.

| Entry point | Invocation and input | Output |
| --- | --- | --- |
| After user input is received, before the first main model request | Calls only `runPrefetch`; capability catalog, current request/recent background; when `actionPrediction` is on, additionally the project index, retained reads, and the action cap | One `suggestions` array — capability items always, action items only when `actionPrediction` is on; **never warnings** |
| Every N steps | Calls only `runTrajectoryReview`; execution trajectory, a Skill-only table of names/descriptions/paths, the main agent's current system prompt, and the user request | A list of minimal two-string pairs; `[]` when there are no issues |
| Manual `tool_search` | Natural-language queries use independent semantic search; exact names/lists need no model | Capability suggestions and actual load results |

- A step is an SDK `turn_end`: one assistant round and its tool executions completed; parallel tool batches count as one step. New user input resets the counter. Review happens every time N steps are reached, without first guessing whether there are problems; no error/risk pre-filtering is added. Cancelled calls are not dispatched.
- `trajectory.everySteps` is an integer from 0–1000; 0 disables the period. `trajectory.enabled=false` also disables the review, but does not affect the initial capability/action prediction.
- `recommendation.maxSuggestedActions` is an integer from 0–8 capping recommended action items. When `actionPrediction` is off or the cap is 0, the project tree is not scanned and no action items are recommended.
- Each trigger makes at most one model request within its stage's `timeoutMs` budget (default 60 s); no automatic retry/compaction. Periodic reminders enter the next naturally occurring main model request, without forcing a continuation and without being interrupted into an approval gate. Every boundary leaves a consolidated outcome entry in the main session log — success, `no-warnings` or failure — naming its own session and the child transcript; the child's outcome entry mirrors the linkage back to the parent session, so either JSONL alone shows both ends.
- Suggestions are not a general execution authorization; auto-expansion executes only threshold-meeting items under the established read-only preparation policy (see "Automatic preparation, auto-expansion, and read reuse"), and structural validation cannot guarantee the model's semantic accuracy.

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
- The preparation schema is a single `suggestions` array whose items are capability objects (`type`/`name`/`confidence`) or, when `actionPrediction` is on, action objects (`type: "action"`/`tool`/`arguments`/`confidence`); it does not grow with the catalog, paths, or budget, and `read.path`/`bash.command` are strings. Manual search keeps its own router response shape for now and removes the catalog ID enum. The review schema is fixed as an array of two-string arrays.
- Requests carry `response_format.type=json_schema, strict=true`; the host validates each call against that round's schema, capability `type`/`name` pairs against that round's catalog, action argument paths against the actual candidates, the number of action items against the cap, and parameter constraints. Unknown names/paths, extra warnings fields, or malformed two-string pairs are rejected; lenient parsing is not used to repair model output, and there is no automatic retry.
- Some compatible services do not strictly enforce the schema. An actual Flash model once output a non-empty two-string pair as the invalid `[{"string","string"}]`; the template now explicitly provides the complete `[["reminder","source and original text"]]` example, and the outer layer still strictly rejects wrong formats.

## Automatic preparation, auto-expansion, and read reuse

The isolated SDK session does not load user extensions, MCP, project instructions, or tools. The model returns exactly one JSON object whose only field is `suggestions` — capability items `{type: "skill"|"mcp"|"tool", name, confidence}` plus, when `actionPrediction` is on, action items `{type: "action", tool: "read"|"bash", arguments, confidence}`; the object carries no top-level `actions` array and no `id`/`reason` fields. The host validates every item, auto-expands the qualifying ones, and does not send results back to the prediction model. The preparation feature does not perform trajectory review.

### Auto-expansion (`recommendation.autoExpand`)

`autoExpand.enabled` defaults to `false`: nothing is read, loaded, or executed, and every suggestion reaches the main model as before. When enabled, only items with `confidence >= minConfidence` (a finite number in 0–1, default 0.85) are expanded in place:

- **skill** — read its SKILL.md entry file, non-recursive; internal references remain the main agent's choice;
- **mcp** — load the service's tool definitions through the host's loading mechanism;
- **tool** — load the deferred tool's definition;
- **action** — execute its recommended read-only `read`/Bash action.

Below-threshold items stay plain suggestions and are never executed. Turning `actionPrediction` off removes action items but does not affect skill/mcp/tool expansion; turning `autoExpand` off disables every read, load, and execution regardless of confidence. Expansion reuses what already exists: retained reads are not repeated (see the deduplication rules below), and already-activated tools and MCP services are not loaded again.

- The capability catalog contains Skills, MCP (including host-declared pending services), and deferred/codemode tools; hidden tools are not included, and building it never waits for MCP readiness — the host's tool_search readiness path is awaited only when a high-confidence MCP suggestion is expanded (native search may also wait for other pending services). Without auto-expansion nothing is activated — the main model loads capabilities on demand via `tool_search`.
- When recommendation is enabled, request/setup failures, internal timeouts, invalid responses, or a response with no valid suggestion items at all deliver an unranked full catalog with `fallback: "full-catalog"` and `routingError` to the main model context and persisted preparation message. There is no retry/model switch; fallback items carry `confidence: null` and never auto-expand, fallback itself adds no reads, loads, or executions, and already-executed expansions and their results are retained. Valid empty suggestions are not a failure; partially valid responses keep their valid items with drop diagnostics. Valid action items count as valid suggestions: entirely invalid capabilities alongside valid actions keep the actions without a fallback, and invalid action items alone never trigger the capability fallback. Disabled recommendation, caller cancellation, and session changes do not inject a fallback catalog.
- A Skill's name, full description, and SKILL.md path are placed in the same entry; at most the entry file is ever read automatically — only when auto-expansion is on and its confidence meets the threshold — and internal reference materials are selected by the main agent.
- Project indexing is breadth-first, capped at 3 levels / 200 entries / 6000 characters / 2000 visited entries / 100 ms; it respects the local `.gitignore`, skips hidden directories, dependency/build directories, and credential names, and does not follow directory symlinks. Omission does not prove absence.
- Project files use `project:<relative-path>`; Skills use real paths inside their directories. Before reading, candidate paths, real directory scope, text type, and size are re-checked: 50,000 bytes per file, 100,000 bytes in total.
- Bash commands are model-generated, non-empty, at most 2000 characters, with no NUL; the native tool timeout is 2 seconds. The prompt instructs the model to generate only read-only information-gathering commands, but **this is not a programmatically enforced read-only sandbox**; there is no guarantee that arbitrary commands are side-effect free. When auto-expansion is enabled, threshold-meeting items execute automatically under this established read-only preparation policy, without per-item confirmation.
- Read deduplication uses the current effective context projection; the historical trajectory cannot be used as evidence that content is still present. Only complete, successful reads that have not been invalidated by context edits/potential modifications directly cover a file; partial reads, failures, and compaction removals do not. Bash/opaque tools conservatively invalidate freshness; if a selected file still has complete retained content, only that file is checked, and re-reading is skipped only when the content is identical. Symlink aliases are not merged.

## Execution trajectory and events

Both entry points asynchronously invoke `pi-snap <sessionManager.getSessionFile()> --view trace --max-chars 0 --tail 160`. This explicitly selects user/assistant messages, tool-call requests, behavior recommendations, and prior corrective warnings on the current branch, excluding thinking, images, and tool results (including errors and preparation results). `--max-chars 0` avoids per-row clipping before the total budget below retains recent content. The view owns filtering and single-line presentation; rows carry the source tag chain and tool names in the body (`→ read`, `← read`); the adapter neither relies on pi-snap's default output nor infers execution success. Full evidence can be opened using the displayed record numbers. This extension does not parse historical messages to build a separate trajectory; read deduplication still independently uses the SDK's effective context projection.

The host passes independent arguments via the fixed Bash command `exec pi-snap "$@"`, compatible with Git Bash/macOS Bash; it does not concatenate paths into a shell script, does not look up installation directories, and adds no local npm dependencies. A single CLI call times out at 5 seconds, inherits the trigger's cancellation signal, and its stdout/stderr buffers are each capped at 8 MiB; this is included in the 60-second total budget. Only the most recent 6000 characters of the output string are retained, with truncation marked; semantics are not reinterpreted. The current request at the beginning independently keeps roughly the first and last 4000 characters. Omitted tool parameters or early records do not prove they did not exist.

The file contract has been verified with the SDK: messages/tool results are appended synchronously, and turn_end comes after the save; a bare branch() only changes memory, but this extension already appends `capability-prefetch-diagnostic/start` synchronously before reading, linking the file's last record to the currently active branch. If this write fails, it reports an explicit error and skips prediction/review rather than reading a possibly stale branch. When there are no historical messages before the first input, the empty background is normal and the CLI is not called; when history exists but the file is unreadable, or the CLI is missing/fails/returns empty output, each case fails explicitly, with the surrounding warning + diagnostic fail-open keeping the main task continuing—no fallback to a self-made trajectory or pretending the history is empty.

## Sessions and host integration

- Preparation and review each create a file-persisted child session, saving the actual input and raw model output; failures also leave evidence. The preparation session records the host execution source and saves real tool results. Main-session diagnostic entries record the child session's absolute path, request count, elapsed time, and failure status; they do not enter the main model context.
- Child sessions use the SDK's default `sessions` storage, with cwd fixed to `path.join(os.tmpdir(), 'pi-discovery')`; they appear normally in the Pi session list, with no custom sessionDir and no hiding. The prediction model and resource loaders reuse this cwd; project indexing and preparation actions still use the main task's cwd. File names keep the SDK default `timestamp_ID.jsonl`; the session name is `pi-discovery · preparation|trajectory · provider/model · full session ID`, and origin preserves the parent session ID/file/leaf ID. You can inspect them directly with `pi-snap <ID prefix>`.
- Input preparation has two delivery paths. With `autoExpand` off it runs through the `context` hook: `before_agent_start` only assembles the catalog and saves this round's request, without waiting for the recommendation model; the host first acknowledges receipt and saves the user message, then waits for the recommendation before the main model request; the current request uses the results directly, and `sendMessage(..., {triggerTurn:false})` saves the same results as `capability-prefetch` at a safe turn boundary without triggering an extra model turn. With `autoExpand` on, `before_agent_start` additionally inserts a hidden `capability-preparation-boundary` message; after the user message is saved, that boundary's `message_end` runs the preparation once and replaces the boundary with the `capability-prefetch` carrier — before the host snapshots executable tools — so newly loaded definitions are callable from the first request. `projectPrefetch` projects those tool schemas from each round's `toolsAdded`; the host's active set owns execution and subsequent declarations. Subsequent context projections only expand tool records and do not replay execution, and the hidden boundary never reaches the model.
- Projected tool declarations require the host's current active set and use current definitions. Resume/branch changes never reactivate tools merely from historical preparation records. If no native declaration was persisted yet, loading evidence remains, but a new recommendation or tool_search must load those tools again.
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
| `start` | Both groups in `configuredOptions` and the current stage in `effectiveOptions`; preparation receives recommendation only, periodic review receives trajectory only |
| `session` / `review-input` | Child session location and review input sources, character counts and trajectory truncation; exact input and raw model output remain in the child JSONL |
| `complete` / `failure` | Requests, auto-expansions and executed actions, timing and failures; review distinguishes `warnings`, `no-warnings` and `failed` |
| `context-ready` | First context-hook delivery: `direct` injection, already in `history`, `removed-from-context` without revival, or `no-message`; includes projected tool-call IDs |

Use `pi-snap SESSION --only customType:capability-prefetch-diagnostic` to locate diagnostics, then `pi-snap SESSION ENTRY --json` for their fields. ENTRY accepts a displayed record number or original ID. Follow `discoverySessionFile` / `discoverySessionId` for full inference evidence. Actual preparation arguments/results live in `capability-prefetch.details.prefetch.rounds[].messages`: their epoch-millisecond timestamps describe actions, while the parent timestamp may describe deferred persistence. Do not infer execution order from the carrier's position alone.

Evidence limits: `context-ready` proves this extension returned context, not provider receipt or model compliance; later host processing may change the request. Review currently receives system instructions, the current request, Skill descriptions and a bounded trajectory, not full retained Skill bodies or tool-result bodies; `review-input` makes this coverage explicit. No warning is not authorization. Missing events in older logs do not establish global settings or skip reasons; process crashes and logging failures may also leave incomplete attempts.

### Receive acknowledgment separated from recommendation latency

Real Pi SDK isolated tests replace external models with a fake provider / fake recommender and make no network inference calls: with the recommendation fixed to block for 10 seconds, the receive acknowledgment was measured to return in about 3ms, the user message and session file already existed, and the main provider request count was still 0; only after the recommendation was released did the main model receive the request with suggestions. Tool turns do not re-run recommendations, and late results after cancellation do not enter the next input. There are additional regressions covering concurrent context, session switching, and removed context not being revived. What is measured here is the SDK acknowledgment boundary, not full HTTP/mobile end-to-end latency; waits for MCP connection and session initialization can still exist.

## Manual search

```json
{"query":"Open the web page, check the interaction feedback, and fix the code issues","limit":8}
{"query":"skill:engineering-practice"}
{"query":"mcp:mcp__playwright"}
{"query":"notify"}
{"query":"*"}
```

Natural-language queries get semantic recommendations based on the full description, then native search is invoked within the selected scope; exact names ignore case, with `skill:`/`mcp:`/`tool:` disambiguation. `*` lists the complete catalog without inference/loading. Original tool parameters are preserved; limit defaults to 8, and there is no offset. The limit truncates normal recommendations/exact matches, but not `*` or failure fallback (a supplied limit must still be a positive integer). Returns `mode/total/suggestions/loaded/availableTools`; already-loaded tools are not activated again, and Skills require reading their body content. confidence is an uncalibrated, model self-assessed relevance; manual search never executes anything based on it — input-time auto-expansion is a separate configured switch (see "Automatic preparation, auto-expansion, and read reuse"). This router's own response shape is unchanged for now; the single-`suggestions` contract applies to input-time recommendation only.

A routing request failure (such as HTTP 429, network error, internal timeout, or unavailable model/authentication) or invalid result immediately falls back to the unranked full catalog, retaining Skill entry paths, with all confidence values null, `fallback: "full-catalog"`, and `routingError`. The mode remains semantic; the directory is usable, so the entire result is not marked isError. Fallback does not invoke native search, load tools, retry, or switch models; use an exact name to load needed tools afterwards. Valid `suggestions: []` means no match, not failure, and can still attempt native search as before. Manual routing retains strict per-item validation: any invalid item fails that selection; prefetch instead keeps partially valid suggestions. Listing does not imply activation or execution authorization; caller cancellation propagates rather than becoming fallback success.

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
- Bash in auto-expanded actions is not a programmatically enforced read-only sandbox; see "Automatic preparation, auto-expansion, and read reuse".
- Waits for MCP connection and Pi session initialization are not covered by promises beyond this extension's budget; actual end-to-end latency under long sessions must be confirmed in real usage.

## License

[MIT](LICENSE)
