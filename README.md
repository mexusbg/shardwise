# Shardwise

Cross-platform MongoDB GUI (Windows, macOS, Linux) with a visual Filter Builder,
Table / Tree / JSON result views, in-place editing and import/export.

> **Please read [Before you use it](#before-you-use-it) first.** Shardwise was built mainly with an AI model,
> some features have so far been verified only by automated tests, and it comes with no warranty.
> Try it on a non-production database and keep a proper backup.

## Before you use it

**How it was made.** Shardwise was created mainly with Claude, Anthropic's AI model, under the direction of its
author.

**How it was tested.** The project has a large automated test suite: about 880 unit and integration tests, many of
them against a real MongoDB server, and an end-to-end test that clicks through the packaged app on Windows and
Linux. Some features have only been verified by these automated tests and have not yet been tested in everyday use
with real-world data. Expect rough edges, especially with unusual data, very large collections and less common
server setups. Bug reports are welcome.

**Use it safely.**

- Try Shardwise on a non-production database first, or on a copy of your data.
- Keep a proper, tested backup before you edit, delete, import, migrate, sync, mask or restructure data.
- Read-only connections and the read-only lock of a tab prevent accidental writes. Change History can undo many
  changes, but it is not a backup.

**No liability.** Shardwise is provided "as is", without warranty of any kind, express or implied. The author and
Fidweb are not liable for any loss of data, damage or other liability, whether in contract, tort or otherwise,
arising from the use of the software or the inability to use it. You use it at your own risk. See also the
[license](LICENSE).

## Author and support

Made by [Fidweb](https://fidweb.net). Author: mexus.

If Shardwise is useful to you, you can support its development on [Ko-fi](https://ko-fi.com/mexus).

## Installation

Download the installer for your system from the
[latest release](https://github.com/mexusbg/shardwise/releases/latest):

| System | File |
|---|---|
| Windows 10 / 11 (x64) | `Shardwise-<version>-win-x64.exe` |
| macOS on Apple Silicon (M1 or newer) | `Shardwise-<version>-mac-arm64.dmg` |
| Linux x64 | `Shardwise-<version>-linux-x86_64.AppImage` or `Shardwise-<version>-linux-amd64.deb` |

The builds are not code-signed yet, so each system shows a one-time warning the first time you start Shardwise.
Intel Macs are not supported.

### Windows

1. Run `Shardwise-<version>-win-x64.exe`.
2. If a blue SmartScreen box says "Windows protected your PC", click **More info**, then **Run anyway**.
3. Follow the installer. It lets you choose the folder and creates Start menu and desktop shortcuts.

To uninstall: **Settings → Apps → Installed apps → Shardwise → Uninstall**.

### macOS (Apple Silicon)

1. Open the `.dmg` and drag **Shardwise** into **Applications**.
2. Open Shardwise. macOS blocks it because the build is not notarized.
3. Go to **System Settings → Privacy & Security**, scroll to the message about Shardwise, click **Open Anyway**
   and confirm with your password.

If there is no Open Anyway button, or macOS says the app "is damaged", run this once in Terminal and open it again:

```bash
xattr -dr com.apple.quarantine /Applications/Shardwise.app
```

### Linux

**Debian / Ubuntu (.deb):**

```bash
sudo apt install ./Shardwise-<version>-linux-amd64.deb
```

**Any distribution (AppImage):** the AppImage is the program itself, no installation needed.

```bash
chmod +x Shardwise-<version>-linux-x86_64.AppImage
./Shardwise-<version>-linux-x86_64.AppImage
```

- If it fails with `dlopen(): error loading libfuse.so.2`, install FUSE 2: `sudo apt install libfuse2` on
  Ubuntu 22.04, `sudo apt install libfuse2t64` on Ubuntu 24.04 and later.
- If it exits with a "SUID sandbox helper" error (Ubuntu 24.04 and later), start it with `--no-sandbox`, or use
  the `.deb`.
- For a menu entry and dock icon, use [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) or
  [Gear Lever](https://github.com/mijorus/gearlever).

### Updates

Shardwise checks GitHub for a newer release when it starts and shows a link in the status bar when one is
available. Nothing is downloaded or installed without you; turn the check off in **Settings → About**. To update,
install the new version over the old one: settings and saved connections are kept.

## Features (phase 1)

- **Connections** — `mongodb+srv://`, standalone, replica sets, raw URI; import/export URIs; SCRAM, X.509,
  LDAP, Kerberos, AWS IAM; TLS with CA / client certificates; SSH tunnels (password or key) that work with
  SRV and replica sets; passwords encrypted with the OS keychain.
- **Server tree** — databases, collections and views with document counts; create, rename, drop.
- **Query tab** — Query / Projection / Sort / Skip / Limit in shell syntax (`ObjectId("…")`, `ISODate("…")`,
  regex literals), autocomplete, paging, count, read-only lock.
- **Filter Builder** — drag fields from the results, `$and` / `$or` / `$nor` / `$elemMatch` groups,
  ~25 operators, typed values, projection and sort sections; two-way sync with the query text.
- **Result views** — Table (step into nested fields, hide/resize columns), Tree, JSON.
- **Editing** — edit in place, Edit Value / Type with conversion, edit document as JSON, insert / paste /
  duplicate documents, set / rename / add / remove fields for one document, the query or the collection,
  delete documents.
- **Query profiling** — Explain Plan view (visual stage tree, COLLSCAN / in-memory sort warnings), Query Profiler
  on `system.profile` (levels, slow-op threshold, operations and query shapes, open in tab), current operations
  with kill.
- **Playground** — JavaScript / TypeScript with the driver, mongosh-style `db.coll.find()`, and Mongoose
  (`User.find(...)` works without a schema); runs in a killable worker.
- **Defaults & helpers** — header-click sorting, default query per connection / database / collection,
  auto-cast of `'650a…'` / ISO strings to ObjectId / Date for fields that hold those types, type preselection in
  the builder.
- **Connection import / export** — Shardwise JSON (passwords optional, passphrase-encrypted), URI lists; import
  from Studio 3T®, MongoDB Compass and Robo 3T connection exports (for compatibility only).
- **Import / export** — JSON (mongo shell syntax, mongoexport canonical & relaxed, legacy shell,
  pure JSON), CSV, Excel, BSON via the bundled `mongodump` / `mongorestore` (folder or archive, gzip).

## Features (phase 2 — power tools)

- **Aggregation editor** — stage list with templates, per-stage input / output previews, pipeline as text,
  explain, create view, open a find query as a pipeline.
- **Index manager** — sizes, usage statistics, build progress, hide / unhide, drop, full create dialog
  (compound, text, 2dsphere, hashed, wildcard, TTL, partial, collation).
- **Shell** — mongosh-style REPL with persistent variables, `use`, `show …`, `it`, history, interrupt.
- **Query history & Query Library** — every run recorded; saved queries in folders.

## Features (phase 3 — extras)

- **Query Code** — the current query as mongosh, Node.js, Mongoose, Python, Java, C#, Go, PHP, Ruby or SQL.
- **Schema explorer** — field types, presence, statistics, top values; export JSON Schema / validator.
- **SQL query** — write SQL (WHERE, GROUP BY / HAVING, JOIN, functions) and run it as find / aggregate.
- **Users & roles** — users, built-in and custom roles, privileges.
- **Compare & sync** — compare two collections by key (field-level diff) and sync them with a dry run.
- **AI helper and assistant** — describe a query in plain language and the AI writes it; a chat assistant can run
  read-only queries. Works with Claude (Anthropic) or any OpenAI-compatible service: OpenAI (ChatGPT models),
  Gemini, Mistral, Groq, OpenRouter, DeepSeek, or a local model with Ollama or LM Studio. Your own API key is stored
  encrypted; only field names / types are sent unless you opt in to sample documents. A local MCP server lets
  external AI agents (Claude Code, Cursor, VS Code…) query the connections you choose.
- **Data masking & reschema** — masked copies / exports, and field renames / type changes via update pipelines.

## Features (phase 4 — SQL migration)

- **MongoDB → SQL** and **SQL → MongoDB** for PostgreSQL, MySQL / MariaDB, SQL Server and SQLite: inferred
  relational mapping (flattened objects, child tables for arrays), mapping editor, embedding via foreign
  keys, live migration or a generated `.sql` file.

## Development

Requires Node.js 24 (see `.nvmrc`).

```bash
npm install
npm run dev          # start the app with hot reload
npm test             # unit + integration tests (downloads a MongoDB binary on first run)
npm run typecheck
npm run build && npm run e2e   # launch the built app against a seeded in-memory MongoDB, save screenshots to .e2e/screens
```

If you run commands from a terminal inside VS Code, unset `ELECTRON_RUN_AS_NODE` first, otherwise Electron
starts as plain Node.

## Packaging

```bash
npm run dist:win     # NSIS installer
npm run dist:mac     # dmg (Apple Silicon), must run on macOS
npm run dist:linux   # AppImage + deb
```

From Windows, the Linux and macOS packages can be built in WSL (Ubuntu with nvm; no compiler needed):

```bash
wsl.exe -d Ubuntu-22.04 -- bash scripts/wsl-build.sh linux mac
```

The macOS build made on Linux is a `.zip` of `Shardwise.app` (a dmg needs macOS), ad-hoc signed with
[rcodesign](https://github.com/indygreg/apple-platform-rs) so Apple Silicon runs it.

Installing the builds: see [Installation](#installation). For the `.zip` made in WSL: unzip it, move
`Shardwise.app` to Applications and follow the macOS steps; if it still refuses to start, re-sign it locally with
`codesign --force --deep --sign - /Applications/Shardwise.app`.

Supported targets: Windows 11 x64, Linux x64 (AppImage, .deb), macOS on Apple Silicon (arm64).
Each `dist:*` script first downloads the official MongoDB Database Tools (Apache-2.0) for that target into
`resources/tools/<os>-<arch>/`; `mongodump` / `mongorestore` ship inside the app, so nothing needs installing.
`npm run tools:fetch` does the same for the current machine (used by `npm run dev`).

Installers land in `release/<version>/`. The GitHub Actions workflow in `.github/workflows/build.yml` tests
every push and pull request and builds all three platforms; pushing a version tag (`git tag v0.3.0 && git push
origin v0.3.0`) also creates a GitHub release with the installers attached. Builds are unsigned; add signing
certificates via electron-builder environment variables when needed.

### Update checks

At launch (and with **Settings → About → Check now**) the app asks GitHub for the latest release of the
repository named in `package.json` → `repository` ([mexusbg/shardwise](https://github.com/mexusbg/shardwise)) and
shows a link to the release page when it is newer. Nothing is downloaded or installed automatically, and users can
turn the check off. Releases come from version tags such as `v0.3.0` (see above); drafts and pre-releases are
ignored.

## Layout

| Path | What |
|---|---|
| `src/shared` | Pure logic shared by both processes: query-builder model, BSON value typing, connection URIs, API contract |
| `src/main` | Electron main process: MongoDB driver, SSH tunnel, saved connections, import/export jobs |
| `src/preload` | Minimal IPC bridge |
| `src/renderer` | React UI |
| `tests` | Vitest unit and integration tests (mongodb-memory-server, in-process SSH server) |

## Trademarks & independence

Shardwise is an independent project. It is not affiliated with, endorsed by or sponsored by MongoDB, Inc.,
3T Software Labs (Studio 3T) or any other vendor. MongoDB is a trademark of MongoDB, Inc.; Studio 3T is a
trademark of 3T Software Labs; Robo 3T and other names are trademarks of their respective owners. They are
mentioned only to describe compatibility (for example, importing connection exports from those tools).
No third-party source code, artwork or text is included.

Third-party open-source components and their licenses are listed in `THIRD_PARTY_NOTICES.md` (shipped with
the app); the bundled MongoDB Database Tools are Apache-2.0 licensed, with their LICENSE and notices included.

## License

[MIT](LICENSE) © 2026 mexus (Fidweb). Third-party components keep their own licenses (see `THIRD_PARTY_NOTICES.md`).
