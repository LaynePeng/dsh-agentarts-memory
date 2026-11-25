# AgentArts memory

Adds Huawei Cloud **AgentArts Memory** to DeepSeek Harness: a shared, cross-session
long-term memory behind a semantic search API. Four independent switches, no npm
dependencies, no build step.

## What it does

| Capability | Switch | Behaviour |
| --- | --- | --- |
| Whole plugin | `enabled` | `false` registers nothing at all — identical to not having the plugin |
| Tools | `tools.enabled` | `huawei_memory_search` and `huawei_memory_save` |
| Recall | `recall.enabled` | before each agent step, search with the incoming user text and prepend the best hits |
| Capture | `capture.enabled` | after a session ends, push its dialogue turns so the platform extracts memories |

`recall` and `capture` are best-effort by construction: every failure path returns
`next()` (recall) or logs a warning (capture), so a cloud outage cannot break a
conversation.

## Requirements

A Huawei Cloud AgentArts **memory space** (`space_id`) and its **data-plane API
key**. Create the space in *AgentArts console → 开发中心 → 组件库 → 记忆库*.

Nothing else. No SDK checkout, no build step, no npm dependencies — the
data-plane client is part of the plugin. (The official
`@huaweicloud/agentarts-sdk` cannot be a dependency here: its `package.json`
carries a `workspace:*` agentidentity dependency, which pnpm refuses through a
`file:` specifier, so a git-installed copy of the plugin would have nothing to
resolve.)

## Install

From the repository — no build step, `index.js` is the entry:

```
Plugins → Add plugin → github:LaynePeng/dsh-agentarts-memory
```

or, from a local checkout, pick the directory in the same dialog.

Then set the API key in the environment of the process that runs DSH:

```sh
export HUAWEICLOUD_SDK_MEMORY_API_KEY="<data-plane api key>"
```

## Configure

Edit the row in your profile's `cordis.patch.yml`:

```yaml
- id: dsh-agentarts-memory
  name: '@laynepeng/dsh-agentarts-memory'
  config:
    enabled: true
    spaceId: '<your space id>'
    apiKeyEnv: HUAWEICLOUD_SDK_MEMORY_API_KEY
    region: cn-southwest-2
    endpoint: ''                 # empty: $AGENTARTS_MEMORY_DATA_ENDPOINT, else the region default
    actorId: dsh-user
    assistantId: dsh
    strategyId: ''               # leave empty unless your space requires one
    timeoutMs: 5000
    recall:
      enabled: true
      topK: 5
      minScore: 0.35
      maxInjectTokens: 600
      cacheMs: 60000
      minQueryChars: 8
    tools:
      enabled: true
    capture:
      enabled: false
      maxMessages: 40
```

The simplest switch of all is the row's toggle in **Plugins** — that unmounts the
plugin without touching this page.

## In-session

```
/agentarts                 # switch status, space, readiness
/agentarts search 数据库    # ad-hoc semantic search
```

## Design notes

- **Injection happens on `agent/pre-step`, not in a system-prompt section.** A
  section provider is synchronous; AgentArts search is HTTP. `agent/pre-step` is
  the waterfall that may replace the messages entering a step.
- **Injected context is a frozen, identified user message.** The `enter` decision
  carries a complete message batch, so the message is built and frozen locally.
  Its `source.kind` is `user` because that is the union this DSH build declares;
  provenance is stated in the text instead.
- **Repeats are suppressed per agent.** A multi-step turn would otherwise inject
  the same memories at every step.
- **Only dialogue is captured.** Tool calls and tool results are dropped: shell
  output is exactly what should not be uploaded.
- **No metadata round-trip.** The AgentArts search response does not return a
  record's `metadata`, so recalled text is used as-is rather than mapped back to
  local state.
- **The wire format is transcribed, not imported.** `src/gateway.js` implements
  the five data-plane calls this plugin needs, with request shapes copied from
  the SDK sources (`parts: [{ type: 'text', text }]` for messages,
  `only_actived`/`rerank` on search). If the backend changes, that one file
  changes.

See `docs/DETAIL.md` for the API surface and the limitations this plugin does not
solve.

## Test

```sh
node --test "test/*.test.mjs"
```
