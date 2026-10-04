import type {
  Authorization,
  AuthorizationChangeResult,
  AuthorizationStatus,
  ExcerptEntry,
  ProjectData,
  ReconcileItem,
  ReconcileReport,
  Segment,
} from "./types";

export const segmentKeyOf = (trackId: string, segmentId: string) => `${trackId}/${segmentId}`;

export const allSegments = (project: ProjectData) =>
  project.tracks.flatMap((track) => track.segments.map((segment) => ({ track, segment })));

/**
 * 判定某时刻授权是否有效。
 * - valid：有效；
 * - revoked：已收回，永久失效；
 * - sealed：封存，未到 sealUntil 前一律不可公开；到期自动解封为 valid。
 */
export function effectiveStatus(auth: Authorization | undefined, now: Date = new Date()): AuthorizationStatus | "none" {
  if (!auth) return "none";
  if (auth.status === "revoked") return "revoked";
  if (auth.status === "sealed") {
    if (auth.sealUntil && now.getTime() >= new Date(auth.sealUntil).getTime()) return "valid";
    return "sealed";
  }
  return "valid";
}

export function statusLabel(status: AuthorizationStatus | "none") {
  switch (status) {
    case "valid":
      return "有效";
    case "revoked":
      return "已收回";
    case "sealed":
      return "封存中";
    default:
      return "未登记";
  }
}

/** 片段正文是否命中该受访人的任一禁提词（空禁提词表不命中）。 */
export function hitsBannedTerms(text: string, auth: Authorization | undefined): string[] {
  if (!auth) return [];
  return auth.bannedTerms.map((term) => term.trim()).filter(Boolean).filter((term) => text.includes(term));
}

export interface SegmentEligibility {
  status: AuthorizationStatus | "none";
  banned: string[];
  /** 是否可收入公开摘编：授权有效且不命中禁提词。 */
  eligible: boolean;
  /** 不可收入或需退回时的人类可读原因。 */
  reason?: string;
}

export function evaluateSegment(
  project: ProjectData,
  intervieweeId: string | undefined,
  text: string,
  now: Date = new Date(),
): SegmentEligibility {
  if (!intervieweeId) {
    return { status: "none", banned: [], eligible: false, reason: "片段未登记受访人，先挂起待查" };
  }
  const known = project.interviewees.some((item) => item.id === intervieweeId);
  if (!known) {
    return { status: "none", banned: [], eligible: false, reason: "受访人名册查无此人，先挂起待查" };
  }
  const auth = project.authorizations[intervieweeId];
  const status = effectiveStatus(auth, now);
  const banned = hitsBannedTerms(text, auth);
  if (status === "revoked") return { status, banned, eligible: false, reason: "授权已收回" };
  if (status === "sealed") return { status, banned, eligible: false, reason: `封存至 ${auth?.sealUntil ?? "未定"}` };
  if (status === "none") return { status, banned: [], eligible: false, reason: "该受访人尚无授权登记" };
  if (banned.length) return { status, banned, eligible: false, reason: `命中禁提词：${banned.join("、")}` };
  return { status, banned: [], eligible: true };
}

const findEntry = (project: ProjectData, key: string) => project.digest.entries.find((entry) => entry.segmentKey === key);

/**
 * 校对/征集科把片段编入公开摘编。仅在“有效授权内”允许收入。
 * 已处于 published 的不重复添加；退回待处理(pending)的在重新满足条件时可重新收入。
 * 返回 null 表示因授权/禁提词被拒绝。
 */
export function admitToDigest(
  project: ProjectData,
  trackId: string,
  segment: Segment,
  now: Date = new Date(),
): ExcerptEntry | null {
  const key = segmentKeyOf(trackId, segment.id);
  const eligibility = evaluateSegment(project, segment.intervieweeId, segment.text, now);
  if (!eligibility.eligible) return null;

  const existing = findEntry(project, key);
  const ts = now.toISOString();
  if (existing) {
    existing.status = "published";
    existing.returnedReason = undefined;
    existing.returnedAt = undefined;
    return existing;
  }
  const entry: ExcerptEntry = {
    segmentKey: key,
    trackId,
    segmentId: segment.id,
    intervieweeId: segment.intervieweeId!,
    status: "published",
    addedAt: ts,
  };
  project.digest.entries.push(entry);
  project.digest.updatedAt = ts;
  return entry;
}

