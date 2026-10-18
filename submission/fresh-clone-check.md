# Independent fresh-clone check

This is a partial setup verification for LOG-56, performed on 18 October 2026
by an agent independent of the delivery implementation. Install, configuration-free
checks/build, sample loading and MCP transport are covered below. It is not a
passing S-01 result or a test of the final frozen release.

## Revision and environment

- Initial tested commit: `8da3d96e59c1af626a46c0cc5561a10b78305b81`.
- A new local clone was created with `git clone --no-hardlinks --no-checkout`,
  then detached at that exact commit. It was not a worktree or a reused clone.
- Before installation, `.env`, `.data` and `node_modules` did not exist. No
  credentials, corpus, receipts, dependency directory or build output were copied
  from another checkout.
- Node.js `v24.22.0`, pnpm `11.25.0`, Docker Engine `29.1.3`, ARM64 host.
  The Node 24 runtime was selected on `PATH` explicitly. Commands ran with a
  minimal environment; no inherited model key was available.
- The design submodule was fetched from the recorded origin,
  `https://github.com/serenedb/serene-design.git`, at pinned commit
  `b64024f87ee544e2ca727ddeecd2213c3d8c8d84`.
- The local pnpm content-addressable store was available. Installation reported
  861 packages, 859 reused and zero downloaded. This is a clean checkout check,
  not an empty package-cache or fresh-machine download benchmark.
- The required unpublished ARM64 image was already installed on the host. Its
  checked image ID was
  `sha256:fd1b13533ceff354ffb48901dd63aa36a4b1d3c2b055b872e572bf83f38a7fb0`.
  The server identified itself as `PostgreSQL 18.3 (SereneDB 26.10.1)`.

The local clone path was `/private/tmp/log56-clean-qm8qDt`. The repository source
was a local feature checkout, rather than a fresh authenticated GitHub clone.
Repository access on another machine was not tested.

## Commands and observed results

The commands below ran from the new clone with Node 24 selected. Lifecycle
scripts and all checks remained enabled. No source, lockfile, test, check
configuration or tracked generated file was changed in the clone.

| Command | Result | Observed elapsed time |
|---|---|---|
| `git checkout --detach 8da3d96e59c1af626a46c0cc5561a10b78305b81` | Exact revision; clean tracked working tree | Not measured |
| `git submodule update --init --recursive` | Recorded public origin fetched; pinned revision checked out | Not measured |
| `node --version`; `pnpm --version` | `v24.22.0`; `11.25.0` | Not measured |
| `pnpm install --frozen-lockfile` | Passed; lockfile unchanged, lifecycle scripts ran, including submodule postinstall | 4.2 s, pnpm-reported |
| `pnpm check` | Passed: lint, types, formatting, dependency rules, knip, 66 unit test files / 828 tests | 8.77 s on the permission retry described below |
| `pnpm build` | Passed using Next.js 16.4.0 and webpack; no `.env`, database or model key | 19.55 s wall time |
| `pnpm --silent mcp:desktop-config` | Parseable JSON; absolute executable/arguments; no credential fields | Not measured |
| `pnpm data:setup --samples` | Passed on a fresh isolated volume; base sample balance below | 3.66 s wall time; loader reported 2.9 s |
| `pnpm data:setup --samples --with all` | Passed; separate extended sample database; seven datasets each read/loaded 2,000 with zero rejects | 4.03 s wall time; loader reported 3.2 s |
| `pnpm test:mcp` | Passed: two test files / 13 tests against the new sample databases | 7.08 s wall time |
| `pnpm data:setup --samples` (repeat) | Passed; files already present, unchanged base sample data version and balance | 1.30 s wall time; loader reported 0.6 s |
| `pnpm test:integration` | Passed: 23 files / 407 tests; one existing conditional idempotence test skipped because extended samples were already loaded | 24.64 s wall time |

Times marked as wall time came from `/usr/bin/time -p`, not analytical tool
receipts. These observations are setup diagnostics, not database query or model
latency benchmarks. The successful `pnpm check` retry reused only task caches
created by the initial run in this same new clone.

