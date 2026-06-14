# DbArk Privacy Policy

**Last updated: June 14, 2026**

## What DbArk collects

Nothing. DbArk collects zero data about you or your usage.

## What stays on your machine

- Connection configurations (TOML files in `~/.dbark/connections/`)
- Passwords (OS keychain only — Windows Credential Manager / macOS Keychain /
  Linux Secret Service)
- Query history and window/tab state (local SQLite database at `~/.dbark/state.db`,
  encrypted with SQLCipher using a key derived from your OS keychain)
- Preferences and layout (in the same encrypted local database)

## What never leaves your machine

- Your database credentials
- Your query content
- Your query results
- Your connection metadata (host, database name, usernames)
- Any usage statistics or telemetry of any kind

## Network connections

DbArk makes only two categories of outbound network connection:

1. **To the database servers you explicitly configure** (and to any SSH bastion
   hosts you configure for tunneling). This is the database traffic you ask for.
2. **Update checks.** DbArk contacts the release endpoint to check whether a newer
   version is available. This request carries version metadata only — no analytics,
   no usage data, and no information that identifies you. Update packages are
   signed and the signature is verified before installation. If you prefer no
   background network activity at all, update checks can be disabled in settings,
   and you can update manually from the GitHub Releases page.

No connections are made to any analytics service, tracking service, or third party.

You can verify this yourself by running Wireshark while using DbArk. You will see
only connections to your configured database hosts (and, if enabled, a periodic
update check to the release endpoint). We publish a Wireshark capture in the
repository showing exactly this.

## Crash reports

If you opt in to crash reporting, a crash report containing only the exception
stack trace and your OS version is sent. No query content, no connection details,
no file paths, no personally identifiable information. Crash reporting is off by
default and requires explicit opt-in. The opt-in dialog states exactly what is sent.

## Verification

DbArk is a local-first desktop application. Every claim in this document is
verifiable by you with standard network monitoring tools and by reading the source
— the project is open source and MIT licensed. See [SECURITY.md](SECURITY.md) for
the full security architecture.
