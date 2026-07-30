---
name: commit-message
description: Write a Conventional Commits style message for staged changes. Use when asked to commit or to write a commit message.
---

# Commit Message

Write a Conventional Commits message:

1. **Type.** feat / fix / docs / refactor / test / chore.
2. **Subject.** Imperative mood, lowercase, at most 72 chars, no trailing period. Optionally `type(scope): subject`.
3. **Body (optional).** What changed and *why*, not how. Wrap at 72 chars.

## Rules

- Read the staged change first (`git status`, `git diff --cached`) before writing anything.
- One logical change per commit; say so if the diff mixes concerns.
- Output only the message, nothing else.
