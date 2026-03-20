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

    return (
        <div style={{ padding: 40, fontFamily: "monospace" }}>
            <h2>DbArk — IPC Test</h2>
            <button onClick={runTest} style={{ padding: "8px 16px", marginBottom: 16 }}>
                Test C# connection
            </button>
            <div>{result}</div>
        </div>
    );
}

export default App;