/** 摘编中定位片段正文；找不到（如被删除）返回 undefined。 */
export function resolveEntry(project: ProjectData, entry: ExcerptEntry): Segment | undefined {
  const track = project.tracks.find((item) => item.id === entry.trackId);
  return track?.segments.find((item) => item.id === entry.segmentId);
}

/**
 * 按授权与禁提词复核公开摘编：
 * 授权被收回、封存到期（即当前处于封存）或命中禁提词的已编入段落 -> 退回待处理。
 * 校对员的批注与整理稿（片段正文/批注本身）一律不动。
 * 返回本次退回的条目数。
 */
export function syncDigestWithAuthorization(project: ProjectData, now: Date = new Date()): { returned: ExcerptEntry[] } {
  const returned: ExcerptEntry[] = [];
  for (const entry of project.digest.entries) {
    if (entry.status !== "published") continue;
    const segment = resolveEntry(project, entry);
    // 稿件缺失时无法核对授权内容，按无法确认处理，退回待处理但不动任何稿件。
    const text = segment?.text ?? "";
    const eligibility = evaluateSegment(project, entry.intervieweeId, text, now);
    if (!eligibility.eligible) {
      entry.status = "pending";
      entry.returnedReason = eligibility.reason;
      entry.returnedAt = now.toISOString();
      returned.push(entry);
    }
  }
  if (returned.length) project.digest.updatedAt = now.toISOString();
  return { returned };
}

export function removeFromDigest(project: ProjectData, key: string) {
  const index = project.digest.entries.findIndex((entry) => entry.segmentKey === key);
  if (index >= 0) {
    project.digest.entries.splice(index, 1);
    project.digest.updatedAt = new Date().toISOString();
    return true;
  }
  return false;
}

/**
 * 按受访人对账。授权/稿件两侧都以受访人为键：
 * - 名册查不到的受访人先挂起（known=false），不阻断其他人；
 * - 汇总每位受访人的授权状态、片段数、已发布/待处理数、禁提词命中数。
 */
export function reconcileByInterviewee(project: ProjectData, now: Date = new Date()): ReconcileReport {
  const map = new Map<string, ReconcileItem>();
  const ensure = (intervieweeId: string): ReconcileItem => {
    let item = map.get(intervieweeId);
    if (!item) {
      const record = project.interviewees.find((entry) => entry.id === intervieweeId);
      item = {
        intervieweeId,
        name: record?.name ?? "（查无此人，挂起）",
        known: Boolean(record),
        authorization: project.authorizations[intervieweeId],
        segmentCount: 0,
        publishedCount: 0,
        pendingCount: 0,
        bannedHitCount: 0,
      };
      map.set(intervieweeId, item);
    }
    return item;
  };

  for (const { segment } of allSegments(project)) {
    const id = segment.intervieweeId ?? "";
    // 没有受访人的旧稿片段也进入对账，单独挂起为“未回填”。
    const item = ensure(id || "__unassigned__");
    item.segmentCount += 1;
    if (id && hitsBannedTerms(segment.text, project.authorizations[id]).length) item.bannedHitCount += 1;
  }

  for (const entry of project.digest.entries) {
    const item = ensure(entry.intervieweeId);
    if (entry.status === "published") item.publishedCount += 1;
    else item.pendingCount += 1;
  }

  // 只有授权登记、暂无片段的受访人也列出，便于征集科核对。
  for (const id of Object.keys(project.authorizations)) ensure(id);

  const items = [...map.values()].sort(
    (a, b) => Number(a.known) - Number(b.known) || a.name.localeCompare(b.name, "zh-Hans-CN"),
  );
  return { generatedAt: now.toISOString(), items, hungCount: items.filter((item) => !item.known).length };
}

/** 抛出的越权错误，便于 UI 捕获提示。 */
export class PermissionDeniedError extends Error {}

export type Role = "proofreader" | "collector";

/** 只有征集科可以登记/修改授权；校对员越权一律拒绝。 */
export function assertCanEditAuthorization(role: Role) {
  if (role !== "collector") {
    throw new PermissionDeniedError("校对员无权修改授权登记，授权由征集科维护");
  }
}

/**
 * 征集科修改单个受访人授权。
 * 关键点：失败只影响这位受访人——变更在克隆的授权对象上计算，
 * 抛错/返回失败时不写回 project，其他受访人与校对稿完全不动。
 * 调用方负责按结果决定是否仅就该受访人重试。
 */