### Environment errors and retries

The initial sandboxed submodule fetch failed because `github.com` could not be
resolved. The identical command succeeded after network permission was granted.
No local submodule directory was copied as a workaround.

The initial sandboxed `pnpm check` ran for 21.49 s. All static checks and 827 of
828 unit tests passed. The lazy database connection test expected
`ECONNREFUSED` from an intentionally unreachable loopback server, but the sandbox
returned `EPERM`. The unchanged full command passed with network permission.
No test was skipped, weakened or rewritten. Docker metadata and the isolated
sample commands also required permission to access the local Docker socket.

## Sample database isolation and balance

A new `.env` was generated from the tracked example with a new random database
password and an empty `ANTHROPIC_API_KEY`. Before service startup, a loopback
bind probe confirmed the selected host port was free. The settings were:

```dotenv
SERENEDB_IMAGE=local/serenedb:26.10.1-arm64
SERENEDB_HOST=127.0.0.1
SERENEDB_PORT=17956
SERENEDB_DATABASE=postgres
COMPOSE_PROJECT_NAME=log56-fresh-qm8qdt
```

This project used its own newly created container, network and named data
volume. No other checkout's Compose service, port, database or volume was
changed. The password is deliberately excluded from this report. After testing,
`docker compose -p log56-fresh-qm8qdt down --volumes` removed only this temporary
project's container, network and volume; its generated `.env` was removed too.
The clone's tracked working tree remained clean.

The sample files were downloaded directly from pinned Loghub commit
`dd61d0952749ee7963bde24220d1be5ede023033` and passed the loader's size and
SHA-256 validation. No raw files were copied from another checkout.

| Dataset | Lines read | Events loaded | Rejected |
|---|---:|---:|---:|
| BGL sample | 2,000 | 2,000 | 0 |
| OpenStack sample | 2,000 | 2,000 | 0 |

All printed load checks passed. The base database was `log_insights_samples`,
data version `dv_f9c4be888db8f242`. Repeating the base setup downloaded nothing
and preserved that data version. The extension command used
`log_insights_samples_ext`, data version `dv_cfb03d5a5fdbb689`; it did not replace
the base sample database. These are sample counts, not a reproduction of the
full-corpus load balance in the README.

The MCP smoke checks exercised the real stdio process, advertised tools and
schemas, instructions/prompts, resources, validated tool results, receipt files
and receipt lookup, the generated Desktop launch command, foreign working
directories and shutdown. They used the MCP SDK as client and performed no
Claude/model call. Successful transport and prompt retrieval do not establish
that a live client follows the answer contract.

The integration suite ran against these sample databases and its own synthetic
fixture databases in the same isolated server. Its timeout test cancelled a real
query after ten seconds and confirmed that the pool stayed usable. The one
conditional skip was the extension suite's repeat-load test: that suite only
performs this check when it loaded the extension database itself. The earlier
explicit base repeat-load check and the base integration idempotence test passed.

## Remaining release verification

- A final frozen delivery commit and its final README must be tested explicitly;
  the initial commit above predates the LOG-56 delivery changes.
- The default full-corpus `pnpm data:setup`, full load balance and independent
  full-corpus Golden suite were not run in this clone. No full corpus was
  downloaded. Sample success cannot close these requirements.
- Apple Silicon image restoration from an archive was not tested. The required
  exact unpublished image was already installed. A person with only the public
  checkout still needs that archive; this tag cannot be pulled from a registry.
  The official amd64 image and its host setup were not tested here.
- No Claude Code/Desktop connection was added and no live role answer was
  requested. S-01 still needs a real client question/answer with reachable
  receipts on the frozen release. There were no paid model API calls.
- The web production build passed. Browser startup, a live web investigation,
  export, receipt Re-run/digest confirmation, and all three role flows were not
  established by this check. Build success does not establish accessibility.
- Eval quality, baseline comparison, holdout, human review, worked investigation,
  timed demo and video acceptance are separate gates and are not claimed here.

