# handoff-verify: historical measurements and observations (on demand, NOT normative)

This file holds the measurement narratives that used to sit in `SKILL.md`. Nothing here is a rule: the rules are in `SKILL.md`, the behavior is in the scripts and pinned by their tests. Every number below is a small, dated sample of one machine or one Jev version, kept only so a reader can see where a rule came from. Production savings and wall time of the scheduling are UNMEASURED.

## Direct probes of the omission rules (R03 / R04)
SKILL.md used to say (section Statuses):
> Measured on this Jev version (direct probes, results/rounds/R03/probes and results/rounds/R04/probes): the bare detail with the whole note as evidence got `unsupported` > 0.95 with `auto` on 4 of 6 truly missing details and `verified` on all 8 reworded or implied ones; the other two missing details scored below the threshold, so some real omissions will stay UNRESOLVED: say so honestly.

## Finding rules and the live sessions
SKILL.md used to say (section Output):
> These finding rules (including the handoff-version rule) were added offline after the two R01 live sessions and were exercised live for the first time in the two R02 sessions (one per language: 10 findings observed, all confirmed, none unsupported; a tiny sample that validates nothing); the later offline corrections of the version-identity rules (exact canonical path identity, demonstrated session provenance, identity checked before verified_version, tool_use/tool_result window, complete-Read bases, per-version attribution, identity per write rather than per hash) have NOT been tested live; the R03 omission rules (explicit pair, strict auxiliary conditions, canonical material, closed `unsupported` exception) were verified by offline tests and run live in the two R03 `after` sessions (0 of 3 omissions confirmed per language: every real omission stayed UNRESOLVED because the R03 absence claim reached only 0.21-0.42); the R03 council corrections (session_end source excludes the verification activity, Jev calls are never source, exact source-passage and material comparison, current contract chosen by the evaluator) and the R04 absence rule (bare detail, real `unsupported` > 0.95, explicit `auto`, `same_subject` not required for this half of a valid pair only) are verified by offline tests and are part of the distributions run live in the four R04 sessions; the measured outcome of those sessions (n = 1 per language, synthetic fixtures, no statistics) is in results/rounds.md and validates nothing; 

## Material of the real notes (2026-10-07)
SKILL.md used to say (section Omissions):
> Measured on the 9 real notes verified on this machine (2026-10-07): complete material went from 1 to 5; the other 4 name files that no longer exist, and they still block. 

## Scope filter, one live probe
SKILL.md used to say (section Scope filter):
>  Measured once on this Jev version (one live probe, n = 6, validates nothing): clearly unrelated details scored 1.0, an in-scope problem met during the work scored out_of_scope only 0.67 (kept), a detail from an earlier part of the session absent from the quoted requests scored 0.99 (kept, not strictly above).

## Retry advice: inspected sources and the backtest
SKILL.md used to say (section Retry advice):
>  Inspected sources for orientation only (not evidence of any recorded session): the repository's own verify contract does not emit `same_subject`/`subject_at`, the cached 0.14.1 package's verify contract does; neither inspected gate contract emits them.
>  Backtest on this machine's real history on 2026-10-07 (836 non-lab sessions, 785 results that did not pass, 63 later re-asked in a similar form and passed): after `add_direct_evidence` the claim was kept with new evidence in 29 and changed in 28 cases, so for low confidence the history does not tell which of the two works; none of the 76 `fix_fact` claims passed later in a similar form.

## Pointers that no longer exist
SKILL.md used to point at `results/T2.md` (live measurements) and `results/evidence/corpus_inventory.json`:
> Responses marked ILLUSTRATIVE were not measured; live measurements are in results/T2.md. Synthetic stories use made-up values.

Observations (recorded, not repaired here):
- There is no `results/` directory in this repository; those pointers were external. `private/jev-control/results/R0x` exists but is another tree (the jev-control rounds), not the handoff-verify measurements. This task does not create or edit `results/`.
- `examples/02-omission.md` is a stale copy of the older R03-style example (the absence call `verified` 0.97 and the finding called confirmed). It is out of scope here; `SKILL.md` Example 02 is the current R04 ABSENCE-first pair.
- The realistic Jev responses used by the offline fixtures (`scripts/contract_fixtures.py`) omit `same_subject` / `subject_at` exactly like the inspected server; explicitly compatible synthetic fixtures add invented values to exercise the strict positive rules and are not copies of any server.
