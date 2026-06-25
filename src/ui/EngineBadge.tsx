// Extracted from App.tsx (code-audit item A-1).

// ---- Engine badge -----------------------------------------
export function EngineBadge({ engine }: { engine: string }) {
  const colors: Record<string, string> = {
    mysql:       "#f59e0b",
    mariadb:     "#c0392b",
    sqlserver:   "#3b82f6",
    postgres:    "#6c63ff",
    cockroachdb: "#6933ff",
    sqlite:      "#10b981",
  };
  const color = colors[engine.toLowerCase()] ?? "#6b7280";
  return (
    <span style={{
      fontSize: 9,
      fontWeight: 600,
      padding: "1px 6px",
      borderRadius: 20,
      background: color + "22",
      color,
      textTransform: "uppercase",
      letterSpacing: ".05em",
      fontFamily: "monospace",
      flexShrink: 0,
    }}>
      {engine}
    </span>
  );
}
