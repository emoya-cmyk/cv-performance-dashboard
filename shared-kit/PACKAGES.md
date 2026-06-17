# Shared-kit packaging — publish & consume (GitHub Packages)

The shared-kit JS packages (`@emoya-cmyk/dashboard-core`, `@emoya-cmyk/memory-os`)
are currently **vendored** into the consumer repos (copied into `api/vendor/…`,
synced from this canonical source). This doc is the **scaffold to move from
vendoring to real published dependencies** when you're ready — nothing here is
active until an operator runs the publish workflow.

> Why this is optional: vendoring works today with **zero** registry/deploy-auth.
> GitHub Packages is the cleaner long-term end-state (real semver, one source of
> truth) but adds a private-registry token to every install/deploy environment.
> Flip the switch when that auth is worth setting up org-wide.

---

## 1. Publish (one manual step)

The packages declare `publishConfig.registry = https://npm.pkg.github.com` and stay
`private: true` in source (an accidental-publish guard).

Run the **manual** workflow — `.github/workflows/publish-shared-packages.yml`
(Actions tab → "Publish shared packages" → Run workflow):
- choose `dashboard-core`, `memory-os`, or `both`;
- tick `dry_run` first to preview (`npm pack`) without publishing.

The workflow flips `private:false` **ephemerally in its own runner** (the committed
`package.json` is never changed) and `npm publish`es with the built-in
`GITHUB_TOKEN` (`packages: write`). Bump each package's `version` before re-publishing.

> **Python:** `@emoya-cmyk/memory-os-py` (`shared-kit/memory-os-py`, `pyproject.toml`)
> is not a JS package — publish it separately (PyPI, or `pip install` from a git URL)
> per its own README. It's out of scope for the npm workflow above.

## 2. Consume (in a dashboard repo)

1. Add an `.npmrc` from the template: `cp shared-kit/.npmrc.example <repo>/.npmrc`
   (it scopes `@emoya-cmyk` to GitHub Packages and reads `${GITHUB_TOKEN}`).
2. `npm install @emoya-cmyk/dashboard-core @emoya-cmyk/memory-os`.
3. Replace the vendored copy: change `require('../vendor/dashboard-core')` →
   `require('@emoya-cmyk/dashboard-core')` and delete `api/vendor/dashboard-core/`.
   (Do this one repo at a time; the leak-proof/auth tests are the gate.)
4. **Deploy:** Render/Vercel build envs need a `GITHUB_TOKEN` (or a PAT with
   `read:packages`) available so `npm ci` can resolve the private packages. This is
   the one-time infra cost the vendoring approach avoided.

## 3. Prerequisite — the org reusable-workflow repo (Step 0)

Independent of packages, the kit's reusable CI (`shared-kit/.github/workflows/node-ci.yml`)
needs a host so repos can call it instead of inlining CI:

1. Create **`emoya-cmyk/.github`** (a user/org account's special repo; public so
   private repos can reference its workflows).
2. Copy `shared-kit/.github/workflows/node-ci.yml` → `.github/workflows/node-ci.yml`
   in that repo.
3. In each consumer, replace the inlined `ci.yml` with the one-liner caller
   (`shared-kit/.github/workflows/ci-caller-example.yml`), setting `test-dir`/`build-dir`.

Until then, every repo **inlines** equivalent CI (works fine) — see
`CROSS_REPO_PLAYBOOK.md`. Creating that org repo is outside a single repo-scoped
session; it's the account owner's one-time action.
