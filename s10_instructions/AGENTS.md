# AGENTS.md — learn-codex demo project

These are the project-level instructions Codex merges into its system prompt at
runtime, after the built-in base. Edit this file and the next run picks it up —
no harness code changes needed.

## Conventions

- Always run `git status` before finishing a task, so you never report done
  against a dirty tree you have not looked at.
- Prefer small, readable functions over clever one-liners.
- Write commit messages in the imperative mood ("add", not "added").

## Layout

- `sNN_*/code.ts` holds each chapter's runnable demo.
- `spec/TEMPLATE.md` is the authoring contract for new chapters.

## Gotchas

- Every chapter must run offline (no API key) against the scripted model.
- Keep demos self-contained: a reader should understand one chapter without
  reading the others.
