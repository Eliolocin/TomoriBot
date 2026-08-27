# Contributing to TomoriBot

Thanks for your interest in contributing! This guide covers what you need to know before opening a PR.

## Branching

| Branch | Purpose |
|---|---|
| `main` | Default branch, fork from here, target PRs **here** |
| `release` | Deploy gate, stable versions that reflect the public deployed TomoriBot.|
| `dev` | Maintainer's personal (unstable) development branch. |

Cloud deployment lives on `release` only. A `main` checkout has no `terraform/`, `deploy/`,
`.github/release/`, or `docs/en/wiki/cloud/`, which keeps a self-hoster's clone to the bot itself.
Read a release-only file without switching branches:

```bash
git show release:terraform/azure/main.tf
```

Fixes belong on `main` and flow forward into `release`. Never merge `release` into `main`: that
reintroduces those paths to `main` and recreates a merge base containing them, after which the next
`main` into `release` merge deletes them from `release` with no conflict and no warning. CI enforces
this on PRs to `main`.

## Quality Gates

The project has no strict coding standards other than what the automated tools enforce, but reading the official [Contributing](https://docs.tomoribot.app/en/contributing/) and [Architecture](https://docs.tomoribot.app/en/architecture/) docs can help you understand and follow established code conventions in the project.

Please refer to the [Pull Request Template](./pull_request_template.md) for the exact list of local checks you should run before submitting a PR. CI handles these automatically, but running them locally and fixing any problems saves time. If your PR is too big (around ~1000 lines of changes/additions), please split it up into multiple, smaller PRs instead if possible so it is easier to discuss and test.

### AI-Generated Code
This project accepts code and documentation created/assisted by AI tools. But just like all tools, the one using it (you) is responsible for it. It is also preferred to point your agent to `docs\architecture` and `docs\contributing` so it can follow conventions and security measures established around the codebase. Please test and review thoroughly before opening a PR, and be ready to discuss and fix problems that the maintainer(s) find, if any.

## Scope of Contributions

Welcome without prior discussion:

- Bug fixes with a clear repro
- Locale corrections or new translations
- New built-in tools or LLM providers that follow the existing adapter pattern
- New top-level slash commands
- Performance improvements (no behavior change)

Please open an issue first to discuss:

- Architecture or schema changes
- Changes to caching, security, or persona-identity behavior
- New external integrations (Matrix, SillyTavern-style imports, etc.)

## License

TomoriBot is licensed under **AGPL-3.0**. By submitting a contribution, you agree it will be licensed under AGPL-3.0. AGPL requires source disclosure to users of network-deployed modified versions. Please understand this before contributing or self-hosting a fork.

## Security

Do **not** open public issues for security vulnerabilities. See [`SECURITY.md`](./SECURITY.md) for the private reporting process.
