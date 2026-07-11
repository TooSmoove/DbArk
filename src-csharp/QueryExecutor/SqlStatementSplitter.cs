#nullable enable
using System.Collections.Generic;
using System.Text;

/// <summary>
/// Splits raw editor SQL into individual statements at top-level semicolons
/// (audit A-2 residual: extracted from QueryExecutor so the orchestrator holds
/// policy, not parsing). Quote-, comment-, dollar-quote- and BEGIN/END-aware so
/// a ';' inside a string literal, a comment, a Postgres function body, or a
/// procedural block never splits.
/// </summary>
internal static class SqlStatementSplitter
{
    internal static List<string> Split(string sql)
    {
        var statements = new List<string>();
        var current = new StringBuilder();
        int depth = 0;
        bool inString = false;
        bool inDollarQuote = false;
        bool inLineComment = false;
        bool inBlockComment = false;
        char stringChar = '\0';
        string dollarTag = "";   // e.g. "$$" or "$body$" or "$function$"
        int i = 0;

        while (i < sql.Length)
        {
            char c = sql[i];

            // ── Single-line comment ──────────────────────────────────────────
            // Handled before string/dollar-quote checks so apostrophes inside
            // comments (e.g. "don't") are never treated as SQL string delimiters
            // — which would swallow subsequent semicolons into one giant statement.
            if (inLineComment)
            {
                current.Append(c);
                if (c == '\n') inLineComment = false;
                i++;
                continue;
            }

            // ── Block comment ────────────────────────────────────────────────
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
                continue;
            }

            // Detect start of -- comment
            if (!inString && !inDollarQuote
                && c == '-' && i + 1 < sql.Length && sql[i + 1] == '-')
            {
                inLineComment = true;
                current.Append("--");
                i += 2;
                continue;
            }

            // Detect start of /* comment
            if (!inString && !inDollarQuote
                && c == '/' && i + 1 < sql.Length && sql[i + 1] == '*')
            {
                inBlockComment = true;
                current.Append("/*");
                i += 2;
                continue;
            }

            // ── Dollar-quoted strings: $$...$$ and $tag$...$tag$ ─────────────
            // Postgres supports both anonymous ($$) and named ($body$, $function$,
            // etc.) dollar-quoting. Semicolons inside either form must not split.
            if (!inString && !inDollarQuote && c == '$')
            {
                // Scan ahead to find the closing $ of the tag
                int tagEnd = i + 1;
                while (tagEnd < sql.Length && sql[tagEnd] != '$'
                    && (char.IsLetterOrDigit(sql[tagEnd]) || sql[tagEnd] == '_'))
                    tagEnd++;

                if (tagEnd < sql.Length && sql[tagEnd] == '$')
                {
                    dollarTag = sql.Substring(i, tagEnd - i + 1); // "$$" or "$body$" etc.
                    inDollarQuote = true;
                    current.Append(dollarTag);
                    i = tagEnd + 1;
                    continue;
                }
            }

            // Check for matching closing dollar-quote tag
            if (inDollarQuote && c == '$'
                && i + dollarTag.Length <= sql.Length
                && sql.Substring(i, dollarTag.Length) == dollarTag)
            {
                inDollarQuote = false;
                current.Append(dollarTag);
                i += dollarTag.Length;
                continue;
            }

            // Inside dollar-quote — append everything verbatim
            if (inDollarQuote)
            {
                current.Append(c);
                i++;
                continue;
            }

            // ── Regular string literals ──────────────────────────────────────
            if (inString)
            {
                current.Append(c);
                if (c == stringChar && (i == 0 || sql[i - 1] != '\\'))
                    inString = false;
                i++;
                continue;
            }

            if (c == '\'' || c == '"' || c == '`')
            {
                inString = true;
                stringChar = c;
                current.Append(c);
                i++;
                continue;
            }

            // ── BEGIN / END depth tracking ───────────────────────────────────
            if (i + 5 <= sql.Length
                && sql.Substring(i, 5).ToUpperInvariant() == "BEGIN"
                && (i == 0 || !char.IsLetterOrDigit(sql[i - 1]))
                && (i + 5 >= sql.Length || !char.IsLetterOrDigit(sql[i + 5])))
            {
                depth++;
                current.Append(sql.Substring(i, 5));
                i += 5;
                continue;
            }

            if (depth > 0 && i + 3 <= sql.Length
                && sql.Substring(i, 3).ToUpperInvariant() == "END"
                && (i == 0 || !char.IsLetterOrDigit(sql[i - 1]))
                && (i + 3 >= sql.Length || !char.IsLetterOrDigit(sql[i + 3])))
            {
                depth--;
                current.Append(sql.Substring(i, 3));
                i += 3;
                continue;
            }

            // ── Semicolon — split only at depth 0, outside all quoted contexts ─
            if (c == ';' && depth == 0)
            {
                var stmt = current.ToString().Trim();
                if (!string.IsNullOrWhiteSpace(stmt))
                    statements.Add(stmt);
                current.Clear();
                i++;
                continue;
            }

            current.Append(c);
            i++;
        }

        var last = current.ToString().Trim();
        if (!string.IsNullOrWhiteSpace(last))
            statements.Add(last);

        return statements;
    }
}
