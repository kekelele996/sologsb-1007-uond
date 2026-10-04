import { createSeedAuthorizationLedger, createSeedProject } from "./data";
import { AUTHORIZATION_LEDGER_KEY, backfillInterviewee } from "./domain/excerpts";
import type { AuthorizationRecord, PersistedEnvelope, ProjectData } from "./types";

export const STORAGE_KEY = "sologsb-1007-project-v1";
export const SESSION_KEY = "sologsb-1007-session";

/**
 * 升级迁移：旧稿（schema 1）片段未记受访人，升级时按访谈项目回填。
 * 返回迁移后的 project 与 schema 版本。
 */
function migrateProject(raw: unknown): { project: ProjectData; schema: number } {
  const envelope = raw as PersistedEnvelope;
  let project = envelope.project;
  let schema = envelope.schema ?? 1;
  if (schema < 2) {
    project = backfillInterviewee(project);
    schema = 2;
  }
  return { project, schema };
}

export function loadProject(): { project: ProjectData; revision: number; schema: number } {
  if (typeof localStorage === "undefined") {
    return { project: createSeedProject(), revision: 0, schema: 2 };
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as PersistedEnvelope;
    if (parsed?.project?.tracks?.length) {
      const { project, schema } = migrateProject(parsed);
      return { project, revision: parsed.revision ?? 0, schema };
    }
  } catch {
    // A malformed local draft falls back to the bundled sample.
  }
  return { project: createSeedProject(), revision: 0, schema: 2 };
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

/** 读取授权台账（征集科维护）。没有时返回空表。 */
export function loadAuthorizationLedger(): AuthorizationRecord[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(AUTHORIZATION_LEDGER_KEY) ?? "[]") as AuthorizationRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 写入授权台账。校对员不直接调用，只由征集科同步流程写入。 */
export function saveAuthorizationLedger(ledger: AuthorizationRecord[]) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(AUTHORIZATION_LEDGER_KEY, JSON.stringify(ledger));
}

/** 首次使用时播种授权台账；已有台账不动。 */
export function ensureAuthorizationLedger(): AuthorizationRecord[] {
  const existing = loadAuthorizationLedger();
  if (existing.length) return existing;
  const seeded = createSeedAuthorizationLedger();
  saveAuthorizationLedger(seeded);
  return seeded;
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
