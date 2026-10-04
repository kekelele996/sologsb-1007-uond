// 公开摘编与授权对账领域逻辑
//
// 规则（与 REQUIREMENT 对应）：
// 1. 公开摘编只收有效授权内的片段；授权被收回或封存到期，已编入段落退回待处理，
//    但校对员的批注与整理稿照旧留着。
// 2. 两边按受访人对账：查不到授权登记的受访人先挂起；校对员只读，不能越权改授权登记。
// 3. 征集科改授权失败，只重试这一位受访人，其他人和校对稿不动。
// 4. 旧稿没记受访人，升级时按访谈项目回填。

import { uid } from "../data";
import type {
  AuthorizationRecord,
  AuthorizationState,
  AuthorizationSyncState,
  ExcerptParagraph,
  ExcerptStatus,
  ProjectData,
  Segment,
} from "../types";

export const AUTHORIZATION_LEDGER_KEY = "sologsb-1007-authorization-v1";

/** 授权是否有效：状态为有效，且未到封存到期日。 */
export function isAuthorizationValid(record: AuthorizationRecord | undefined, now = new Date()): boolean {
  if (!record) return false;
  if (record.state !== "有效") return false;
  if (record.sealedUntil && new Date(record.sealedUntil).getTime() <= now.getTime()) return false;
  return true;
}

/** 按受访人查授权登记。 */
export function findAuthorization(
  ledger: AuthorizationRecord[],
  intervieweeId: string,
): AuthorizationRecord | undefined {
  return ledger.find((record) => record.intervieweeId === intervieweeId);
}

/**
 * 对账：把摘编段落按受访人与授权登记核对。
 * - 查不到授权登记 → 挂起
 * - 授权无效（收回 / 封存到期）→ 退回待处理
 * - 授权有效 → 保持已编入
 *
 * 只改段落状态；段落上的整理稿（draft）与片段批注不在此触碰，保留原样。
 */
export function reconcileParagraphs(
  paragraphs: ExcerptParagraph[],
  ledger: AuthorizationRecord[],
  now = new Date(),
): { paragraphs: ExcerptParagraph[]; suspended: ExcerptParagraph[] } {
  const suspended: ExcerptParagraph[] = [];
  const next = paragraphs.map((paragraph) => {
    const record = findAuthorization(ledger, paragraph.intervieweeId);
    let status: ExcerptStatus;
    if (!record) {
      status = "已挂起";
    } else if (isAuthorizationValid(record, now)) {
      status = "已编入";
    } else {
      status = "待处理";
    }
    const updated: ExcerptParagraph = { ...paragraph, status };
    if (status === "已挂起") suspended.push(updated);
    return updated;
  });
  return { paragraphs: next, suspended };
}

/**
 * 编制公开摘编：只收有效授权内的片段。
 * 未回填受访人、查不到授权登记或授权无效的片段都不收。
 * 返回新编入的段落；已有段落上的批注 / 整理稿不受影响。
 */
export function compileExcerpts(
  entries: { segment: Segment; trackId: string }[],
  ledger: AuthorizationRecord[],
  now = new Date(),
): ExcerptParagraph[] {
  const compiled: ExcerptParagraph[] = [];
  for (const { segment, trackId } of entries) {
    const intervieweeId = segment.intervieweeId;
    if (!intervieweeId) continue;
    const record = findAuthorization(ledger, intervieweeId);
    if (!isAuthorizationValid(record, now)) continue;
    compiled.push({
      id: uid("excerpt"),
      segmentId: segment.id,
      trackId,
      intervieweeId,
      status: "已编入",
      compiledAt: now.toISOString(),
      draft: "",
    });
  }
  return compiled;
}

/** 征集科授权变更内容。 */
export interface AuthorizationChange {
  state: AuthorizationState;
  sealedUntil?: string | null;
}

/**
 * 征集科改授权。这是与外部征集科系统的同步操作，可能失败。
 * 失败时只登记这一位受访人的 sync 状态，不触碰其他受访人，也不动校对稿。
 */
export async function requestAuthorizationChange(
  intervieweeId: string,
  change: AuthorizationChange,
  apply: (change: AuthorizationChange & { intervieweeId: string }) => Promise<void>,
): Promise<AuthorizationSyncState> {
  const sync: AuthorizationSyncState = { intervieweeId, status: "pending", attempts: 0 };
  try {
    await apply({ intervieweeId, ...change });
    sync.status = "succeeded";
  } catch (error) {
    sync.status = "failed";
    sync.lastError = error instanceof Error ? error.message : String(error);
  }
  return sync;
}

/**
 * 只重试失败的那一位受访人。
 * 防御：重试必须精确命中同一位受访人，避免越权重试他人；
 * 其他受访人与校对稿不在此函数范围内，天然不动。
 */
export async function retryAuthorizationChange(
  intervieweeId: string,
  change: AuthorizationChange,
  apply: (change: AuthorizationChange & { intervieweeId: string }) => Promise<void>,
  previous: AuthorizationSyncState,
): Promise<AuthorizationSyncState> {
  if (previous.intervieweeId !== intervieweeId) return previous;
  const next: AuthorizationSyncState = {
    ...previous,
    status: "pending",
    attempts: previous.attempts + 1,
  };
  try {
    await apply({ intervieweeId, ...change });
    next.status = "succeeded";
    next.lastError = undefined;
  } catch (error) {
    next.status = "failed";
    next.lastError = error instanceof Error ? error.message : String(error);
  }
  return next;
}

/**
 * 升级迁移：旧稿片段未记受访人，按访谈项目回填。
 * 项目有 interviewee（姓名），映射为稳定的 intervieweeId；已记受访人的片段不动。
 */
export function backfillInterviewee(project: ProjectData): ProjectData {
  const fallbackId = project.interviewee
    ? `interviewee:${project.id}:${project.interviewee}`
    : `interviewee:${project.id}`;
  const next = structuredClone(project);
  for (const track of next.tracks) {
    for (const segment of track.segments) {
      if (!segment.intervieweeId) {
        segment.intervieweeId = fallbackId;
      }
    }
  }
  return next;
}

/** 生成受访人在授权台账中的稳定 id。 */
export const intervieweeIdFor = (project: ProjectData, name: string) =>
  `interviewee:${project.id}:${name}`;
