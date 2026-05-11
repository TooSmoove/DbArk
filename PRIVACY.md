# DevSql Privacy Policy

**Last updated: 4/30/2026**

## What DevSql collects

Nothing. DevSql collects zero data about you or your usage.

## What stays on your machine

- Connection configurations (TOML files in ~/.DevSql/connections/)
- Passwords (OS keychain only — Windows Credential Manager / macOS Keychain)
- Query history (local SQLite database in ~/.DevSql/state.db)
- Window layout and preferences (local SQLite database)

## What never leaves your machine

- Your database credentials
- Your query content
- Your query results
- Your connection metadata (host, database name, usernames)
- Any usage statistics or telemetry of any kind

## Network connections

DevSql makes exactly one category of network connection:
to the database servers you explicitly configure.
No connections are made to DevSql servers, analytics services,
update servers (until you explicitly check for updates),
or any third party.

You can verify this yourself by running Wireshark while using DevSql.
You will see only connections to your configured database hosts.
We publish a Wireshark capture on our website showing exactly this.

## Crash reports

If you opt in to crash reporting, a crash report containing only the
exception stack trace and your OS version is sent. No query content,
no connection details, no file paths, no personally identifiable information.
Crash reporting is off by default and requires explicit opt-in.

## Verification

DevSql is a local-first desktop application. Every claim in this document
is verifiable by you with standard network monitoring tools.