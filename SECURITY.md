# Security Policy

DbArk is a local-first database GUI client. Its security posture is built on a
single principle: **every privacy and security claim in this document should be
verifiable by you, on your own machine, without trusting us.** Where a claim can
be checked in under a minute, we tell you how.

This document covers the security architecture of DbArk v1.0, the threat model it
was designed against, and how to report a vulnerability.

- **License:** MIT — the entire codebase is open and auditable.
- **Stack:** Tauri v2 · Rust · React · C# NativeAOT.
- **Engines:** six engines via four drivers — PostgreSQL, CockroachDB, MySQL,
  MariaDB, SQLite, SQL Server — plus flat-file querying (CSV/JSON/Excel via DuckDB).

---

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅ Yes — security fixes shipped via the auto-updater |
| < 1.0   | ❌ Pre-release builds are not supported |

---

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately through one of:

1. **GitHub private vulnerability reporting** — the preferred channel.
   Go to the repository's **Security** tab → **Report a vulnerability**.
2. **Email** — `SECURITY_CONTACT_EMAIL` *(replace with your real address before
   publishing)*. Encrypt with the PGP key in `SECURITY-PGP.asc` if you wish.

Please include: affected version, platform/OS, reproduction steps, and impact.

**Our commitment:**

- We acknowledge reports within **72 hours**.
- We provide an assessment and remediation timeline within **7 days**.
- We credit reporters in the release notes unless you ask us not to.
- We will not pursue legal action against good-faith security research conducted
  under this policy.

Because DbArk is local-first and has no server-side component, the impact surface
is the user's own machine and their database connections — there is no shared
backend for an attacker to compromise.

---

## Security philosophy

DbArk's target users are privacy-conscious, security-aware developers and DBAs who
are rightly suspicious of database tools that could exfiltrate credentials, phone
home, or quietly lock them into a cloud. Our answer is not to ask for trust — it
is to remove the need for it:

- **No account. No login. No telemetry.** Nothing leaves your machine except the
  database traffic you explicitly configure.
- **Credentials live in the OS keychain only** — never in our files, never in the
  UI layer, never in logs.
- **The binary verifies itself before it runs.**
- **The source is open.** Every claim below can be confirmed by reading the code.

---

## Threat model

### What DbArk is designed to protect against

- **Credential theft from disk.** Connection files contain no passwords; passwords
  live only in the OS keychain.
- **Credential exposure to the UI/web layer.** Passwords never cross the IPC
  boundary into the WebView, so a compromised frontend dependency cannot read them.
- **Memory-dump credential recovery.** Connection strings are zeroed after use.
- **Silent data exfiltration / telemetry.** There is none, and it is
  Wireshark-verifiable.
- **Supply-chain tampering with native libraries.** Every native DLL is
  SHA-256-verified at startup before it is loaded.
- **Accidental writes to production.** Read-only connection mode is enforced at the
  driver level, not just hidden in the UI.
- **Shoulder-surfing / screen capture of sensitive history.** Session lock,
  clipboard auto-clear, and encrypted history reduce passive exposure.

### What is explicitly out of scope

- **A fully compromised host OS.** If an attacker already has code execution as
  your user, the OS keychain, your live DB sessions, and DbArk's process memory are
  all reachable. No client-side tool can defend against this; DbArk's protections
  raise the cost of disk-at-rest and memory-dump attacks, not root-level compromise.
- **Database-side authorization.** DbArk respects the permissions of the login you
  give it. It does not and cannot grant access your DB account does not have.
- **Network-level MITM when SSL is disabled by the user.** TLS verification is
  available and recommended (`require` / `verify-full`); choosing `none` is your
  decision and your risk.

---

## Credential handling

