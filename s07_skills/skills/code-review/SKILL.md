---
name: code-review
description: Review a code change for correctness, edge cases, and style. Use when asked to review a diff, PR, or file.
---

# Code Review

Review the change against these rules, in order:

1. **Correctness first.** Does the change do what it claims? Trace the happy path before anything else.
2. **Edge cases.** Empty input, null/undefined, off-by-one, error paths. Name each risk explicitly.
3. **Style & naming.** Consistent with the surrounding code; names say what things are.
4. **Scope.** Flag anything the change touched that it did not need to.

## Output format

- Lead with a one-line verdict: `LGTM`, `Comment`, or `Request changes`.
- Then a numbered list of findings, each as `file:line — issue — suggestion`.
- Order findings by severity (blocker down to nit). No filler praise.
