# nexxus-cli

Administration and bootstrapping CLI for a [Nexxus](https://github.com/) deployment.

Nexxus is a self-hosted, pluggable, real-time sync backend. Its runtime processes (the API and the workers) assume their infrastructure — database indices, message-queue topology — **already exists**; they don't create it. `nexxus-cli` is the tool that provisions that infrastructure and manages applications, out of the runtime hot path.

It's built on the same `@mayhem93/nexxus-*` libraries the API and workers use, so it reads the **same config file format** and selects service implementations the same pluggable way.

---

## What it does

- **`bootstrap`** — one-shot, idempotent provisioning of deployment infrastructure (database, message queue).
- **`app`** — manage Nexxus applications (currently: create).

The CLI **provisions structure inside** your database / message-queue; it does **not** install, start, or manage those services. They must be **running and reachable beforehand** (with sufficiently privileged credentials — see [Configuration](#configuration)).

---

## Requirements

- **Node.js ≥ 24**
- A running **database** (e.g. Elasticsearch) and/or **message queue** (e.g. RabbitMQ), reachable from where you run the CLI.
- A config file at `~/.nexxus/cli.conf.json` (see [Configuration](#configuration)).

---

## Install

Install globally from npm:

```bash
npm install -g @mayhem93/nexxus-cli
```

This puts the `nexxus-cli` command on your `PATH`; run it from anywhere:

```bash
nexxus-cli --help
```

---

## Configuration

The CLI reads a single JSON config file.

- **Location (hardcoded):** `~/.nexxus/cli.conf.json`
- The file **must already exist** — the CLI errors out with a clear message if it's missing. Create/populate it by whatever means you like.

### Format

It's the **same layered config format** used by the Nexxus API and workers (resolved by `nexxus-core-lib`'s config manager: file → `NXX_*` environment variables → CLI arguments). You can reuse an API/worker config file as-is.

The shape is:

- an **`app`** block that selects service implementations **by class name** — `logger`, `database`, `message_queue` (built-in names resolve directly; any other value is loaded as an npm package);
- one **top-level block per service** (`database`, `message_queue`, `logger`, …) carrying that implementation's settings.

The **exact fields depend on which services your deployment uses**, and each is documented in that service's own repository README. Reference examples:

- `nexxus-api/example.api.conf.json`
- `nexxus-worker-writer/example.worker.conf.json`

### Credentials

Because the CLI **provisions** infrastructure, its config should carry **privileged** credentials — separate from (and higher-privileged than) the runtime API/worker configs:

- **Database:** a user allowed to create indices/tables.
- **Message queue (RabbitMQ):** the **admin / super-user** (used to authenticate to the broker's HTTP management API), and the `message_queue` block must include **`managementPort`** (RabbitMQ management API, default `15672`). The less-privileged *runtime* user is created by the CLI at bootstrap time — you supply it via flags, not config (see the `bootstrap message-queue` command below).

### Example (Elasticsearch + RabbitMQ)

```json
{
  "database": { "host": "localhost", "port": 9200, "user": "elastic", "password": "…" },
  "message_queue": {
    "host": "localhost",
    "port": 5672,
    "managementPort": 15672,
    "user": "admin",
    "password": "…"
  },
  "app": {
    "logger": "WinstonNexxusLogger",
    "database": "NexxusElasticsearchDb",
    "message_queue": "NexxusRabbitMq"
  },
  "logger": { "level": "info", "logType": "text" }
}
```

---

## Usage

```bash
nexxus-cli <command> <subcommand> [options]
```

Global options:

- `--help` / `-h` — contextual help. Works at every level: `nexxus-cli --help`, `nexxus-cli bootstrap --help`, `nexxus-cli bootstrap database --help`.
- `--version` — print the CLI version and exit.

`--help` and `--version` need neither the config file nor a running service.

### Commands

#### `nexxus-cli bootstrap database`

Provisions the configured database. For Elasticsearch this creates the base deployment index (`nxx-application`) with explicit mappings. **Idempotent** — safe to re-run.

```bash
nexxus-cli bootstrap database
```

#### `nexxus-cli bootstrap message-queue --runtime-user <user> --runtime-password <password>`

Provisions the configured message queue. For RabbitMQ this creates the `/nexxus` vhost, the **runtime user** (from the flags below) scoped to that vhost, the `systemMessages` fanout exchange, and one durable quorum queue per static pipeline stage. It runs entirely over the broker's HTTP management API using the admin credentials from your `message_queue` config — so the adapter does **not** need to connect first. **Idempotent**.

| Flag | Required | Description |
| --- | --- | --- |
| `--runtime-user` | yes | The less-privileged runtime user to create — the account the API/workers connect as. |
| `--runtime-password` | yes | Password for that runtime user. |

```bash
nexxus-cli bootstrap message-queue --runtime-user nexxus_rt --runtime-password 's3cret'
```

> The password is passed on the command line, so it may appear in shell history and the process list. Run it in a trusted environment (or clear your history afterward).

#### `nexxus-cli app create --payload <json|path>`

Creates a Nexxus application: first provisions its per-app storage, then persists the application document, and prints the generated app id.

`--payload` (required) is the application definition, supplied one of two ways:

- an **inline JSON object** (a value whose trimmed form starts with `{`), or
- a **file path** to a `.json` file — a bare path (relative to the current directory) or a `file://` URL.

```bash
# inline
nexxus-cli app create --payload '{"name":"demo","schema":{"todo":{"title":{"type":"string"}}}}'

# from a file
nexxus-cli app create --payload ./app.json
nexxus-cli app create --payload file:///D:/app.json
```

The payload must at minimum contain a `name` and a non-empty `schema`; validation (reserved field names, auth block coherence, limits, …) is enforced when the application is constructed, so a bad payload fails fast with a clear error. The app id is generated for you.

> `app create` is **not** idempotent — creating an application that already exists fails on the duplicate.

---

## Behavior & notes

- **Services must exist first.** The CLI expects the database / message queue to be running; it provisions *within* them.
- **Bootstrap is idempotent**; re-running `bootstrap database` / `bootstrap message-queue` is a no-op for anything already present.
- **Errors** surface with a clear message; the process exits non-zero (`1` for config/runtime errors, `2` for argument/usage errors).
- **Current limitation (v1):** the CLI connects to the database for *every* command, so the database must be reachable even when running `bootstrap message-queue`. This will be refined to per-command connection needs later.

---

## Development

```bash
npm run build     # tsc -> dist/, plus copies src/schemas into dist/
npm run lint      # eslint
```

The project is ESM/TypeScript (NodeNext). Commands live in `src/commands/`, the CLI host/service in `src/lib/NexxusCli.ts`, and the argparse command base in `src/cli/Command.ts`. Adding a command is a matter of subclassing `Command` and registering it in `NexxusCli`.
