# dsh-mymemory

**Long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai) that does not wreck your prompt cache.**

Most memory plugins write a fresh summary into the system prompt every turn. The prefix changes, the cache dies, and the bill goes up. This one keeps the injected block small, named, and byte-stable — and keeps unconfirmed guesses out of it entirely.

```
No cloud. No telemetry. No runtime dependencies.
One SQLite file and two Markdown files, on your disk.
```

---

## The problem

Memory plugins tend to fail in three specific ways.

**They poison the cache.** Recall is prepended or rewritten at the top of every request. Even a one-word change near the start of the prefix re-bills the whole context. A plugin that "saves tokens" by remembering things can easily cost more than it saves.

**They drift.** Every extracted guess gets folded into the profile immediately. Add a model that likes to please, and after fifty turns your "user profile" is a polite fiction nobody wrote.

**They are unauditable.** What got stored, why, from which turn, and what it replaced — usually unknowable. You cannot correct a memory you cannot see.

## What you get

| | |
|---|---|
| **Dual-track storage** | Structured facts in SQLite; the parts you actually edit — persona and profile — as plain `SOUL.md` / `USER.md`. Edit the file, next turn picks it up. No reindex, no restart. |
| **Prefix-stable injection** | Injected as named `systemPrompt` sections with fixed order and lazy evaluation, under a hard byte budget. Candidates and `pending` records never enter the prompt. |
| **Guarded consolidation** | Three gates before anything is stored: exact hash → near-duplicate signature (90% threshold) → model arbitration. Scoped per project/global, so a project note never swallows a global preference. |
| **Preview before write** | The "update" action generates a proposal. Nothing touches your file until you accept it — hand-tuned wording survives. |
| **Probation for skills** | Experience-derived skills start as `candidate`. They only become `verified` after recurring across sessions. One lucky turn cannot reshape long-term behaviour. |

## Architecture

```
   conversation turns
          │
          ▼
   turn-stopping hook ── async, never blocks the reply
          │
          ▼
   extraction  (host llm service, current session's provider/model)
          │
          ▼
   ┌──────────────── three-stage gate ────────────────┐
   │ 1. exact hash        → NOOP (same sentence twice)│
   │ 2. near-dup signature→ MERGE / promote pending   │
   │ 3. model arbitration → keep both / supersede     │
   │    scope-bucketed: project ≠ global              │
   └──────────────────────────────────────────────────┘
          │
          ▼
   ┌────────────── two-track persistence ─────────────┐
   │ SQLite: facts · revisions · tombstones · conflicts│
   │ Markdown: SOUL.md (persona) · USER.md (profile)   │
   └──────────────────────────────────────────────────┘
          │
          ▼
   fixed anchors in the system prompt  (order 80 / 85)
   byte-clipped · fixed order · lazy text
```

## Prefix cache: zero per-turn invalidation

A memory plugin can only destroy a prefix cache one way — by changing bytes near the start of the prompt. Most do it every single turn.

```
typical memory plugin            dsh-mymemory
─────────────────────────────    ─────────────────────────────────
summary rewritten every turn     named sections, fixed order 80 / 85
grows with the memory count      hard caps: 4096 chars profile,
                                512 tokens recall, 0 core
guesses injected immediately     pending never injected — search only
changes: the prefix              changes: the tail
```

Three properties, enforced in code rather than promised in prose:

1. **Fixed anchors.** Injection goes through `ctx.systemPrompt.section({name, order, text})` — `mymemory-soul` at order 80, `mymemory-guide` at order 85, plus one context provider. Names and order never change at runtime, so the block's position in the prefix is constant.
2. **Hard byte budgets.** Profile clipped to `profileBudgetChars` (default **4096 chars**), `STATE.md` to **800 chars**, recall to `retrievalBudget` (**512 tokens**), `coreBudget` **0**. Remembering fifty more things cannot silently grow the prefix.
3. **Unconfirmed content stays out.** `candidate` skills and `pending` memories are returned by `search` on demand — never injected. The prompt only sees what survived the gates.

