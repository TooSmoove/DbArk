import { describe, it, expect } from "vitest";
import {
  settingsReducer,
  initSettingsState,
  type SettingsState,
} from "./settingsReducer";
import { DEFAULT_SETTINGS } from "../appState";
import type { AppSettings } from "../types";

function base(over: Partial<SettingsState> = {}): SettingsState {
  return { ...initSettingsState(), ...over };
}

const loaded: AppSettings = {
  ...DEFAULT_SETTINGS,
  queryTimeoutSecs: 99,
  auditLogEnabled: true,
};

describe("initSettingsState", () => {
  it("starts on defaults with the modal closed", () => {
    const s = initSettingsState();
    expect(s.settings).toBe(DEFAULT_SETTINGS);
    expect(s.draft).toBe(DEFAULT_SETTINGS);
    expect(s.showSettings).toBe(false);
    expect(s.auditLogEnabled).toBe(false);
  });
});

describe("LOAD_SETTINGS", () => {
  it("sets settings AND derives auditLogEnabled atomically", () => {
    const next = settingsReducer(base(), { type: "LOAD_SETTINGS", settings: loaded });
    expect(next.settings).toBe(loaded);
    expect(next.auditLogEnabled).toBe(true); // derived from loaded settings
  });
  it("does not touch the draft or modal visibility", () => {
    const s = base({ showSettings: true, draft: { ...DEFAULT_SETTINGS, resultRowLimit: 7 } });
    const next = settingsReducer(s, { type: "LOAD_SETTINGS", settings: loaded });
    expect(next.showSettings).toBe(true);
    expect(next.draft.resultRowLimit).toBe(7);
  });
});

describe("the draft/commit dance", () => {
  it("OPEN_SETTINGS snapshots settings → draft AND opens, atomically", () => {
    const s = base({ settings: loaded, draft: { ...DEFAULT_SETTINGS, resultRowLimit: 7 } });
    const next = settingsReducer(s, { type: "OPEN_SETTINGS" });
    expect(next.showSettings).toBe(true);
    expect(next.draft).toEqual(loaded);       // fresh snapshot
    expect(next.draft).not.toBe(next.settings); // a COPY — draft edits must not leak
  });
  it("UPDATE_DRAFT merges a patch without touching committed settings", () => {
    const s = base({ settings: loaded });
    const next = settingsReducer(s, { type: "UPDATE_DRAFT", patch: { queryTimeoutSecs: 5 } });
    expect(next.draft.queryTimeoutSecs).toBe(5);
    expect(next.settings.queryTimeoutSecs).toBe(99); // committed value untouched
  });
  it("COMMIT_DRAFT promotes draft → settings, syncs the audit flag, and closes — atomically", () => {
    const edited = { ...loaded, queryTimeoutSecs: 5, auditLogEnabled: false };
    const s = base({ settings: loaded, draft: edited, showSettings: true, auditLogEnabled: true });
    const next = settingsReducer(s, { type: "COMMIT_DRAFT" });
    expect(next.settings).toBe(edited);
    expect(next.auditLogEnabled).toBe(false); // synced from the draft
    expect(next.showSettings).toBe(false);
  });
  it("cancel (SET_SETTINGS_OPEN false) discards nothing — the dirty draft survives (parity)", () => {
    const dirty = { ...DEFAULT_SETTINGS, resultRowLimit: 7 };
    const s = base({ draft: dirty, showSettings: true });
    const next = settingsReducer(s, { type: "SET_SETTINGS_OPEN", open: false });
    expect(next.showSettings).toBe(false);
    expect(next.draft).toBe(dirty); // original cancel never reset the draft
  });
  it("RESET_DRAFT returns the draft to factory defaults", () => {
    const s = base({ draft: { ...DEFAULT_SETTINGS, queryTimeoutSecs: 5 } });
    expect(settingsReducer(s, { type: "RESET_DRAFT" }).draft).toBe(DEFAULT_SETTINGS);
  });
});

describe("runtime audit flag", () => {
  it("SET_AUDIT_LOG flips the flag without touching settings", () => {
    const s = base({ settings: loaded });
    const next = settingsReducer(s, { type: "SET_AUDIT_LOG", enabled: true });
    expect(next.auditLogEnabled).toBe(true);
    expect(next.settings).toBe(loaded);
  });
});