| Control | Implementation |
| --- | --- |
| Password storage | OS keychain only — Windows Credential Manager / macOS Keychain / Linux Secret Service, via the Rust `keyring` crate. |
| IPC boundary | Passwords are fetched in the native (Rust/C#) layer at connection time and **never** marshalled across the Tauri IPC boundary into JavaScript. |
| Connection files | `~/.dbark/connections/*.toml` store host, port, database, username, and SSL settings — **never** a password. These files are safe to commit to Git. |
| In-memory lifetime | The assembled connection string is zeroed in memory immediately after the connection is opened, limiting exposure in a memory dump. |
| Windows auth | `Trusted_Connection` connections skip the keychain entirely — no secret is stored or fetched. |

**Why this matters:** the most common way a database tool leaks credentials is by
writing them into a config file or exposing them to a sprawling JS dependency tree.
DbArk does neither.

---

## Network behavior & telemetry

DbArk makes **no** outbound network connections other than:

1. The database hosts you configure (and SSH bastions you configure for tunneling).
2. An update check, **only** to fetch version metadata from the release endpoint —
   it carries no analytics and no identifying information. See *Updates* below.

There is no analytics, no phone-home, no account, no login. The opt-in crash
reporter (if enabled) sends a stack trace and OS version only — never query text,
connection details, or file paths — and says so in the dialog itself.

**Verify it yourself (≈60 seconds):**

```
1. Start Wireshark (or your OS firewall/Little Snitch) with a capture on your
   active interface.
2. Use DbArk normally for a few minutes — connect, run queries, browse schema.
3. Filter out your configured DB host(s). The remaining DbArk traffic should be
   empty (aside from a periodic update check, if enabled).
```

The published zero-telemetry Wireshark capture in this repository was produced this
way and can be reproduced by you against the same binary.

---

## Updates

DbArk ships the Tauri auto-updater. It periodically contacts the release endpoint to
ask whether a newer version exists and, if you approve, downloads and installs it.

- The check transmits version metadata only — no usage data, no identifiers.
- Update packages are signed; the updater verifies the signature before applying.
- If you prefer zero background network activity, the updater can be disabled in
  settings, and you can update manually from the GitHub Releases page.

> *Verify this against the shipped build before publishing — confirm exactly what
> the update check sends and whether it is on by default, and keep this section in
> sync with PRIVACY.md.*

---

## Data at rest

| Data | Location | Protection |
| --- | --- | --- |
| Connection configs | `~/.dbark/connections/*.toml` | Folder permissions locked to the current OS user. No secrets stored. |
| Query history & tab state | `~/.dbark/state.db` (local SQLite) | **Encrypted with SQLCipher**, key derived from the OS keychain. |
| Query history retention | `~/.dbark/state.db` | 90-day auto-purge. |
| Credentials in history | `~/.dbark/state.db` | Scrubbed — credentials are never written to query history in the first place. |
| Saved queries | `*.sql` + `*.meta.toml` sidecars | Plain text by design (Git-diffable); contain no credentials. |

**Why `state.db` is encrypted:** query history is sensitive — it records every
statement you have run, including against production. On a shared or multi-user
machine, a plaintext SQLite history file is a real exposure. SQLCipher closes that
gap, with the key bound to your OS keychain rather than embedded in the binary.

---

## Connection security

- **TLS/SSL modes:** `none`, `prefer`, `require`, `verify-full`. `verify-full`
  validates the certificate chain and hostname. We recommend `require` or
  `verify-full` for any non-local connection.
- **SSH tunneling:** connect to databases behind a bastion via SSH.NET, with
  key-based or password auth.
- **Read-only mode:** enforced at the driver level. When a connection is marked
  read-only, write statements are rejected before they reach the server — this is
  not a UI affordance that can be bypassed by typing a raw `UPDATE`.
- **Query timeout:** a default 30-second timeout on all drivers prevents a runaway
  query from hanging the client.
- **Connection grouping & color labels:** production connections can be visually
  separated and color-flagged to reduce the chance of running a statement against
  the wrong environment.

---

## Binary & supply-chain integrity

DbArk verifies its own native components before trusting them.

- **DLL integrity checking at startup.** Every native library is SHA-256-hashed and
  compared against a known-good hash compiled into the application **before the
  library is loaded**. If a hash does not match, the app refuses to start and shows
  a native error dialog naming the failed component — it does not silently load a
  tampered or substituted DLL.
- **Native path resolution.** Native libraries are resolved against the executable
  directory, not the current working directory, so a malicious DLL planted in a
  transient working directory cannot be loaded in their place.
- **Code-signed installers.** The Windows MSI is code-signed and the macOS `.dmg`
  is notarized, so first-run does not trip SmartScreen/Gatekeeper and the installer
  origin is attestable.
- **Open source, MIT.** The whole codebase — including the integrity-check logic
  itself — is readable. A closed binary asking you to trust its hash checks is
  marketing; an open one is a verifiable promise.
- **CI builds.** Continuous integration runs on GitHub Actions for Windows and
  macOS.

**Verify it yourself:** read the integrity-check routine in the Rust startup path,
then recompute the SHA-256 of any shipped native DLL and compare it to the hash in
the source.

---

## Application hardening

- **Tauri v2 capabilities lockdown.** The WebView is granted a minimal capability
  allowlist; filesystem and shell access are scoped, not blanket.
- **Content Security Policy.** A restrictive CSP is configured for the WebView to
  limit the blast radius of any frontend-side injection.
- **Session lock.** The app auto-locks after 15 minutes of inactivity, requiring
  re-authentication to resume.
- **Clipboard auto-clear.** Data copied from result grids is cleared from the
  clipboard after 60 seconds, limiting accidental paste of sensitive values.
- **Input validation.** TOML connection input is validated against injection before
  it is parsed and used.

---

## Audit logging

DbArk ships an **opt-in, local-only** audit log.

- Records **query metadata only** — never result data.
- Stays on your machine; it is not transmitted anywhere.
- Off by default; you choose whether to enable it.

---

## Quick verification checklist

Everything in this document is meant to be checkable. The fastest confidence-building
pass:

| Claim | How to verify | Time |
| --- | --- | --- |
| Zero telemetry | Wireshark capture during normal use | ~2 min |
| No passwords on disk | `grep -ri password ~/.dbark/connections/` returns nothing | ~10 s |
| Passwords in keychain only | Inspect your OS keychain for the DbArk entry | ~30 s |
| Binary integrity check | Read the startup hash-check; recompute a DLL's SHA-256 | ~5 min |
| Open source, MIT | Read `LICENSE` and the source | — |
| History encrypted | Try opening `~/.dbark/state.db` with a plain SQLite client — it won't open without the key | ~30 s |

---

*DbArk — Local-first. Git-native. Zero telemetry. Free forever.*