So the only event that can invalidate the prefix is **the profile text actually changing** — and that is rate-limited on purpose: at most once per `minIntervalMs` (default 60 s) and at most `dailyLimit` (default 20) times a day, and the extractor is instructed to return nothing when there is no substantive change. In a normal working session that is zero to a handful of invalidations — not one per turn.

*This is a statement about this plugin's own bytes. End-to-end hit rate depends on provider TTL, eviction and client-side rewriting, and is not claimed here. For scale only: the author's 744-request session reported 95.0% overall, most of it from context compression and upstream caching.*

## Install

```bash
# from a checkout
git clone https://github.com/diyun7e7q/dsh-mymemory.git
npm install link:/absolute/path/to/dsh-mymemory
```

The plugin registers itself through `cordis.patch.yml` and appears in the plugin list after restarting the host.

Requires Node **>= 24.9.0** (runs TypeScript sources through type stripping) and a host exposing the `llm` service.

## Configuration

Minimal, redacted:

```yaml
- insert:
    - id: mymemory
      name: dsh-mymemory
      config:
        dataDir: /path/to/memory     # defaults to the host data directory
```

### Moving the data directory

`cordis.patch.yml` is the live config, not just a template: when the host links the plugin from it, editing that file edits a running plugin. To relocate the store, write a pointer instead — it wins over `config.dataDir` and stays out of version control:

```json
// <host home>/mymemory/<profile>/location.json
{ "dataDir": "/path/to/memory" }
```

Commenting out `config.dataDir` with no pointer in place is how you end up with a silently empty database.

Everything you would realistically tune lives in the panel; the rest lives here:

| key | default | range | meaning |
|---|---|---|---|
| `profileBudgetChars` | 4096 | 512–16384 | cap on `USER.md` |
| `retrievalBudget` | 512 | 0–8192 | tokens reserved for recalled facts |
| `coreBudget` | 0 | 0–1024 | always-on facts (off by default) |
| `maxResults` | 8 | 1–20 | records returned per recall |
| `nearDupPercent` | 90 | 50–100 | similarity threshold for the second gate |
| `dailyLimit` | 20 | 0–1000 | extraction calls per day |
| `extractionInputChars` | 1000 | 16–4000 | input trim before extraction |

## Memory model

- **Scope.** `global` (shared across sessions) or `project` (bound to a working directory). Deduplication is bucketed by scope — the same sentence written to two scopes is two records with two purposes.
- **Status.** `pending` (extracted, not yet trusted) → `active` → `archived`. Only `active` records are eligible for injection.
- **Provenance.** Every record keeps `sourceType`, `sourceRef`, version history and a tombstone. Forgetting writes a snapshot first, so the "snapshot & time travel" view can roll it back.
- **Dedup.** Exact writes return the existing record instead of creating a twin; semantically identical writes merge sources; genuine conflicts wait in an inbox for a human to pick a side.

## The panel

A right-sidebar cockpit plus a `/mymemory` command that works in a plain terminal:

```
/mymemory status                 # counts, gate stats, cache-relevant budgets
/mymemory conflicts              # open conflict inbox
/mymemory skills                 # candidate / verified skill cards
/mymemory skill <id> promote     # move a candidate to verified
```

