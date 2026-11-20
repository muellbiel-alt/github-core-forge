# github-core-clone-01 Forge

[![make.fun competition](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![Rank](https://make.fun/badge/github-core-clone-01/muellbiel-alt/github-core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![Reward](https://make.fun/badge/github-core-clone-01/muellbiel-alt/github-core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, deterministic, pure Node.js 22 GitHub-compatible git forge built for [make.fun `github-core-clone-01`](https://make.fun/bounty/github-core-clone-01):
- Git smart HTTP (`/{owner}/{repo}.git`: `upload-pack` protocol v2 & v0, `receive-pack` v0)
- GitHub REST API v3 (`/api/v3/...`)
- GitHub GraphQL API v4 (`/api/graphql`)
- Model Context Protocol Streamable HTTP (`/mcp`)

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http`, `node:net` and its own `app.ts` only, and the trial has no package manager and
no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. Whether a missing or a wrong token
is refused is part of the protocol checks, not of this starter.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## How v2 stays fast

The four timed workloads (push, clone, read, write) are dominated by per-request HTTP overhead, so
v2 cuts that instead of the application logic. The handlers, the store, and every response byte are
unchanged; only the wire path and the hot-path allocations moved.

- **Raw-TCP HTTP/1.1 transport (`src/transport.ts`, default).** A hand-rolled request parser and
  response serializer on `node:net`. It extracts only the headers the handlers read
  (`authorization`, `git-protocol`, `host`, `content-length`, `transfer-encoding`, `connection`),
  supports content-length and chunked bodies, keep-alive, and pipelined requests, and serializes
  each response in a single `sock.write()`. It drives the exact same handler as the node:http
  server (`createForgeHandler` in `app.ts`), so conformance cannot drift between transports.
  Set `MAKEFUN_TRANSPORT=http` to run the node:http server instead.
- **Pre-serialized JSON and buffer cache.** Every issue, repo, and issue list is stored as a
  `Buffer.from(JSON.stringify(...))` and served as-is; the cache is invalidated only on mutation,
  so 2,000 sequential `GET`s of one issue never repeat `JSON.stringify` or UTF-8 encoding.
- **Zero-allocation hot paths.** The git route is parsed with `indexOf`/`slice` instead of a
  regex, `decodeURIComponent` runs only when a segment actually carries a `%` escape, the
  query string is parsed with `indexOf('?')`/`slice`, and the two hot JSON paths share one
  reusable headers object (Node copies header values at `writeHead` time, so mutating it
  between requests is safe).
- **Git pack caching.** `deflateSync` output is cached per object SHA-1 and whole `PACK`
  payloads are cached per fetch (ls-refs, fetch, and the receive-pack advertisement each have
  their own cache, all invalidated on mutation), so a 50-way concurrent shallow clone builds
  its pack once.

Local grade (`node cli/makefun.mjs grade-local --kit . --bot . --driver process --instances 3`,
3 instances, this VM): feature 600/600, agent 200/200, perf 192, `perf_p50_us` 184,371, score
992; the state export is byte-identical across trials. Those are local numbers — the production
server is slower, and the v1 entry scored 924 there (feature 600, agent 200, perf 124,
`perf_p50_us` 581,122).

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the server and the transport-agnostic handler (`createForgeHandler`, `createApp`).
- `src/transport.ts`: the raw-TCP HTTP/1.1 transport (default) and the node:http fallback.
- `src/store.ts`, `src/rest.ts`, `src/git.ts`, `src/graphql.ts`, `src/mcp.ts`: the store and the
  four protocol handlers.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

The starter is MIT licensed; a submitted entry must carry an OSI-approved licence of its own.
