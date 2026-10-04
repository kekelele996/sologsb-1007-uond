import { createSeedProject } from "./data";
import { migrateProject } from "./publication";
import type { PersistedEnvelope, ProjectData } from "./types";

export const STORAGE_KEY = "sologsb-1007-project-v2";
export const LEGACY_STORAGE_KEY = "sologsb-1007-project-v1";
export const SESSION_KEY = "sologsb-1007-session";

export function loadProject(): { project: ProjectData; revision: number; migrated: boolean } {
  if (typeof localStorage === "undefined") {
    return { project: createSeedProject(), revision: 0, migrated: false };
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as PersistedEnvelope;
    if (parsed?.project?.tracks?.length) {
      return {
        project: parsed.schema === 1 ? migrateProject(parsed.project) : parsed.project,
        revision: parsed.revision ?? 0,
        migrated: parsed.schema === 1,
      };
    }
  } catch {
    // A malformed local draft falls back to the bundled sample.
  }
  // 兼容首次升级：读取旧键的 schema 1 草稿，迁移后再由保存逻辑写入新键。
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? "") as PersistedEnvelope;
    if (legacy?.schema === 1 && legacy.project?.tracks?.length) {
      return { project: migrateProject(legacy.project), revision: legacy.revision ?? 0, migrated: true };
    }
  } catch {
    // Ignore malformed legacy draft.
  }
  return { project: createSeedProject(), revision: 0, migrated: false };
}

export function saveProject(project: ProjectData, revision: number, tabId: string) {
  const envelope: PersistedEnvelope = {
    schema: 2,
    revision,
    tabId,
    savedAt: Date.now(),
    project,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  return envelope;
}

export function readEnvelope(): PersistedEnvelope | null {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as PersistedEnvelope;
  } catch {
    return null;
  }
}

export function downloadText(filename: string, content: string, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function formatTime(seconds: number, withMillis = true) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  const head = [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
  return withMillis ? `${head}.${String(ms).padStart(3, "0")}` : head;
}

export function parseTime(value: string) {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(normalized) || 0;
}