The panel exposes exactly two editable text blocks — `SOUL.md` (the assistant's persona) and `USER.md` (the profile of you) — because those are the only two things a user actually rewrites. Everything else is a readout.

## Privacy

Facts, revisions, tombstones, conflicts and skills live in one SQLite file. No sync, no telemetry, no accounts. Files are created `0700`.

Talking to a model means the injected portion leaves your machine and reaches your model provider. Local storage is not offline inference.

Forgetting clears the live body, revisions and derived objects. It does not touch the host's historical transcripts, and it does not touch your provider's logs. "Do not mention again" is a **reference suppression**, not a deletion — the record stays.

## Measuring it yourself

```bash
git clone https://github.com/diyun7e7q/dsh-mymemory.git && cd dsh-mymemory
node scripts/benchmark.mjs      # offline synthetic retrieval benchmark
```

The bundled benchmark is deliberately narrow — 5 synthetic cases, retrieval and token-packing only. It reports **5/5 correct, ~32 ms, ~1.2K estimated injected tokens** on the development machine, and it says so in its own output:

> `offline_synthetic_retrieval_only` — does not prove real task success or savings versus other plugins.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # src/ → lib/, type stripping only
npm test            # full suite
```

`lib/` is generated from `src/` and must not be edited by hand. The full management surface is also available headless: `node lib/cli.js help`.

## Limits

- DeepSeek Harness only; no cross-host sync.
- Depends on the host exposing `llm` and a session route. When neither is available it falls back to an explicitly configured route — and says so, instead of faking success.
- Does not index the full transcript; only extracted points and observations.
- Extraction quality is bounded by the model. The standing rule is prudence: no source, no entry; one-off, no entry; speculation, no entry.

## License & Acknowledgments

[MIT](LICENSE).

Built on the DeepSeek Harness plugin contract — the [cordis](https://github.com/deepseek-ai) plugin/context model, the slot system, the client module loader and the command UI. Design debts: SQLite for the write-ahead log and snapshot discipline, and the general "small fixed prefix, retrieval on demand" shape that RAG and editor-assistant tooling converged on independently.

Design, implementation, tests and on-device verification were carried out with DeepSeek Harness as the development harness.

---

## 中文说明

**给 DeepSeek Harness 的长期记忆插件，不砸提示词缓存。**

大多数记忆插件每一轮都把新总结塞进系统提示词开头。前缀一变，缓存全废，账单变贵。这个插件反过来：注入块小、具名、顺序固定、字节有硬上限，而且**没被确认的猜测根本不进提示词**。

三个具体毛病，对应三种处理：

- **前缀逐轮抖动** —— 这是最容易做错、代价最大的一条。注入走 `ctx.systemPrompt.section({name, order, text})`，段名与 order（80 / 85）运行期恒定，注入块在前缀里的位置就恒定；画像硬帽 4096 字符、`STATE.md` 800 字符、检索 512 token、常驻 0 —— 库里记的事再多也涨不上去。候选技能与 `pending` 记录只由 `search` 按需返回，永不进提示词。逐轮失效数为零。
  唯一能让前缀失效的事件是画像正文真的变了，而这被刻意限流：最快 60 秒一次（`minIntervalMs`）、一天最多 20 次（`dailyLimit`），且模型被要求"信息没有实质变化就不返回"。正常干活一天是零到几次，不是每轮一次。
- **记忆越用越歪** —— 写入前过三道闸：精确哈希 → 近重复签名（90%）→ 模型仲裁，并按 project / global 分桶去重。抽取出来的内容先落 `pending`，只有用户亲口确认、显式记住或跨会话复现才转正。
- **不可审计** —— 每条记录带来源、版本、墓碑；遗忘前先落快照，能回滚。画像与人格是明文 Markdown，面板里直接改，下一轮生效。

面板只放两块真正会被改的文本：`SOUL.md`（我的人格设定）和 `USER.md`（关于你的记忆概括）。「更新」只生成提案，点「采用」才写盘 —— 你手改过的措辞不会被模型静默盖掉。

终端里照样能用：`/mymemory status`、`/mymemory conflicts`、`/mymemory skills`、`/mymemory skill <id> promote`。

数据只在本机：一个 SQLite 文件 + 两个 Markdown 文件，权限 `0700`，无同步、无遥测、无账号。跟模型交互时，被注入的那部分会离开本机到达模型服务商 —— 本地存储不等于离线推理。
