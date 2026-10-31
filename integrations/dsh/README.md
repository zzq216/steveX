# DSH integration

SteveX uses DeepSeek Harness as an optional Agent runtime. The upstream runtime
is installed from npm instead of being copied into this repository.

## Version and source

- npm package: `@deepseek-ai/dsh@0.2.1-rc.5` (exact version in `package-lock.json`)
- upstream repository: <https://github.com/deepseek-ai/deepseek-harness>
- upstream tag: `dsh-v0.2.1-rc.5`
- upstream commit: `b830ec950faba0a46dda564be3e2d854afed94f1`

## Upgrade history

| Date | From → to | Notes |
|---|---|---|
| 2026-10-31 | `0.2.1-rc.2` (`687f282e`) → `0.2.1-rc.5` (`b830ec95`) | Every core package the plugins use (`core/agent`, `core/agent-loop`, `core/tools`, `core/system-prompt`, `core/session`, `core/scope`, `llm/llm`, `interaction/commands`, `preset/agent-preset-registry`) changed only its version; router and agent tests pass unchanged; in-DSH smoke test passed. Behavior changes that reach steveX: (1) New Session reuses the workspace's first unstarted blank Session (upstream guide `v0.2.1-rc.2/new-session-blank-reuse`), so restart the Host after changing the `stevex` preset before starting a session; (2) together with the existing limitation that the Web transcript renders command rows only after a turn has started, a `/bt status` typed on the start page shows nothing and New Session keeps returning to that blank Session — send any message first (see the root README FAQ); (3) the DeepSeek provider declares a 1M context window for both official models and fetches an uncustomized catalog from the official `/models` listing; model ids are unchanged. |

## Upgrading

1. Back up the DSH profile directory (sessions may be migrated forward and cannot be downgraded).
2. On a branch: `npm install @deepseek-ai/dsh@<version> --save-exact`, then `npm run dsh -- --version`.
3. Compare the upstream tags for the packages listed above and read new `docs/upgrade-guide/` entries.
4. Run the router and agent tests file by file, check `npm run dsh -- --profile stevex --dump-config`, restart the Host, and smoke-test in a new session.
5. Update this file (version, tag, commit, history row).

Run `npm install` after cloning, then use `npm run dsh -- web` or
`start-dsh.bat`. DSH keeps its user profiles and runtime data outside the
SteveX source tree.

## Customization boundary

Do not edit DSH under `node_modules`. SteveX-owned behavior belongs in
`dsh-plugins/`; currently `dsh-plugins/router` contains the staged routing
framework. Install it into the desired DSH profile as described in that
package's README.

If a future DSH core change is unavoidable:

1. record the upstream tag and commit;
2. keep the change as a small patch in `integrations/dsh/patches/`;
3. add a reproducible application step and a regression test;
4. prefer submitting the fix upstream before carrying it locally.

## Archived source-build patch

`patches/0001-windows-git-status-max-buffer.patch` records the only SteveX core
change found in the previously vendored DSH tree. It raised `spawnSync`'s
buffer while a whole vendored source tree was being replaced. The npm runtime
does not execute that source-build helper, so the patch is retained for
history and source-build troubleshooting but is not applied during install.

The original full source remains recoverable from Git history before the
dependency migration; it is not needed in current checkouts.
