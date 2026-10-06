# 04 — File search done by Jev

Illustrative — not measured. Threshold `T = 0.95`. `rg`/glob/the candidate generator only produce **candidates**; Jev selects what is read. The example repository is the synthetic fixture `s3-ambiguous-search` (four files with plausible retry delays).

**Request (synthetic):** "Where is the delay between retries of a FAILED UPLOAD computed? Answer with the path and the lines."

The question asks for **one definitive location**, so the first logical evaluation may be `jev_find`; it is accepted only if the winner's probability **and** `exists` are both strictly above T.

**Helper command**

```sh
node "${CLAUDE_PLUGIN_ROOT}/private/jev-control/cli.mjs" search --single --query "delay between retries of a failed upload"
```

**Call 1 — jev_find** (sent by the helper; the candidates were produced locally from the repository, never copied through the model)

```json
{
  "query": "delay between retries of a failed upload",
  "candidates": [
    {
      "id": "c0",
      "text": "src/upload/retry.mjs:1-9\n// Retry policy of the uploader.\nconst BASE_MS = 250;\nconst MAX_MS = 8_000;\n\n// Delay in ms before the next attempt of a failed upload.\nexport function uploadRetryDelay(attempt) {\n  const exp = BASE_MS * 2 ** attempt;\n  return Math.min(MAX_MS, exp);\n}"
    },
    {
      "id": "c1",
      "text": "src/upload/uploader.mjs:1-12\nimport { uploadRetryDelay } from \"./retry.mjs\";\n\nexport async function upload(send, payload, attempts = 4) {\n  for (let i = 0; i < attempts; i++) {\n    try {\n      return await send(payload);\n    } catch (error) {\n      if (i === attempts - 1) throw error;\n      await new Promise((r) => setTimeout(r, uploadRetryDelay(i)));\n    }\n  }\n}"
    },
    {
      "id": "c2",
      "text": "src/jobs/schedule.mjs:1-4\n// Delay before the nightly job is retried by the scheduler.\nexport function jobRetryDelay(attempt) {\n  return 60_000 * (attempt + 1);\n}"
    },
    {
      "id": "c3",
      "text": "src/net/backoff.mjs:1-4\n// Delay for polling the status endpoint, not for uploads.\nexport function pollBackoffMs(attempt) {\n  return Math.min(30_000, 500 * 2 ** attempt);\n}"
    }
  ],
  "top_k": 5
}
```

**Response 1 (Illustrative — not measured)**

```json
{
  "tool": "jev_find",
  "query": "delay between retries of a failed upload",
  "exists": 0.91,
  "exists_verdict": "answered",
  "top": [
    {
      "id": "c0",
      "probability": 0.97
    },
    {
      "id": "c1",
      "probability": 0.2
    },
    {
      "id": "c2",
      "probability": 0.1
    },
    {
      "id": "c3",
      "probability": 0.05
    }
  ]
}
```

**Call 2 — jev_rerank** (sent by the helper; the candidates were produced locally from the repository, never copied through the model)

```json
{
  "query": "delay between retries of a failed upload",
  "candidates": [
    {
      "id": "c0",
      "text": "src/upload/retry.mjs:1-9\n// Retry policy of the uploader.\nconst BASE_MS = 250;\nconst MAX_MS = 8_000;\n\n// Delay in ms before the next attempt of a failed upload.\nexport function uploadRetryDelay(attempt) {\n  const exp = BASE_MS * 2 ** attempt;\n  return Math.min(MAX_MS, exp);\n}"
    },
    {
      "id": "c1",
      "text": "src/upload/uploader.mjs:1-12\nimport { uploadRetryDelay } from \"./retry.mjs\";\n\nexport async function upload(send, payload, attempts = 4) {\n  for (let i = 0; i < attempts; i++) {\n    try {\n      return await send(payload);\n    } catch (error) {\n      if (i === attempts - 1) throw error;\n      await new Promise((r) => setTimeout(r, uploadRetryDelay(i)));\n    }\n  }\n}"
    },
    {
      "id": "c2",
      "text": "src/jobs/schedule.mjs:1-4\n// Delay before the nightly job is retried by the scheduler.\nexport function jobRetryDelay(attempt) {\n  return 60_000 * (attempt + 1);\n}"
    },
    {
      "id": "c3",
      "text": "src/net/backoff.mjs:1-4\n// Delay for polling the status endpoint, not for uploads.\nexport function pollBackoffMs(attempt) {\n  return Math.min(30_000, 500 * 2 ** attempt);\n}"
    }
  ],
  "top_k": 5
}
```

**Response 2 (Illustrative — not measured)**

```json
{
  "tool": "jev_rerank",
  "ranked": [
    {
      "rank": 1,
      "id": "c0",
      "relevance": 0.962
    },
    {
      "rank": 2,
      "id": "c1",
      "relevance": 0.31
    },
    {
      "rank": 3,
      "id": "c2",
      "relevance": 0.12
    },
    {
      "rank": 4,
      "id": "c3",
      "relevance": 0.05
    }
  ]
}
```

**Comparison (strict)**

| Check | value | `> 0.95`? |
| --- | --- | --- |
| Call 1: winner `c0` (find) | 0.97 | yes |
| Call 1: `exists` | 0.91 | **no** |
| Call 2: `c0` (rerank relevance) | 0.962 | yes |
| Call 2: `c1` | 0.31 | no |

`jev_find` is rejected because `exists` (0.91) is not above 0.95 even though the winner is; `jev_rerank` runs as the **second and last** logical evaluation (a search has at most two). Rerank is the tool that decides eligibility over several files: one candidate, `c0`, is above the threshold.

**Helper output** (one line, at most 4 KB)

```json
{"status":"found","search_id":"5b0e7a3c91d2f4a8","evaluations":2,"jev_used":"rerank","coverage_complete":true,"omitted":0,"hits":[{"path":"src/upload/retry.mjs","start_line":1,"end_line":9,"sha256":"dc58371804f3d503bb8c2975be2b0f3e3981691aa9f5c65878a2c39df26d3ba7","score":0.962}],"jev_calls":2}
```

**Action:** read only `src/upload/retry.mjs` lines 1–9 (Read with `offset`/`limit`) and check the file's `sha256` against the hit before relying on it; the other candidates are not read.

**Other cases**

- A path the user named exactly is read directly (`search --exact-path <path>`), without Jev.
- Several files wanted (no `--single`): `jev_rerank` only; every hit strictly above T is eligible, ordered by relevance; near-equal top hits are separated by one `jev_decide` in the shared budget.
- Nothing strictly above T after the evaluations: `none_eligible` / `search_budget_exhausted`; report it, never claim the code does not exist (the candidates are a lexical preselection).
- Zero candidates: `none_candidates`; widen the scope once (`--widen --search-id <id>`), then report.
- The control options `action_gather_evidence` / `action_ask_user` are never added to the candidates as fake files; asking or gathering after a search is an ordinary decision.

**Accounting:** 2 attempts (source `helper`), 2 of the 2 logical evaluations of this search, 2 of the 10000 of this request.
