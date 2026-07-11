#nullable enable
using System.Collections.Generic;
using System.Text;

/// <summary>
/// Splits T-SQL editor text into executable batches (audit A-2 residual:
/// extracted from QueryExecutor so the orchestrator holds policy, not parsing).
/// Batch boundaries are explicit GO separator lines and implicit batch-scoped
/// DDL starts (CREATE/ALTER [OR ALTER|OR REPLACE] PROCEDURE/PROC/FUNCTION/
/// VIEW/TRIGGER, which T-SQL requires to be first in their batch). Quote-,
/// comment- and dollar-quote-aware, in parity with
/// <see cref="SqlStatementSplitter"/>.
/// </summary>
internal static class SqlServerBatchSplitter
{
    private static readonly HashSet<string> BatchScopedDdlObjects = new(System.StringComparer.Ordinal) { "PROCEDURE", "PROC", "FUNCTION", "VIEW", "TRIGGER" };

    internal static List<string> Split(string sql)
    {
        var batches = new List<string>();
        var current = new StringBuilder();

        bool inString = false;
        bool inDollarQuote = false;
        bool inLineComment = false;
        bool inBlockComment = false;
        char stringChar = '\0';
        string dollarTag = "";
        int i = 0;

        bool atLineStart = true;   // for GO (must occupy its own line)
        bool atStmtStart = true;   // for implicit DDL (line start OR just after a ';')

        while (i < sql.Length)
        {
            char c = sql[i];

            // ── Single-line comment ─────────────────────────────────────────────
            if (inLineComment)
            {
                current.Append(c);
                if (c == '\n') { inLineComment = false; atLineStart = true; atStmtStart = true; }
                i++;
                continue;
            }

            // ── Block comment ───────────────────────────────────────────────────
            if (inBlockComment)
            {
                current.Append(c);
                if (c == '*' && i + 1 < sql.Length && sql[i + 1] == '/')
                {
                    current.Append('/');
                    i += 2;
                    inBlockComment = false;
                }
                else i++;
                atLineStart = false;
                atStmtStart = false;
                continue;
            }

            // Detect start of -- comment
            if (!inString && !inDollarQuote
                && c == '-' && i + 1 < sql.Length && sql[i + 1] == '-')
            {
                inLineComment = true;
                current.Append("--");
                i += 2;
                atLineStart = false;
                atStmtStart = false;
                continue;
            }

            // Detect start of /* comment
            if (!inString && !inDollarQuote
                && c == '/' && i + 1 < sql.Length && sql[i + 1] == '*')
            {
                inBlockComment = true;
                current.Append("/*");
                i += 2;
                atLineStart = false;
                atStmtStart = false;
                continue;
            }

            // ── Dollar-quoted strings (parity with the ; splitter) ───────────────
            if (!inString && !inDollarQuote && c == '$')
            {
                int tagEnd = i + 1;
                while (tagEnd < sql.Length && sql[tagEnd] != '$'
                    && (char.IsLetterOrDigit(sql[tagEnd]) || sql[tagEnd] == '_'))
                    tagEnd++;

                if (tagEnd < sql.Length && sql[tagEnd] == '$')
                {
                    dollarTag = sql.Substring(i, tagEnd - i + 1);
                    inDollarQuote = true;
                    current.Append(dollarTag);
                    i = tagEnd + 1;
                    atLineStart = false;
                    atStmtStart = false;
                    continue;
                }
            }

            if (inDollarQuote && c == '$'
                && i + dollarTag.Length <= sql.Length
                && sql.Substring(i, dollarTag.Length) == dollarTag)
            {
                inDollarQuote = false;
                current.Append(dollarTag);
                i += dollarTag.Length;
                atLineStart = false;
                atStmtStart = false;
                continue;
            }

            if (inDollarQuote)
            {
                current.Append(c);
                i++;
                atLineStart = false;
                atStmtStart = false;
                continue;
            }

            // ── Regular string literals ─────────────────────────────────────────
            if (inString)
            {
                current.Append(c);
                if (c == stringChar && (i == 0 || sql[i - 1] != '\\'))
                    inString = false;
                i++;
                atLineStart = false;
                atStmtStart = false;
                continue;
            }

            if (c == '\'' || c == '"' || c == '`')
            {
                inString = true;
                stringChar = c;
                current.Append(c);
                i++;
                atLineStart = false;
                atStmtStart = false;
                continue;
            }

            // ── Whitespace handling: leading whitespace keeps line/stmt-start ────
            if (c == '\n')
            {
                current.Append(c);
                atLineStart = true;
                atStmtStart = true;
                i++;
                continue;
            }
            if (c == '\r' || c == ' ' || c == '\t')
            {
                current.Append(c);
                // whitespace does NOT clear atLineStart/atStmtStart
                i++;
                continue;
            }

            // ── GO batch separator ───────────────────────────────────────────────
            if (atLineStart
                && (c == 'G' || c == 'g')
                && i + 1 < sql.Length && (sql[i + 1] == 'O' || sql[i + 1] == 'o')
                && (i + 2 >= sql.Length || !IsIdentChar(sql[i + 2])))
            {
                // Confirm the REST of the line is only whitespace or an optional
                // integer repeat count, then a newline / EOF / comment.
                int j = i + 2;
                while (j < sql.Length && (sql[j] == ' ' || sql[j] == '\t')) j++;
                while (j < sql.Length && char.IsDigit(sql[j])) j++;
                while (j < sql.Length && (sql[j] == ' ' || sql[j] == '\t')) j++;
                bool lineEnds =
                    j >= sql.Length
                    || sql[j] == '\n' || sql[j] == '\r'
                    || (sql[j] == '-' && j + 1 < sql.Length && sql[j + 1] == '-');

                if (lineEnds)
                {
                    var batch = current.ToString().Trim();
                    if (!string.IsNullOrWhiteSpace(batch))
                        batches.Add(batch);
                    current.Clear();

                    while (i < sql.Length && sql[i] != '\n') i++;
                    if (i < sql.Length) i++; // consume the newline
                    atLineStart = true;
                    atStmtStart = true;
                    continue;
                }
                // Not a real GO separator — fall through and treat as ordinary text.
            }

            // ── Implicit DDL batch boundary ──────────────────────────────────────
            // CREATE/ALTER [OR ALTER|OR REPLACE] PROCEDURE|PROC|FUNCTION|VIEW|TRIGGER
            if (atStmtStart
                && (c == 'C' || c == 'c' || c == 'A' || c == 'a')
                && StartsBatchScopedDdl(sql, i))
            {
                var prior = current.ToString().Trim();
                if (!string.IsNullOrEmpty(prior))
                {
                    batches.Add(prior);
                    current.Clear();
                    // Do NOT advance i: reprocess the keyword into the fresh batch.
                    // Next pass `current` is empty, so the prior-content guard below
                    // fails and the keyword is appended normally — no infinite loop.
                    continue;
                }
                // current empty → nothing to close; fall through and append normally.
            }

            // ── Ordinary character ──────────────────────────────────────────────
            current.Append(c);
            atLineStart = false;
            atStmtStart = (c == ';');   // a top-level ';' starts a new statement
            i++;
        }

        var lastBatch = current.ToString().Trim();
        if (!string.IsNullOrWhiteSpace(lastBatch))
            batches.Add(lastBatch);

        return batches;
    }

