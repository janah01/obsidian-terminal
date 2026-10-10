# TES-200 evidence

Screenshots and terminal recordings for the TES-200 pull request (clear the 68 Scorecard review warnings). This branch holds only evidence and is not meant to be merged.

Each PNG is the last screen of the matching GIF recording. Recordings ran against a 3.28.0 worktree (`8cbff89`) and the PR branch, on 2026-10-10.

| Check | Before (3.28.0) | After (branch) |
| -- | -- | -- |
| Scorecard lint, reproduced | `media/01-scorecard-lint-before.*` | `media/01-scorecard-lint-after.*` |
| Dependency advisories | `media/02-advisories-before.*` | `media/02-advisories-after.*` |
| Empty interfaces | `media/03-types-before.*` | `media/03-types-after.*` |
| rimraf and `bun run clean` | `media/04-rimraf-clean-before.*` | `media/04-rimraf-clean-after.*` |
| Release name | `media/05-release-before.*` | `media/05-release-after.*` |
| Tests, checks, build | | `media/06-tests-build-after.*` |

Text logs: `media/release-workflow-sim.txt`, `media/bundle-diff-by-module.txt`, `media/bundle-diff-non-dompurify.txt`.
