# AGENTS.md

Operational instructions for agents developing new features in this repository.

Read `CLAUDE.md` before editing code. It contains the detailed project
architecture, domain rules, UI conventions, database migration rules, deploy
notes, and known foot-guns. This file defines the repeatable feature workflow
to follow every time.

## Feature Development Workflow

Follow these steps for every non-trivial feature. Treat this as the default
GitHub-based CI/CD workflow for the repo.

1. Start from a clean understanding.
   - Read the user's request and restate the intended behavior in concrete
     terms before making broad edits.
   - Check `git status --short --branch` and identify any user changes already
     present. Do not overwrite or revert them.
   - Read the relevant sections of `CLAUDE.md`, especially conventions for
     money, dates, validation, repos, migrations, tests, and deployment.

2. Create or use the right branch.
   - For non-trivial work, use a feature branch from current `main`.
   - Branch names should be short and descriptive, such as
     `feat/import-rules`, `fix/projection-card-due-date`, or
     `refactor/settings-form`.
   - Never commit feature work directly to `main` unless the change is truly
     trivial and the user has not asked for a branch.
   - Never force-push `main`.

3. Plan the implementation.
   - Identify the smallest vertical slice that delivers the feature.
   - Prefer existing patterns in `app/`, `components/`, `lib/repos.ts`,
     `lib/validation.ts`, and existing tests.
   - If the feature touches stored data, plan schema, migration SQL, journal
     update, import/export behavior, and backward compatibility before coding.
   - If the feature touches money or dates, confirm it uses integer cents and
     ISO `YYYY-MM-DD` strings.

4. Implement in small, reviewable steps.
   - Keep changes focused on the feature.
   - Put validation schemas in `lib/validation.ts`.
   - Put database access in `lib/repos.ts`; API routes must not run raw SQL.
   - Keep projection logic pure; server-only data loading belongs outside the
     pure engine.
   - Follow the existing UI system and component primitives.
   - Do not commit generated, local, secret, database, build, or cache files.

5. Add or update tests with the change.
   - Add Vitest coverage for pure logic, date math, money math, validation, and
     regression-prone behavior.
   - Add Playwright coverage when the feature changes a critical user flow.
   - Update existing tests instead of weakening assertions.
   - Include edge cases called out in `CLAUDE.md`, especially around credit
     card statements, promos, Plaid sync, migrations, and projection behavior.

6. Run the local CI gate before handoff.
   - Always run:
     ```bash
     npm run check
     ```
   - This must pass before a commit, PR, merge, or deploy. It runs typecheck,
     lint, unit tests, and production build.
   - Run targeted commands while iterating when useful:
     ```bash
     npm run typecheck
     npm run lint
     npm run test
     npm run build
     npm run test:e2e
     ```
   - If any check fails, stop and fix the cause. Do not push or deploy with a
     known red check.

7. Review the diff before committing.
   - Run `git diff` and inspect the whole change.
   - Confirm no secrets, personal data, local scripts, SQLite databases,
     `.env`, `.next`, `node_modules`, `test-results`, or build artifacts are
     staged.
   - For staged changes, audit sensitive values with a search like:
     ```bash
     git diff --cached | grep -iE "(password|secret|token|api[_-]?key)"
     ```
   - Confirm docs, README, `.env.example`, and deployment notes are updated
     when behavior, configuration, or operations change.

8. Commit with clean history.
   - Use one logical change per commit.
   - Use conventional, lowercase commit subjects such as:
     `feat: add import review queue`
     `fix: clamp statement due dates`
     `docs: define agent feature workflow`
   - Keep the subject at 72 characters or less.
   - Write a commit body when the reason, tradeoff, migration concern, or
     deployment note is not obvious from the diff.
   - Do not amend or rewrite existing commits unless the user explicitly asks.

9. Open a pull request for review.
   - Push the feature branch and open a PR against `main`.
   - The PR description should include:
     - What changed.
     - Why it changed.
     - Tests run, including `npm run check`.
     - Migration or deployment notes, if any.
     - Screenshots or screen recordings for meaningful UI changes.
   - Keep PRs small enough to review. Split unrelated work into separate PRs.

10. Let CI/CD protect `main`.
    - Wait for GitHub CI checks to pass before merge.
    - Treat CI failures as blockers. Inspect logs, reproduce locally when
      possible, fix the branch, and rerun checks.
    - Merge only after review requirements and checks are satisfied.
    - Prefer a squash merge so `main` stays linear and readable.

11. Deploy only from a verified state.
    - Deploy from `main` or an explicitly approved release branch.
    - Run `npm run check` before deploy, even if CI passed.
    - For database changes, confirm the migration file and
      `lib/db/migrations/meta/_journal.json` entry are present before deploy.
    - Follow `CLAUDE.md` deployment notes for the actual server workflow.
    - After deploy, verify the app starts, migrations apply, and the changed
      user flow works in the deployed environment.

12. Close the loop.
    - Report what changed, what was verified, and any residual risk.
    - If follow-up work is needed, capture it in the PR or a tracked issue.
    - Update `CLAUDE.md` or this file when the feature reveals a durable
      convention, gotcha, or CI/CD rule that future agents need.

## Definition of Done

A feature is done only when all of these are true:

- The implementation matches the requested behavior.
- The change follows project architecture and domain conventions from
  `CLAUDE.md`.
- Appropriate unit, integration, or e2e tests were added or updated.
- `npm run check` passes locally.
- The diff has been reviewed for secrets, generated files, and unrelated
  changes.
- The branch is ready for PR review, CI, and a clean merge to `main`.
- Deployment and migration notes are documented when relevant.

## Stop Conditions

Stop and ask for clarification before continuing when:

- The requested behavior conflicts with existing domain rules.
- A migration could destroy or rewrite user financial data.
- Required secrets, credentials, or third-party accounts are missing.
- A CI or build failure points to an unrelated user change that cannot be
  safely fixed within the feature branch.
- The safest implementation choice would significantly expand scope beyond the
  requested feature.
