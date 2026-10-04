export type Confidence = 1 | 2 | 3 | 4 | 5;

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

export interface Speaker {
  id: string;
  name: string;
  role: string;
  color: string;
}

export interface Tag {
  id: string;
  label: string;
  type: "topic" | "event" | "person";
  color: string;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  speakerId: string;
  /**
   * 受访人标识。旧稿（schema 1）没有这个字段，升级时按访谈项目回填，
   * 见 persistence.ts 的 migrateProject。
   */
  intervieweeId?: string;
  text: string;
  confidence: Confidence;
  reviewed: boolean;
  flags: {
    lowConfidence: boolean;
    dialect: boolean;
    properNoun: boolean;
  };
  tagIds: string[];
  comments: ReviewComment[];
}

export interface TranscriptTrack {
  id: string;
  name: string;
  language: string;
  status: "待校对" | "校对中" | "已完成";
  segments: Segment[];
}

export interface ProjectData {
  id: string;
  title: string;
  interviewee: string;
  recordingDate: string;
  activeTrackId: string;
  speakers: Speaker[];
  tags: Tag[];
  tracks: TranscriptTrack[];
  updatedAt: string;
}

export interface PersistedEnvelope {
  schema: number;
  revision: number;
  tabId: string;
  savedAt: number;
  project: ProjectData;
}

/** 授权状态：有效 / 已收回 / 已封存。 */
export type AuthorizationState = "有效" | "已收回" | "已封存";

/**
 * 授权登记。由征集科维护，校对员只读、不能改。
 * 按 intervieweeId 与摘编段落对账。
 */
export interface AuthorizationRecord {
  intervieweeId: string;
  intervieweeName: string;
  state: AuthorizationState;
  /** 封存到期日（ISO 日期）；到期后授权视为无效。null 表示未设到期。 */
  sealedUntil: string | null;
  updatedAt: string;
  updatedBy: "征集科";
}

/** 公开摘编段落状态：已编入 / 待处理 / 已挂起。 */
export type ExcerptStatus = "已编入" | "待处理" | "已挂起";

/**
 * 公开摘编段落。只引用片段与受访人，不持有片段正文——
 * 片段正文、批注与整理稿仍归校对员维护，授权回退时只改状态，不动这些内容。
 */
export interface ExcerptParagraph {
  id: string;
  segmentId: string;
  trackId: string;
  intervieweeId: string;
  status: ExcerptStatus;
  compiledAt: string;
  /** 校对员整理稿，授权回退时保留。 */
  draft: string;
}

/** 征集科授权变更的同步状态。失败时只重试对应那一位受访人。 */
export interface AuthorizationSyncState {
  intervieweeId: string;
  status: "idle" | "pending" | "failed" | "succeeded";
  attempts: number;
  lastError?: string;
}
