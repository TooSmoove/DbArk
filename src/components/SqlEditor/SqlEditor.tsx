// SqlEditor.tsx
//
// All Monaco-touching code lives here so that Monaco is code-split OUT of the
// main bundle. App.tsx lazy-loads this module via React.lazy, so the large
// Monaco JS only parses AFTER first paint instead of blocking initial render.
//
// IMPORTANT: the static `monaco` import, the worker setup, and loader.config
// MUST live in this lazy module — not in App.tsx. If any of them stay in
// App.tsx, Monaco gets pulled back into the main bundle and the code-split is
// defeated.

import Editor, { loader } from "@monaco-editor/react";
import type { OnMount, BeforeMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// Local worker (no CDN) — keeps the zero-external-calls guarantee intact.
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

// Use the locally-bundled Monaco instead of fetching from jsdelivr.
loader.config({ monaco });

export interface SqlEditorProps {
  beforeMount: BeforeMount;
  onMount: OnMount;
  theme: string;
  height?: string;
  defaultValue?: string;
}

export default function SqlEditor({
  beforeMount,
  onMount,
  theme,
  height = "100%",
  defaultValue = "-- Write your query here\nSELECT 1",
}: SqlEditorProps) {
  return (
    <Editor
      beforeMount={beforeMount}
      height={height}
      defaultLanguage="sql"
      theme={theme}
      defaultValue={defaultValue}
      onMount={onMount}
      options={{
        fontSize: 14,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbers: "on",
        renderLineHighlight: "line",
        fontFamily: "monospace",
        padding: { top: 12 },
        wordWrap: "on",
      }}
    />
  );
}
