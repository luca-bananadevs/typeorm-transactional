# Contributing

This is a maintained fork of [Aliheym/typeorm-transactional](https://github.com/Aliheym/typeorm-transactional). Work is organized as GitHub issues grouped in milestones (see the pinned [upstream issue map](https://github.com/luca-bananadevs/typeorm-transactional/issues/1)); each issue is closed by a single reviewable PR.

## Branches and commits

- Branch naming: `<type>/<issue-number>-<slug>`, e.g. `fix/17-als-immutable-store`.
- Conventional commits: `fix:`, `feat:`, `chore:`, `docs:`, `test:`; `!` marks breaking changes (`feat!:`, `fix!:`).
- Cherry-picks from upstream PRs keep the original commit (or carry `Co-authored-by:`) and reference `Aliheym/typeorm-transactional#NN` in the PR body.

## Versioning and changelog

We use [changesets](https://github.com/changesets/changesets):

- Every PR touching `src/` must include a changeset (`npx changeset`). Docs/CI-only PRs may add an empty one (`npx changeset add --empty`).
- Semver policy: anything that changes observable transactional behavior (hook timing, propagation semantics, context shape) is **major**; new options/APIs are **minor**; everything else is **patch**.
- Version plan: the package stays at `0.5.0` (unpublished) through milestone M0. The first breaking PR (cls-hooked removal, #3) bumps to `1.0.0-alpha.0`. A stable `1.0.0` is the M5 (npm publish) decision — **no npm publish until then**.

## Tests

- `npm test` spins up the Postgres containers via docker-compose and runs jest; `npm run test:ci` assumes databases are already up (used by CI service containers).
- The storage driver under test is selected with `TEST_STORAGE_DRIVER` (`ASYNC_LOCAL_STORAGE` | `CLS_HOOKED`).
- Bug fixes ship with a test that fails before the fix. Known-broken behavior under repair is tracked with `test.failing`.