export function changeAuthorization(
  project: ProjectData,
  role: Role,
  intervieweeId: string,
  patch: Partial<Omit<Authorization, "intervieweeId" | "updatedAt">>,
  options: { now?: Date; failRate?: number } = {},
): AuthorizationChangeResult {
  try {
    assertCanEditAuthorization(role);
    if (!project.interviewees.some((item) => item.id === intervieweeId)) {
      return { intervieweeId, ok: false, error: "受访人名册查无此人，登记已挂起" };
    }

    // 模拟征集科登记接口可能的瞬时失败：不触碰 project，交由调用方仅重试此人。
    if (options.failRate && Math.random() < options.failRate) {
      return { intervieweeId, ok: false, error: "登记接口暂时失败，请仅就该受访人重试" };
    }

    const now = options.now ?? new Date();
    const current: Authorization =
      project.authorizations[intervieweeId] ??
      ({
        intervieweeId,
        status: "valid",
        scope: "",
        grantedAt: now.toISOString(),
        bannedTerms: [],
        updatedAt: now.toISOString(),
      } as Authorization);

    const next: Authorization = {
      ...current,
      ...patch,
      bannedTerms: patch.bannedTerms ? [...new Set(patch.bannedTerms.map((term) => term.trim()).filter(Boolean))] : current.bannedTerms,
      intervieweeId,
      updatedAt: now.toISOString(),
    };

    // 收回时补记时间；封存到期/状态恢复为有效时清理对应字段。
    if (next.status === "revoked" && !next.revokedAt) next.revokedAt = now.toISOString();
    if (next.status === "valid") {
      next.revokedAt = undefined;
      // valid 不再受封存时间约束；sealUntil 保留为历史登记也无妨，这里清空以免歧义。
      next.sealUntil = undefined;
    }
    if (next.status === "sealed" && !next.sealUntil) {
      return { intervieweeId, ok: false, error: "封存必须填写到期时间" };
    }

    project.authorizations[intervieweeId] = next;
    project.updatedAt = now.toISOString();
    return { intervieweeId, ok: true };
  } catch (error) {
    return {
      intervieweeId,
      ok: false,
      error: error instanceof Error ? error.message : "授权登记失败",
    };
  }
}

/**
 * 旧稿升级：旧稿片段未记受访人，按访谈项目回填。
 * 回填依据：项目自身对应的访谈项目 id -> project.interviewProjects[].intervieweeId。
 * 只回填缺失项，已有受访人的片段不动。
 */
export function backfillInterviewees(project: ProjectData, interviewProjectId?: string): number {
  const projectId = interviewProjectId ?? deriveProjectId(project);
  const ref = project.interviewProjects.find((item) => item.id === projectId);
  if (!ref) return 0;
  let count = 0;
  for (const { segment } of allSegments(project)) {
    if (!segment.intervieweeId) {
      segment.intervieweeId = ref.intervieweeId;
      count += 1;
    }
  }
  return count;
}

/** 由项目 id 推断其访谈项目；示例工程 id 以 oral-history-1007 开头时归码头项目。 */
function deriveProjectId(project: ProjectData): string {
  if (project.interviewProjects.length === 1) return project.interviewProjects[0].id;
  if (project.id.includes("1007")) return "proj-matou";
  return project.interviewProjects[0]?.id ?? "";
}

/**
 * 把旧版（schema 1）本地草稿升级为当前结构。
 * - 补齐新字段；
 * - 旧稿没记受访人的片段，按访谈项目回填。
 */
export function migrateProject(raw: Partial<ProjectData>): ProjectData {
  const base = raw as ProjectData;
  const project: ProjectData = {
    ...base,
    speakers: base.speakers ?? [],
    tags: base.tags ?? [],
    tracks: base.tracks ?? [],
    interviewProjects: base.interviewProjects ?? [],
    interviewees: base.interviewees ?? [],
    authorizations: base.authorizations ?? {},
    digest:
      base.digest ??
      ({
        id: "digest-migrated",
        title: `${base.title ?? "口述史"}·公开摘编`,
        entries: [],
        updatedAt: new Date().toISOString(),
      } as ProjectData["digest"]),
    lastReconcile: base.lastReconcile ?? null,
  };

  // 旧稿：没有受访人名册/项目台账时无法自动归属，保持挂起；
  // 有台账则按访谈项目回填。
  if (project.interviewProjects.length && project.interviewees.length) {
    backfillInterviewees(project);
  }
  return project;
}
