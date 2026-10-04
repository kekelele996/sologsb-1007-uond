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
  /** 该片段对应的受访人；旧稿可能为空，升级时按访谈项目回填。 */
  intervieweeId?: string;
}

/** 受访人授权状态，由征集科登记，校对员只读。 */
export type AuthorizationStatus = "valid" | "revoked" | "sealed";

export interface Authorization {
  /** 与受访人一一对应。 */
  intervieweeId: string;
  status: AuthorizationStatus;
  /** 授权范围说明，例如“仅限学术公开摘编”。 */
  scope: string;
  grantedAt: string;
  /** 收回时间；status 为 revoked 时存在。 */
  revokedAt?: string;
  /** 封存到期时间（ISO 字符串）；到期即按封存处理。 */
  sealUntil?: string;
  /** 禁提词列表，公开摘编编选时命中的片段不得收入。 */
  bannedTerms: string[];
  updatedAt: string;
}

export interface Interviewee {
  id: string;
  name: string;
  /** 受访人所属访谈项目；旧稿回填与对账的依据。 */
  projectId: string;
}

export interface InterviewProjectRef {
  id: string;
  name: string;
  /** 该访谈项目对应的受访人（旧稿回填用）。 */
  intervieweeId: string;
}

/** 公开摘编中单个片段的发布状态。 */
export type ExcerptStatus = "published" | "pending";

export interface ExcerptEntry {
  /** track.id + segment.id 复合定位，便于按轨展示。 */
  segmentKey: string;
  trackId: string;
  segmentId: string;
  intervieweeId: string;
  status: ExcerptStatus;
  addedAt: string;
  /** 退回待处理时记录原因（授权收回 / 封存到期 / 禁提词命中）。 */
  returnedReason?: string;
  returnedAt?: string;
}

export interface PublicationDigest {
  id: string;
  title: string;
  entries: ExcerptEntry[];
  updatedAt: string;
}

/** 对账结果：按受访人核对授权登记与摘编/稿件。 */
export interface ReconcileItem {
  intervieweeId: string;
  name: string;
  known: boolean;
  authorization?: Authorization;
  segmentCount: number;
  publishedCount: number;
  pendingCount: number;
  /** 该受访人下命中禁提词的片段数。 */
  bannedHitCount: number;
}

export interface ReconcileReport {
  generatedAt: string;
  items: ReconcileItem[];
  hungCount: number;
}

/** 征集科逐条改授权的结果，失败只影响当前受访人。 */
export interface AuthorizationChangeResult {
  intervieweeId: string;
  ok: boolean;
  error?: string;
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
  /** 访谈项目台账，供旧稿按项目回填受访人。 */
  interviewProjects: InterviewProjectRef[];
  /** 受访人名册，由征集科维护。 */
  interviewees: Interviewee[];
  /** 受访人授权与禁提词登记，键为 intervieweeId。 */
  authorizations: Record<string, Authorization>;
  /** 公开摘编（编选结果）。 */
  digest: PublicationDigest;
  /** 最近一次按受访人对账的结果；查不到的人挂起。 */
  lastReconcile?: ReconcileReport | null;
  updatedAt: string;
}

export interface PersistedEnvelope {
  schema: 1 | 2;
  revision: number;
  tabId: string;
  savedAt: number;
  project: ProjectData;
}
