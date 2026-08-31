# Project Git rules

- `release/prod-maintenance-test` is the production branch. Never commit directly to it.
- Start each task from a fetched, current production commit in a named feature worktree.
- Keep at most four worktrees per repository: one primary checkout and up to three active tasks.
- A commit must contain the complete intended task. Do not leave related staged, unstaged, or untracked files behind.
- Preserve unfinished work on a tested `archive/wip-*` branch, push it, then remove its worktree.
- After a production push, run `npm run git:worktree:plan` and then `npm run git:worktree:clean`.
- Never commit secrets, service-account files, private keys, raw user text, local evaluation output, or local API runners.
- Deploy only a clean, tested commit that is based on the current production branch.
- Do not force-push production, use destructive reset, or delete a dirty/unmerged worktree.