    // Reads a run of identifier chars from `i`, advances `i` past it, and returns
    // the UPPER-cased word (empty string if `i` is not on an identifier char).
    private static string ReadWord(string sql, ref int i)
    {
        int start = i;
        while (i < sql.Length && IsIdentChar(sql[i])) i++;
        return sql.Substring(start, i - start).ToUpperInvariant();
    }

    private static void SkipWs(string sql, ref int i)
    {
        while (i < sql.Length
            && (sql[i] == ' ' || sql[i] == '\t' || sql[i] == '\r' || sql[i] == '\n'))
            i++;
    }

    // True iff text at `start` (the first non-whitespace char of a statement) begins
    // a batch-scoped DDL: CREATE/ALTER [OR ALTER|OR REPLACE] of
    // PROCEDURE/PROC/FUNCTION/VIEW/TRIGGER. Word-boundary aware (so VIEWS, a column
    // named `procedure`, etc. do not match). Whitespace between tokens is skipped;
    // comments between tokens are not (rare — conservatively yields no split).
    private static bool StartsBatchScopedDdl(string sql, int start)
    {
        if (start >= sql.Length) return false;
        char c0 = sql[start];
        if (c0 != 'C' && c0 != 'c' && c0 != 'A' && c0 != 'a') return false;

        int i = start;
        string w1 = ReadWord(sql, ref i);
        if (w1 != "CREATE" && w1 != "ALTER") return false;

        SkipWs(sql, ref i);
        string w2 = ReadWord(sql, ref i);

        if (w2 == "OR")
        {
            SkipWs(sql, ref i);
            string w3 = ReadWord(sql, ref i);
            if (w3 != "ALTER" && w3 != "REPLACE") return false;
            SkipWs(sql, ref i);
            string obj = ReadWord(sql, ref i);
            return BatchScopedDdlObjects.Contains(obj);
        }

        return BatchScopedDdlObjects.Contains(w2);
    }

    private static bool IsIdentChar(char c) =>
        char.IsLetterOrDigit(c) || c == '_';
}
