# mend v4 — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Riial/makefun-hidden-spec-cli-01-run-20261122-v4/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Riial/makefun-hidden-spec-cli-01-run-20261122-v4/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and this tool reads all of them: a unified diff (often with
wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor
tool calls as JSON. Every file is changed or nothing is.

Entry for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
"Build mend, one patch tool for every AI edit format".

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file. When it is absent or is `-`, the patch
  is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without
  it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## Exit codes

- `0`: the tree is written. One line per changed path (`A`, `D`, `M`, `R`), then
  `ok: n files`.
- `1`: nothing is written. One `error: <code> <path>` line per failed edit, then
  `failed: k of n edits`.
- `2`: nothing is written, exactly one line: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.

## Matching

Old lines are found at the first of three tiers at which they occur at least once:
tier 0 is exact, tier 1 ignores trailing spaces and tabs, tier 2 ignores leading
and trailing spaces and tabs (and re-indents the new lines). `--strict` tries
tier 0 only.

## Requirements

Node 22, standard library only. No dependencies, no network.
