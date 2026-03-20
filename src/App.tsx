import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

function App() {
    const [result, setResult] = useState<string>("Not tested yet");

    async function runTest() {
        try {
            const ok = await invoke<boolean>("test_connection", {
                connectionString: "Server=localhost;Database=test;Trusted_Connection=true;"
            });
            setResult(ok ? "✅ C# loaded and responded correctly" : "❌ C# returned false");
        } catch (e) {
            setResult("❌ Error: " + String(e));
        }
    }

    async function testToml() {
        if (!window.__TAURI__) {
            setResult("⚠️ Open the desktop app to test");
            return;
        }
        try {
            const result = await invoke<string>("load_connection", {
                path: "natives/connections/local-sqlserver.toml"
            });
            setResult(result);
        } catch (e) {
            setResult("❌ Error: " + String(e));
        }
    }

    return (
        <div style={{ padding: 40, fontFamily: "monospace" }}>
            <h2>DevSQL — IPC Test</h2>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                <button onClick={runTest} style={{ padding: "8px 16px", marginBottom: 16 }}>
                    Test C# connection
                </button>
                <button onClick={testToml} style={{ padding: "8px 16px" }}>
                    Test TOML parser
                </button>
            </div>
            <div>{result}</div>
        </div>
    );
}

export default App;