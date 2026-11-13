# Contributing

## Building and testing

You need Node.js 22.18 or newer and pnpm 9. testsky runs its TypeScript as it
is; there is nothing to build except the report viewer and the playground page.

```bash
pnpm install
pnpm typecheck
pnpm test        # no phone and no model needed
```

Tests sit beside the code they test (`*.test.ts`, `node:test`) and must run
without a device or a model: a fake engine stands in for the phone. A change to
how a step is carried out on a phone should also say how it was tried on a real
one -- which phone, which app, what happened.

## Writing

- Code, comments and commit messages are in English. Commit subjects follow
  [Conventional Commits](https://www.conventionalcommits.org/): `fix(executor): ...`.
- A comment says why, in plain words, with the case that made it necessary.
- An outcome is a promise to whoever reads the report: only `FAIL_ASSERT` and
  `FAIL_REJECTED_HEAL` may say the app is broken. A change that turns "could
  not tell" into a failure of the app needs a very good reason.

## Sign-off

Every commit is signed off under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/):

```bash
git commit -s
```

adds `Signed-off-by: Your Name <you@example.com>`, by which you certify that
you wrote the change, or have the right to submit it, under the project's
license (Apache-2.0).
