import { Checkbox } from "@kobalte/core/checkbox";
import { Dialog } from "@kobalte/core/dialog";
import { Tabs } from "@kobalte/core/tabs";
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { createSeedProject, uid } from "../data";
import { LEGACY_STORAGE_KEY, STORAGE_KEY, downloadText, formatTime, loadProject, parseTime, saveProject } from "../persistence";
import {
  PermissionDeniedError,
  type Role,
  admitToDigest,
  assertCanEditAuthorization,
  backfillInterviewees,
  changeAuthorization,
  evaluateSegment,
  reconcileByInterviewee,
  removeFromDigest,
  resolveEntry,
  segmentKeyOf,
  statusLabel,
  syncDigestWithAuthorization,
} from "../publication";
import type {
  Authorization,
  AuthorizationChangeResult,
  AuthorizationStatus,
  Confidence,
  PersistedEnvelope,
  ProjectData,
  ReconcileReport,
  Segment,
  TranscriptTrack,
} from "../types";

const CHANNEL_NAME = "sologsb-1007-editor";
const TAB_ID = uid("tab");

function statusText(status: "saved" | "saving" | "offline") {
  if (status === "saving") return "正在保存";
  if (status === "offline") return "离线草稿";
  return "已自动保存";
}

interface AuthPanelProps {
  role: Role;
  project: ProjectData;
  currentIntervieweeId?: string;
  results: AuthorizationChangeResult[];
  onDeny: () => void;
  onChange: (
    intervieweeId: string,
    patch: Partial<Omit<Authorization, "intervieweeId" | "updatedAt">>,
    simulateFailure?: boolean,
  ) => void;
}

function AuthorizationPanel(props: AuthPanelProps) {
  const currentId = () => props.currentIntervieweeId ?? props.project.interviewees[0]?.id ?? "";
  const [selected, setSelected] = createSignal<string>("");
  const [bannedDraft, setBannedDraft] = createSignal("");
  const activeId = () => selected() || currentId();
  const active = () => props.project.interviewees.find((item) => item.id === activeId());
  const auth = (): Authorization | undefined => props.project.authorizations[activeId()];
  const readonly = () => props.role !== "collector";

  // 封存到期后自动按有效展示。
  const displayStatus = (): AuthorizationStatus | "none" => {
    const current = auth();
    if (!current) return "none";
    if (current.status === "sealed" && current.sealUntil && Date.now() >= new Date(current.sealUntil).getTime()) return "valid";
    return current.status;
  };

  // 切换受访人时，把禁提词草稿同步为登记值。
  createEffect(() => {
    setBannedDraft((auth()?.bannedTerms ?? []).join("、"));
  });

  const updateStatus = (status: AuthorizationStatus) => {
    if (readonly()) return props.onDeny();
    let sealUntil: string | undefined;
    if (status === "sealed") {
      const until = window.prompt("封存到期时间（YYYY-MM-DD）", new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10));
      if (!until) return;
      sealUntil = new Date(`${until}T23:59:59`).toISOString();
    }
    props.onChange(activeId(), status === "sealed" ? { status, sealUntil } : { status });
  };

  const saveBanned = () => {
    if (readonly()) return props.onDeny();
    const terms = bannedDraft().split(/[、,，\n]/).map((term) => term.trim()).filter(Boolean);
    props.onChange(activeId(), { bannedTerms: terms });
  };

  return (
    <div>
      <div class="content-title">
        <h3>授权与禁提词登记</h3>
        <p>由征集科维护；{readonly() ? "当前为校对员身份，此处只读，不能越权改动授权。" : "当前为征集科身份，可登记授权状态与禁提词。"}</p>
      </div>

      <label class="field-label" for="auth-interviewee">受访人</label>
      <select id="auth-interviewee" value={activeId()} onChange={(event) => setSelected(event.currentTarget.value)} disabled={false}>
        <For each={props.project.interviewees}>{(person) => <option value={person.id}>{person.name}（{person.projectId}）</option>}</For>
      </select>

      <Show when={active()} fallback={<div class="mini-empty">名册中查无此人，先在对账中挂起待查。</div>}>
        {(person) => (
          <div class="auth-detail">
            <div class={`auth-banner auth-${displayStatus()}`}>
              <strong>{person().name}</strong>
              <span>登记状态：{statusLabel(displayStatus())}</span>
              <Show when={auth()?.sealUntil}><small>封存至 {auth()?.sealUntil ? new Date(auth()!.sealUntil!).toLocaleDateString() : ""}</small></Show>
              <Show when={auth()?.revokedAt}><small>收回于 {auth()?.revokedAt ? new Date(auth()!.revokedAt!).toLocaleDateString() : ""}</small></Show>
            </div>

            <div class="field-label">授权状态操作</div>
            <div class="auth-actions">
              <button class="btn btn-quiet" disabled={auth()?.status === "valid"} onClick={() => updateStatus("valid")}>设为有效</button>
              <button class="btn btn-quiet warn" disabled={auth()?.status === "sealed"} onClick={() => updateStatus("sealed")}>封存（设到期）</button>
              <button class="btn btn-danger" disabled={auth()?.status === "revoked"} onClick={() => updateStatus("revoked")}>收回授权</button>
            </div>

            <label class="field-label" for="banned-terms">禁提词（顿号/逗号分隔）</label>
            <textarea
              id="banned-terms"
              rows="3"
              value={bannedDraft()}
              readOnly={readonly()}
              onInput={(event) => setBannedDraft(event.currentTarget.value)}
              placeholder="例如：德国座钟、家庭住址"
            />
            <button class="btn btn-primary wide" disabled={readonly()} onClick={saveBanned}>
              {readonly() ? "仅征集科可登记" : "保存禁提词"}
            </button>

            <Show when={!readonly()}>
              <button class="btn btn-quiet wide simulate" onClick={() => props.onChange(activeId(), { bannedTerms: (auth()?.bannedTerms ?? []) }, true)}>
                模拟一次登记失败（仅重试本人）
              </button>
            </Show>
          </div>
        )}
      </Show>

      <Show when={props.results.length}>
        <div class="auth-log">
          <div class="field-label">登记结果（失败仅影响对应受访人）</div>
          <For each={props.results}>
            {(result) => (
              <div class={`auth-log-row ${result.ok ? "ok" : "fail"}`}>
                <b>{result.ok ? "✓ 成功" : "✗ 失败"}</b>
                <span>{result.intervieweeId}{result.error ? `：${result.error}` : ""}</span>
                <Show when={!result.ok}>
                  <button class="linklike" onClick={() => props.onChange(result.intervieweeId, {})}>仅重试这位</button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function parseTimedTranscript(input: string, trackName: string): TranscriptTrack {
  const blocks = input.trim().split(/\n\s*\n/);
  const segments: Segment[] = [];
  const srtPattern = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
  const bracketPattern = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*(.*)$/;

  for (const rawBlock of blocks) {
    const lines = rawBlock.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const srtIndex = lines.findIndex((line) => srtPattern.test(line));
    if (srtIndex >= 0) {
      const match = srtPattern.exec(lines[srtIndex]);
      const text = lines.slice(srtIndex + 1).join(" ");
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push({
        id: uid("seg"),
        start: parseTime(match?.[1] ?? "0"),
        end: parseTime(match?.[2] ?? "1"),
        speakerId: speakerName ? "sp-custom" : "sp-interviewer",
        text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
      });
      continue;
    }
    for (const line of lines) {
      const match = bracketPattern.exec(line);
      if (!match) continue;
      const start = parseTime(match[1]);
      const text = match[2];
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push({
        id: uid("seg"),
        start,
        end: start + Math.max(3, text.length / 5),
        speakerId: speakerName ? "sp-custom" : "sp-interviewer",
        text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
      });
    }
  }

  if (!segments.length && input.trim()) {
    input.split("\n").map((line) => line.trim()).filter(Boolean).forEach((text, index) => {
      segments.push({
        id: uid("seg"),
        start: index * 6,
        end: index * 6 + 5.4,
        speakerId: "sp-interviewer",
        text,
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
      });
    });
  }

  return {
    id: uid("track"),
    name: trackName || "导入轨",
    language: "待识别",
    status: "待校对",
    segments,
  };
}

export default function OralHistoryEditor() {
  const loaded = loadProject();
  const [project, setProject] = createSignal<ProjectData>(loaded.project);
  const [revision, setRevision] = createSignal(loaded.revision);
  const [past, setPast] = createSignal<ProjectData[]>([]);
  const [future, setFuture] = createSignal<ProjectData[]>([]);
  const [selectedId, setSelectedId] = createSignal(loaded.project.tracks[0]?.segments[0]?.id ?? "");
  const [saveStatus, setSaveStatus] = createSignal<"saved" | "saving" | "offline">("saved");
  const [lastAction, setLastAction] = createSignal(
    loaded.migrated ? "旧稿已升级：按访谈项目回填受访人，请核对挂起项" : "示例项目已就绪",
  );
  const [conflict, setConflict] = createSignal<PersistedEnvelope | null>(null);
  const [online, setOnline] = createSignal(true);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [commentDraft, setCommentDraft] = createSignal("");
  const [replyDrafts, setReplyDrafts] = createSignal<Record<string, string>>({});
  const [trackFilter, setTrackFilter] = createSignal<"all" | "unreviewed" | "low">("all");
  // 当前工作台身份：校对员维护正文/批注/整理稿，征集科登记授权与禁提词。
  const [role, setRole] = createSignal<Role>("proofreader");
  const [reconcileOpen, setReconcileOpen] = createSignal(false);
  const [reconcileReport, setReconcileReport] = createSignal<ReconcileReport | null>(loaded.project.lastReconcile ?? null);
  const [authResults, setAuthResults] = createSignal<AuthorizationChangeResult[]>([]);
  const [notice, setNotice] = createSignal<{ kind: "ok" | "warn" | "deny"; text: string } | null>(null);
  let editorRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let saveTimer: number | undefined;
  let noticeTimer: number | undefined;
  let hydrated = false;
  let dirty = false;

  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;

  const flashNotice = (kind: "ok" | "warn" | "deny", text: string) => {
    setNotice({ kind, text });
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => setNotice(null), 4200);
  };
  const activeTrack = createMemo(() => {
    const data = project();
    return data.tracks.find((track) => track.id === data.activeTrackId) ?? data.tracks[0];
  });
  const activeSegment = createMemo(() => activeTrack()?.segments.find((item) => item.id === selectedId()) ?? null);
  const visibleSegments = createMemo(() => {
    const segments = activeTrack()?.segments ?? [];
    if (trackFilter() === "unreviewed") return segments.filter((segment) => !segment.reviewed);
    if (trackFilter() === "low") return segments.filter((segment) => segment.confidence <= 2 || segment.flags.lowConfidence);
    return segments;
  });
  const completedPercent = createMemo(() => {
    const segments = project().tracks.flatMap((track) => track.segments);
    if (!segments.length) return 0;
    return Math.round((segments.filter((segment) => segment.reviewed).length / segments.length) * 100);
  });
  const speakerById = (speakerId: string) =>
    project().speakers.find((speaker) => speaker.id === speakerId) ?? project().speakers[0];
  const tagById = (tagId: string) => project().tags.find((tag) => tag.id === tagId);
  const intervieweeById = (id?: string) => project().interviewees.find((item) => item.id === id);
  const authOf = (id?: string): Authorization | undefined => (id ? project().authorizations[id] : undefined);
  const authStatusOf = (id?: string): AuthorizationStatus | "none" => {
    const auth = authOf(id);
    if (!auth) return "none";
    if (auth.status === "revoked") return "revoked";
    if (auth.status === "sealed" && (!auth.sealUntil || Date.now() < new Date(auth.sealUntil).getTime())) return "sealed";
    return "valid";
  };

  const activeEligibility = createMemo(() => {
    const segment = activeSegment();
    if (!segment) return null;
    return evaluateSegment(project(), segment.intervieweeId, segment.text);
  });

  const entryFor = (trackId: string, segmentId: string) =>
    project().digest.entries.find((entry) => entry.segmentKey === segmentKeyOf(trackId, segmentId));
  const bannedTermsOf = (segment: Segment): string[] =>
    evaluateSegment(project(), segment.intervieweeId, segment.text).banned;

  /** 公开摘编中实际对外的段落（有效授权内）；待处理段落单独统计。 */
  const publishedEntries = createMemo(() => project().digest.entries.filter((entry) => entry.status === "published"));
  const pendingEntries = createMemo(() => project().digest.entries.filter((entry) => entry.status === "pending"));

  const entryText = (entryId: string) => {
    const entry = project().digest.entries.find((item) => item.segmentKey === entryId);
    if (!entry) return null;
    const segment = resolveEntry(project(), entry);
    return segment ? { entry, segment } : null;
  };

  const commit = (
    label: string,
    mutate: (draft: ProjectData) => void,
    options: { silent?: boolean } = {},
  ): boolean => {
    const current = structuredClone(project());
    const next = structuredClone(current);
    try {
      mutate(next);
    } catch (error) {
      // 变更函数抛错（如授权登记失败）时不写状态、不入撤销历史。
      if (!options.silent) console.warn(error);
      return false;
    }
    next.updatedAt = new Date().toISOString();
    batch(() => {
      setPast((items) => [...items.slice(-49), current]);
      setFuture([]);
      setProject(next);
      setRevision((value) => value + 1);
      setLastAction(label);
    });
    dirty = true;
    return true;
  };

  const commitSegment = (label: string, mutate: (segment: Segment, draft: ProjectData) => void) => {
    const id = selectedId();
    commit(label, (draft) => {
      const track = draft.tracks.find((item) => item.id === draft.activeTrackId);
      const segment = track?.segments.find((item) => item.id === id);
      if (segment) mutate(segment, draft);
    });
  };

  const undo = () => {
    const stack = past();
    if (!stack.length) return;
    const previous = stack[stack.length - 1];
    setFuture((items) => [structuredClone(project()), ...items].slice(0, 50));
    setPast(stack.slice(0, -1));
    setProject(previous);
    setRevision((value) => value + 1);
    setLastAction("已撤销上一步");
    dirty = true;
  };

  const redo = () => {
    const stack = future();
    if (!stack.length) return;
    const next = stack[0];
    setPast((items) => [...items.slice(-49), structuredClone(project())]);
    setFuture(stack.slice(1));
    setProject(next);
    setRevision((value) => value + 1);
    setLastAction("已重做");
    dirty = true;
  };

  const switchTrack = (trackId: string) => {
    commit("切换文本轨", (draft) => {
      draft.activeTrackId = trackId;
      selectedIdSet(draft.tracks.find((track) => track.id === trackId)?.segments[0]?.id ?? "");
    });
  };

  const selectedIdSet = (id: string) => setSelectedId(id);

  const moveSelection = (direction: 1 | -1) => {
    const segments = activeTrack()?.segments ?? [];
    if (!segments.length) return;
    const index = Math.max(0, segments.findIndex((segment) => segment.id === selectedId()));
    const nextIndex = (index + direction + segments.length) % segments.length;
    setSelectedId(segments[nextIndex].id);
    document.getElementById(`segment-${segments[nextIndex].id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const splitSelection = () => {
    const segment = activeSegment();
    if (!segment || segment.text.trim().length < 2) return;
    const cursor = editorRef?.selectionStart ?? Math.floor(segment.text.length / 2);
    const safeCursor = Math.max(1, Math.min(cursor, segment.text.length - 1));
    const firstText = segment.text.slice(0, safeCursor).trim();
    const secondText = segment.text.slice(safeCursor).trim();
    if (!firstText || !secondText) return;
    const ratio = firstText.length / segment.text.length;
    const boundary = segment.start + (segment.end - segment.start) * ratio;
    const secondId = uid("seg");
    commitSegment("拆分片段", (current, draft) => {
      const original = structuredClone(current);
      current.text = firstText;
      current.end = Number(boundary.toFixed(1));
      const trackIndex = draft.tracks.findIndex((track) => track.id === draft.activeTrackId);
      if (trackIndex >= 0) {
        const segmentIndex = draft.tracks[trackIndex].segments.findIndex((item) => item.id === current.id);
        draft.tracks[trackIndex].segments.splice(segmentIndex + 1, 0, {
          ...original,
          id: secondId,
          start: Number(boundary.toFixed(1)),
          text: secondText,
          reviewed: false,
          comments: [],
        });
      }
      setSelectedId(secondId);
    });
  };

  const mergeWithNext = () => {
    const track = activeTrack();
    const segment = activeSegment();
    if (!track || !segment) return;
    const index = track.segments.findIndex((item) => item.id === segment.id);
    const next = track.segments[index + 1];
    if (!next) return;
    commitSegment("合并下一片段", (current, draft) => {
      current.text = `${current.text.trim()} ${next.text.trim()}`;
      current.end = next.end;
      current.tagIds = [...new Set([...current.tagIds, ...next.tagIds])];
      current.comments.push(...next.comments);
      current.confidence = Math.min(current.confidence, next.confidence) as Confidence;
      const sourceTrack = draft.tracks.find((item) => item.id === draft.activeTrackId);
      sourceTrack?.segments.splice(index + 1, 1);
      current.reviewed = false;
    });
  };

  const toggleFlag = (flag: keyof Segment["flags"]) => {
    commitSegment("修改校对标记", (segment) => {
      segment.flags[flag] = !segment.flags[flag];
      segment.reviewed = false;
    });
  };

  const setConfidence = (confidence: Confidence) => {
    commitSegment("校正置信度", (segment) => {
      segment.confidence = confidence;
      segment.flags.lowConfidence = confidence <= 2;
      segment.reviewed = false;
    });
  };

  const addComment = () => {
    const body = commentDraft().trim();
    if (!body) return;
    commitSegment("添加批注", (segment) => {
      segment.comments.unshift({
        id: uid("comment"),
        author: "当前校对员",
        body,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      });
      segment.reviewed = false;
    });
    setCommentDraft("");
  };

  const addReply = (commentId: string) => {
    const body = (replyDrafts()[commentId] ?? "").trim();
    if (!body) return;
    commitSegment("回复批注", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      comment?.replies.push({
        id: uid("reply"),
        author: "当前校对员",
        body,
        createdAt: new Date().toISOString(),
      });
    });
    setReplyDrafts((drafts) => ({ ...drafts, [commentId]: "" }));
  };

  const toggleComment = (commentId: string) => {
    commitSegment("更新批注状态", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      if (comment) comment.resolved = !comment.resolved;
    });
  };

  const toggleTag = (tagId: string) => {
    commitSegment("更新主题关联", (segment) => {
      segment.tagIds = segment.tagIds.includes(tagId)
        ? segment.tagIds.filter((id) => id !== tagId)
        : [...segment.tagIds, tagId];
      segment.reviewed = false;
    });
  };

  const exportSrt = () => {
    const lines = activeTrack().segments.map((segment, index) => {
      const speaker = speakerById(segment.speakerId)?.name ?? "未知";
      return `${index + 1}\n${formatTime(segment.start)} --> ${formatTime(segment.end)}\n${speaker}：${segment.text}\n`;
    });
    downloadText(`${project().title}-${activeTrack().name}.srt`, lines.join("\n"), "application/x-subrip;charset=utf-8");
  };

  /** 把当前片段编入公开摘编；只收有效授权内片段。校对员/征集科均可发起编选，但授权门槛相同。 */
  const admitCurrent = () => {
    const track = activeTrack();
    const segment = activeSegment();
    if (!track || !segment) return;
    const eligibility = evaluateSegment(project(), segment.intervieweeId, segment.text);
    if (!eligibility.eligible) {
      flashNotice("deny", eligibility.reason ?? "不在有效授权范围内，不能收入摘编");
      return;
    }
    commit("编入公开摘编", (draft) => {
      admitToDigest(draft, track.id, segment);
    });
    flashNotice("ok", "已收入公开摘编");
  };

  const removeEntry = (segmentKey: string) => {
    commit("撤出公开摘编片段", (draft) => removeFromDigest(draft, segmentKey));
  };

  /**
   * 复核授权：授权收回或封存到期等情况下，把已编入段落退回待处理；
   * 批注与整理稿保持不变。
   */
  const syncAuthorization = () => {
    let returned = 0;
    commit("按授权复核摘编", (draft) => {
      returned = syncDigestWithAuthorization(draft).returned.length;
    });
    const report = reconcileByInterviewee(project());
    setReconcileReport(report);
    commit("记录对账结果", (draft) => {
      draft.lastReconcile = report;
    });
    flashNotice(
      returned ? "warn" : "ok",
      returned ? `${returned} 个已编入段落因授权变化退回待处理，批注和整理稿保留` : "授权复核通过，无需退回段落",
    );
  };

  /** 按受访人对账；查不到的人先挂起。 */
  const runReconcile = () => {
    const report = reconcileByInterviewee(project());
    setReconcileReport(report);
    commit("按受访人对账", (draft) => {
      draft.lastReconcile = report;
    });
    setReconcileOpen(true);
    flashNotice(report.hungCount ? "warn" : "ok", report.hungCount ? `有 ${report.hungCount} 位受访人查无登记，已挂起` : "对账完成，无挂起项");
  };

  /**
   * 征集科修改单个受访人授权，失败只重试这一位，其他人和校对稿不动。
   * changeAuthorization 在失败时不写回 draft，因此即便重试也不会污染他人。
   */
  const submitAuthorizationChange = (
    intervieweeId: string,
    patch: Partial<Omit<Authorization, "intervieweeId" | "updatedAt">>,
    simulateFailure = false,
  ) => {
    try {
      assertCanEditAuthorization(role());
    } catch (error) {
      flashNotice("deny", error instanceof PermissionDeniedError ? error.message : "无权修改授权");
      return;
    }

    const apply = (attempt: number): AuthorizationChangeResult => {
      let result: AuthorizationChangeResult = { intervieweeId, ok: false };
      commit(
        attempt === 1 ? "征集科登记授权" : `征集科重试该受访人授权（第 ${attempt} 次）`,
        (draft) => {
          result = changeAuthorization(draft, role(), intervieweeId, patch, {
            failRate: attempt === 1 && simulateFailure ? 1 : 0,
          });
          if (!result.ok) {
            // 抛错让 commit 不落入历史：失败不应产生可撤销的“空修改”，也不改动任何人。
            throw new Error(result.error);
          }
        },
        { silent: true },
      );
      return result;
    };

    // 失败只影响这一位受访人：不静默重试他人。本次失败即停，
    // 征集科随后可在同一受访人上重新发起（即“只重试这位”）。
    const result = apply(1);
    setAuthResults((items) => [{ ...result, ok: result.ok }, ...items].slice(0, 6));
    if (!result.ok) {
      flashNotice(
        "warn",
        `“${intervieweeById(intervieweeId)?.name ?? intervieweeId}”授权登记失败：${result.error}。可仅就该受访人重试；其他受访人与校对稿未改动。`,
      );
    } else {
      flashNotice("ok", `“${intervieweeById(intervieweeId)?.name ?? intervieweeId}”授权登记已更新`);
      // 授权变化后立即复核摘编，退回失效段落。
      syncAuthorization();
    }
  };

  /** 旧稿没记受访人：按访谈项目回填。 */
  const runBackfill = () => {
    let count = 0;
    commit("按访谈项目回填受访人", (draft) => {
      count = backfillInterviewees(draft);
    });
    flashNotice(count ? "ok" : "warn", count ? `已按访谈项目回填 ${count} 个片段的受访人` : "没有需要回填的片段");
  };

  const exportDigest = () => {
    const lines: string[] = [`# ${project().digest.title}`, ""];
    for (const entry of publishedEntries()) {
      const resolved = resolveEntry(project(), entry);
      if (!resolved) continue;
      const name = intervieweeById(entry.intervieweeId)?.name ?? "未知受访人";
      lines.push(`【${name}】${resolved.text}`);
    }
    downloadText(`${project().digest.title}.txt`, lines.join("\n"));
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    const imported = parseTimedTranscript(text, file.name.replace(/\.[^.]+$/, ""));
    if (!imported.segments.length) {
      setLastAction("未识别到带时间码的文本");
      return;
    }
    commit("导入转写文本", (draft) => {
      draft.tracks.push(imported);
      draft.activeTrackId = imported.id;
      setSelectedId(imported.segments[0].id);
    });
  };

  const resolveConflict = (useIncoming: boolean) => {
    const incoming = conflict();
    if (!incoming) return;
    if (useIncoming) {
      setPast((items) => [...items.slice(-49), structuredClone(project())]);
      setProject(structuredClone(incoming.project));
      setRevision(incoming.revision + 1);
      setSelectedId(incoming.project.tracks.find((track) => track.id === incoming.project.activeTrackId)?.segments[0]?.id ?? "");
      setLastAction("已采用其他标签页的版本");
      dirty = true;
    } else {
      setRevision((value) => value + 1);
      setLastAction("已保留本页并覆盖冲突版本");
      dirty = true;
    }
    setConflict(null);
  };

  onMount(() => {
    hydrated = true;
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    const handleStorage = (event: StorageEvent) => {
      if ((event.key !== STORAGE_KEY && event.key !== LEGACY_STORAGE_KEY) || !event.newValue) return;
      try {
        const incoming = JSON.parse(event.newValue) as PersistedEnvelope;
        if (incoming.tabId !== TAB_ID && incoming.revision > revision()) setConflict(incoming);
      } catch {
        // Ignore unrelated or malformed storage events.
      }
    };
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches("input, textarea, select, [contenteditable='true']");
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        const envelope = saveProject(project(), revision(), TAB_ID);
        setSaveStatus("saved");
        setLastAction("已保存本地草稿");
        channel?.postMessage(envelope);
        return;
      }
      if (editing) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(-1);
      } else if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        mergeWithNext();
      } else if (event.key.toLowerCase() === "r" && activeSegment()) {
        event.preventDefault();
        commitSegment("标记片段已校对", (segment) => { segment.reviewed = true; });
      } else if (event.key === "?" || (event.shiftKey && event.key === "/")) {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("storage", handleStorage);
    window.addEventListener("keydown", handleKeydown);
    setOnline(navigator.onLine);
    onCleanup(() => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("keydown", handleKeydown);
    });
  });

  channel?.addEventListener("message", (event: MessageEvent<PersistedEnvelope>) => {
    if (event.data.tabId !== TAB_ID && event.data.revision > revision()) setConflict(event.data);
  });

  createEffect(() => {
    const current = project();
    const currentRevision = revision();
    if (!hydrated) return;
    setSaveStatus(online() ? "saving" : "offline");
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const envelope = saveProject(current, currentRevision, TAB_ID);
      setSaveStatus(online() ? "saved" : "offline");
      if (dirty) {
        channel?.postMessage(envelope);
        dirty = false;
      }
    }, 420);
  });

  onCleanup(() => {
    window.clearTimeout(saveTimer);
    channel?.close();
  });

  const clickSegment = (id: string) => {
    setSelectedId(id);
    queueMicrotask(() => editorRef?.focus());
  };

  return (
    <div class="app-shell">
      <Show when={notice()}>
        {(n) => (
          <div class={`notice-banner notice-${n().kind}`} role="status">
            <span>{n().text}</span>
            <button class="notice-close" onClick={() => setNotice(null)} aria-label="关闭提示">×</button>
          </div>
        )}
      </Show>

      <Show when={conflict()}>
        {(incoming) => (
          <div class="conflict-banner" role="alert">
            <div>
              <strong>检测到另一个标签页修改了同一草稿</strong>
              <span>
                对方版本保存于 {new Date(incoming().savedAt).toLocaleTimeString()}。为避免静默覆盖，请选择要保留的版本。
              </span>
            </div>
            <div class="conflict-actions">
              <button class="btn btn-quiet" onClick={() => resolveConflict(false)}>保留本页</button>
              <button class="btn btn-danger" onClick={() => resolveConflict(true)}>载入对方版本</button>
            </div>
          </div>
        )}
      </Show>

      <header class="topbar">
        <div class="brand-mark" aria-hidden="true"><span>口述</span><b>1007</b></div>
        <div class="project-heading">
          <input
            aria-label="项目标题"
            value={project().title}
            onChange={(event) => commit("修改项目标题", (draft) => { draft.title = event.currentTarget.value; })}
          />
          <div class="project-meta">
            <span>{project().interviewee}</span>
            <span>{project().recordingDate}</span>
            <span class={`save-state ${saveStatus()}`}>{statusText(saveStatus())}</span>
          </div>
        </div>
        <div class="role-switch" role="group" aria-label="当前角色">
          <button
            class={role() === "proofreader" ? "active" : ""}
            onClick={() => { setRole("proofreader"); setLastAction("已切换为校对员：维护正文、批注与整理稿"); }}
            title="维护片段正文和批注，不能修改授权登记"
          >校对员</button>
          <button
            class={role() === "collector" ? "active" : ""}
            onClick={() => { setRole("collector"); setLastAction("已切换为征集科：登记受访人授权与禁提词"); }}
            title="登记授权、禁提词，负责对账"
          >征集科</button>
        </div>
        <div class="top-actions">
          <span class={`network-chip ${online() ? "online" : "offline"}`}>{online() ? "在线" : "离线可编辑"}</span>
          <button class="icon-btn" title="撤销 Ctrl/Cmd+Z" disabled={!past().length} onClick={undo}>↶</button>
          <button class="icon-btn" title="重做 Ctrl/Cmd+Shift+Z" disabled={!future().length} onClick={redo}>↷</button>
          <button class="btn btn-quiet" onClick={() => setHelpOpen(true)}>快捷键 <kbd>?</kbd></button>
          <button class="btn btn-primary" onClick={exportSrt}>导出 SRT</button>
        </div>
      </header>

      <div class="workspace">
        <aside class="left-panel">
          <section class="panel-section overview-card">
            <div class="eyebrow">校对进度</div>
            <div class="progress-row">
              <strong>{completedPercent()}%</strong>
              <span>{project().tracks.flatMap((track) => track.segments).filter((segment) => segment.reviewed).length} / {project().tracks.flatMap((track) => track.segments).length} 片段</span>
            </div>
            <div class="progress-track"><i style={{ width: `${completedPercent()}%` }} /></div>
            <p>修改会自动保存在本机；断网后仍可继续校对。</p>
          </section>

          <section class="panel-section">
            <div class="section-title"><h2>文本轨道</h2><span>{project().tracks.length}</span></div>
            <div class="track-list">
              <For each={project().tracks}>
                {(track) => (
                  <button class={`track-card ${track.id === project().activeTrackId ? "active" : ""}`} onClick={() => switchTrack(track.id)}>
                    <span class="track-icon">{track.language === "English" ? "EN" : track.language === "福州话转写" ? "方" : "普"}</span>
                    <span class="track-info"><strong>{track.name}</strong><small>{track.segments.length} 段 · {track.status}</small></span>
                    <span class="track-dot" style={{ background: track.status === "已完成" ? "#15803d" : track.status === "校对中" ? "#d97706" : "#94a3b8" }} />
                  </button>
                )}
              </For>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".srt,.txt,.vtt"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importFile(file);
                event.currentTarget.value = "";
              }}
            />
            <button class="wide-action" onClick={() => fileInputRef?.click()}><span>＋</span> 导入带时间码文本</button>
            <div class="hint">支持 SRT / VTT / 每行 `[00:12] 文本`</div>
          </section>

          <section class="panel-section tag-summary">
            <div class="section-title"><h2>标注实体</h2><span>{project().tags.length}</span></div>
            <div class="legend">
              <span><i style={{ background: "#2563eb" }} />主题</span>
              <span><i style={{ background: "#b45309" }} />事件</span>
              <span><i style={{ background: "#be185d" }} />人物</span>
            </div>
            <p>在右侧“标注”页把当前片段关联到主题、事件和人物。</p>
          </section>

          <section class="panel-section digest-card">
            <div class="section-title"><h2>公开摘编</h2><span>{publishedEntries().length} 收 / {pendingEntries().length} 退</span></div>
            <p class="digest-note">只收有效授权内片段；授权收回或封存到期，段落退回待处理，批注和整理稿保留。</p>
            <div class="digest-actions">
              <button class="wide-action compact" onClick={runReconcile}>按受访人对账</button>
              <button class="wide-action compact" onClick={syncAuthorization}>按授权复核摘编</button>
              <button class="wide-action compact" onClick={runBackfill}>旧稿回填受访人</button>
              <button class="wide-action compact primary" onClick={exportDigest}>导出公开摘编</button>
            </div>
            <Show when={reconcileReport()}>
              {(report) => (
                <div class="reconcile-mini" classList={{ hung: report().hungCount > 0 }}>
                  <strong>{report().hungCount > 0 ? `${report().hungCount} 位受访人挂起待查` : "对账无挂起项"}</strong>
                  <small>{new Date(report().generatedAt).toLocaleString()}</small>
                  <button class="linklike" onClick={() => setReconcileOpen(true)}>查看明细</button>
                </div>
              )}
            </Show>
          </section>
        </aside>

        <main class="transcript-panel">
          <div class="panel-toolbar">
            <div>
              <div class="eyebrow">当前轨道</div>
              <h1>{activeTrack().name}</h1>
            </div>
            <div class="filters" role="group" aria-label="片段筛选">
              <button class={trackFilter() === "all" ? "active" : ""} onClick={() => setTrackFilter("all")}>全部</button>
              <button class={trackFilter() === "unreviewed" ? "active" : ""} onClick={() => setTrackFilter("unreviewed")}>未校对</button>
              <button class={trackFilter() === "low" ? "active" : ""} onClick={() => setTrackFilter("low")}>低置信</button>
            </div>
          </div>

          <div class="transcript-list" role="listbox" aria-label="转写片段">
            <For each={visibleSegments()}>
              {(segment, index) => (
                <article
                  id={`segment-${segment.id}`}
                  role="option"
                  aria-selected={segment.id === selectedId()}
                  class={`segment-card ${segment.id === selectedId() ? "selected" : ""} ${segment.reviewed ? "reviewed" : ""}`}
                  onClick={() => clickSegment(segment.id)}
                >
                  <div class="segment-rail" style={{ background: speakerById(segment.speakerId)?.color ?? "#64748b" }} />
                  <div class="segment-time">
                    <span>{formatTime(segment.start, false)}</span>
                    <small>{formatTime(segment.end, false)}</small>
                  </div>
                  <div class="segment-body">
                    <div class="segment-meta">
                      <b>{speakerById(segment.speakerId)?.name ?? "未知发言人"}</b>
                      <span class={`auth-pill auth-${authStatusOf(segment.intervieweeId)}`}>
                        受访人 {intervieweeById(segment.intervieweeId)?.name ?? "待查"} · {statusLabel(authStatusOf(segment.intervieweeId))}
                      </span>
                      <span class={`confidence c${segment.confidence}`}>置信 {segment.confidence}/5</span>
                      <Show when={bannedTermsOf(segment).length}>
                        <span class="pill banned">禁提：{bannedTermsOf(segment).join("、")}</span>
                      </Show>
                      <Show when={segment.flags.lowConfidence}><span class="pill alert">低置信</span></Show>
                      <Show when={segment.flags.dialect}><span class="pill dialect">方言</span></Show>
                      <Show when={segment.flags.properNoun}><span class="pill proper">专名</span></Show>
                      <Show when={segment.reviewed}><span class="pill done">✓ 已校对</span></Show>
                      <Show when={entryFor(activeTrack().id, segment.id)?.status === "published"}><span class="pill digest-in">在摘编</span></Show>
                      <Show when={entryFor(activeTrack().id, segment.id)?.status === "pending"}><span class="pill digest-pending">退回待处理</span></Show>
                    </div>
                    <p>{segment.text}</p>
                    <div class="segment-tags">
                      <For each={segment.tagIds.map(tagById).filter(Boolean)}>
                        {(tag) => <span style={{ "--tag-color": tag!.color } as any}>#{tag!.label}</span>}
                      </For>
                    </div>
                  </div>
                  <span class="segment-index">{index() + 1}</span>
                </article>
              )}
            </For>
            <Show when={!visibleSegments().length}>
              <div class="empty-state"><b>没有符合筛选条件的片段</b><span>切换到“全部”继续校对。</span></div>
            </Show>
          </div>
        </main>

        <aside class="inspector">
          <Show when={activeSegment()} fallback={<div class="empty-inspector"><b>选择一个片段</b><p>在中间列表点击片段后即可校正发言人、置信度、标记和批注。</p></div>}>
            {(segment) => (
              <Tabs defaultValue="correct" class="inspector-tabs">
                <Tabs.List class="tab-list five">
                  <Tabs.Trigger value="correct">校对</Tabs.Trigger>
                  <Tabs.Trigger value="annotate">标注</Tabs.Trigger>
                  <Tabs.Trigger value="digest">摘编</Tabs.Trigger>
                  <Tabs.Trigger value="comments">批注 <span>{segment().comments.length}</span></Tabs.Trigger>
                  <Tabs.Trigger value="auth" class={role() === "collector" ? "role-on" : "role-off"}>授权</Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="correct" class="tab-content">
                  <div class="inspector-heading">
                    <div><span>片段 {activeTrack().segments.findIndex((item) => item.id === segment().id) + 1}</span><strong>{formatTime(segment().start, false)} — {formatTime(segment().end, false)}</strong></div>
                    <button class={`review-button ${segment().reviewed ? "done" : ""}`} onClick={() => commitSegment("标记片段已校对", (item) => { item.reviewed = true; })}>
                      {segment().reviewed ? "✓ 已校对" : "标记已校对"}
                    </button>
                  </div>

                  <label class="field-label" for="speaker-select">发言人</label>
                  <select
                    id="speaker-select"
                    value={segment().speakerId}
                    onChange={(event) => commitSegment("校正发言人", (item) => { item.speakerId = event.currentTarget.value; item.reviewed = false; })}
                  >
                    <For each={project().speakers}>{(speaker) => <option value={speaker.id}>{speaker.name} · {speaker.role}</option>}</For>
                  </select>

                  <label class="field-label" for="interviewee-select">片段受访人（对账归属）</label>
                  <select
                    id="interviewee-select"
                    value={segment().intervieweeId ?? ""}
                    onChange={(event) => commitSegment("登记片段受访人", (item) => { item.intervieweeId = event.currentTarget.value || undefined; item.reviewed = false; })}
                  >
                    <option value="">（未登记 / 挂起待查）</option>
                    <For each={project().interviewees}>{(person) => <option value={person.id}>{person.name}</option>}</For>
                  </select>

                  <div class="time-grid">
                    <label>开始<input type="text" value={formatTime(segment().start)} onChange={(event) => commitSegment("修改开始时间", (item) => { item.start = parseTime(event.currentTarget.value); })} /></label>
                    <label>结束<input type="text" value={formatTime(segment().end)} onChange={(event) => commitSegment("修改结束时间", (item) => { item.end = parseTime(event.currentTarget.value); })} /></label>
                  </div>

                  <label class="field-label" for="transcript-editor">转写文本</label>
                  <textarea
                    id="transcript-editor"
                    ref={editorRef}
                    rows="7"
                    value={segment().text}
                    onChange={(event) => commitSegment("校正转写文本", (item) => { item.text = event.currentTarget.value; item.reviewed = false; })}
                  />
                  <div class="textarea-help">光标停在句中后点击“拆分”，系统会保留两侧时间码比例。</div>

                  <div class="field-label">置信度</div>
                  <div class="confidence-picker" role="radiogroup" aria-label="置信度">
                    <For each={[1, 2, 3, 4, 5] as Confidence[]}>
                      {(value) => <button class={segment().confidence === value ? "active" : ""} onClick={() => setConfidence(value)}>{value}</button>}
                    </For>
                  </div>

                  <div class="field-label">校对标记</div>
                  <div class="flag-list">
                    <Checkbox checked={segment().flags.lowConfidence} onChange={() => toggleFlag("lowConfidence")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>低置信词或句</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.dialect} onChange={() => toggleFlag("dialect")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>方言表达</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.properNoun} onChange={() => toggleFlag("properNoun")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>专有名词</Checkbox.Label>
                    </Checkbox>
                  </div>

                  <div class="split-actions">
                    <button onClick={splitSelection}>⌁ 按光标拆分</button>
                    <button disabled={activeTrack().segments.at(-1)?.id === segment().id} onClick={mergeWithNext}>合 合并下一段</button>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="annotate" class="tab-content">
                  <div class="content-title"><h3>关联主题、事件与人物</h3><p>一个片段可关联多个实体，复核后颜色会显示在列表中。</p></div>
                  <For each={project().tags}>
                    {(tag) => (
                      <button class={`tag-option ${segment().tagIds.includes(tag.id) ? "selected" : ""}`} onClick={() => toggleTag(tag.id)}>
                        <i style={{ background: tag.color }} />
                        <span><strong>#{tag.label}</strong><small>{tag.type === "topic" ? "主题" : tag.type === "event" ? "事件" : "人物"}</small></span>
                        <b>{segment().tagIds.includes(tag.id) ? "✓" : "＋"}</b>
                      </button>
                    )}
                  </For>
                </Tabs.Content>

                <Tabs.Content value="comments" class="tab-content comments-content">
                  <div class="content-title"><h3>批注与回复</h3><p>批注不会改写原文，可保留校对依据并继续讨论。</p></div>
                  <div class="comment-compose">
                    <textarea rows="3" placeholder="记录读音、词义或专名依据…" value={commentDraft()} onInput={(event) => setCommentDraft(event.currentTarget.value)} />
                    <button class="btn btn-primary" onClick={addComment}>添加批注</button>
                  </div>
                  <For each={segment().comments} fallback={<div class="mini-empty">当前片段还没有批注。</div>}>
                    {(comment) => (
                      <article class={`comment-card ${comment.resolved ? "resolved" : ""}`}>
                        <header><strong>{comment.author}</strong><time>{new Date(comment.createdAt).toLocaleString()}</time></header>
                        <p>{comment.body}</p>
                        <For each={comment.replies}>
                          {(reply) => <div class="reply"><b>{reply.author}</b><span>{reply.body}</span></div>}
                        </For>
                        <div class="reply-row">
                          <input
                            value={replyDrafts()[comment.id] ?? ""}
                            placeholder="回复…"
                            onInput={(event) => setReplyDrafts((drafts) => ({ ...drafts, [comment.id]: event.currentTarget.value }))}
                            onKeyDown={(event) => { if (event.key === "Enter") addReply(comment.id); }}
                          />
                          <button onClick={() => addReply(comment.id)}>回复</button>
                        </div>
                        <button class="resolve-link" onClick={() => toggleComment(comment.id)}>{comment.resolved ? "重新打开" : "标记已解决"}</button>
                      </article>
                    )}
                  </For>
                </Tabs.Content>

                <Tabs.Content value="digest" class="tab-content digest-content">
                  <div class="content-title"><h3>公开摘编编选</h3><p>只有处于有效授权内、且未命中禁提词的片段才能收入。授权变化后在左栏“按授权复核”，已编入段落会退回待处理，校对批注与整理稿不动。</p></div>

                  <div class={`auth-banner auth-${activeEligibility()?.status ?? "none"}`}>
                    <strong>受访人：{intervieweeById(segment().intervieweeId)?.name ?? "查无此人"}</strong>
                    <span>授权状态：{statusLabel(activeEligibility()?.status ?? "none")}</span>
                    <Show when={activeEligibility()?.banned.length}>
                      <em>命中禁提词：{activeEligibility()?.banned.join("、")}</em>
                    </Show>
                    <Show when={!activeEligibility()?.eligible}>
                      <em class="deny-reason">{activeEligibility()?.reason}</em>
                    </Show>
                  </div>

                  <Show
                    when={entryFor(activeTrack().id, segment().id)}
                    fallback={
                      <button class="wide-action primary" disabled={!activeEligibility()?.eligible} onClick={admitCurrent}>
                        {activeEligibility()?.eligible ? "编入公开摘编" : "不可编入（授权受限）"}
                      </button>
                    }
                  >
                    {(entry) => (
                      <div class="digest-entry-state">
                        <span class={`digest-state state-${entry().status}`}>
                          {entry().status === "published" ? "✓ 已在公开摘编中" : "已退回待处理"}
                        </span>
                        <Show when={entry().returnedReason}><small>退回原因：{entry().returnedReason}</small></Show>
                        <div class="digest-entry-buttons">
                          <Show when={entry().status === "pending"}>
                            <button class="btn btn-primary" disabled={!activeEligibility()?.eligible} onClick={admitCurrent}>恢复编入</button>
                          </Show>
                          <button class="btn btn-quiet" onClick={() => removeEntry(entry().segmentKey)}>撤出摘编</button>
                        </div>
                      </div>
                    )}
                  </Show>

                  <div class="field-label">本摘编待处理（退回）段落</div>
                  <For each={pendingEntries()} fallback={<div class="mini-empty">没有退回待处理的段落。</div>}>
                    {(entry) => {
                      const resolved = entryText(entry.segmentKey);
                      return (
                        <div class="pending-row">
                          <b>{intervieweeById(entry.intervieweeId)?.name ?? "未知受访人"}</b>
                          <span>{resolved ? resolved.segment.text : "（原稿缺失，稿件与批注保持原样）"}</span>
                          <small>{entry.returnedReason}</small>
                        </div>
                      );
                    }}
                  </For>
                </Tabs.Content>

                <Tabs.Content value="auth" class="tab-content auth-content">
                  <AuthorizationPanel
                    role={role()}
                    project={project()}
                    results={authResults()}
                    currentIntervieweeId={segment().intervieweeId}
                    onDeny={() => flashNotice("deny", "校对员无权修改授权登记，授权由征集科维护")}
                    onChange={submitAuthorizationChange}
                  />
                </Tabs.Content>
              </Tabs>
            )}
          </Show>
        </aside>
      </div>

      <footer class="statusbar">
        <span>最近操作：{lastAction()}</span>
        <span>版本 {revision() + 1} · 本地草稿</span>
        <span class="status-shortcuts">J/K 浏览　R 已校对　M 合并　? 帮助</span>
      </footer>

      <Dialog open={helpOpen()} onOpenChange={setHelpOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content">
            <Dialog.Title>键盘校对</Dialog.Title>
            <Dialog.Description>光标在输入框中时，单键快捷键不会抢占文字输入。</Dialog.Description>
            <div class="shortcut-grid">
              <span><kbd>J</kbd><kbd>↓</kbd> 下一片段</span>
              <span><kbd>K</kbd><kbd>↑</kbd> 上一片段</span>
              <span><kbd>R</kbd> 标记已校对</span>
              <span><kbd>M</kbd> 合并下一片段</span>
              <span><kbd>Ctrl/⌘ Z</kbd> 撤销</span>
              <span><kbd>Ctrl/⌘ ⇧ Z</kbd> 重做</span>
              <span><kbd>Ctrl/⌘ S</kbd> 立即保存</span>
              <span><kbd>?</kbd> 显示本帮助</span>
            </div>
            <div class="dialog-footer"><button class="btn btn-primary" onClick={() => setHelpOpen(false)}>开始校对</button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      <Dialog open={reconcileOpen()} onOpenChange={setReconcileOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content reconcile-dialog">
            <Dialog.Title>按受访人对账</Dialog.Title>
            <Dialog.Description>
              授权登记与稿件/摘编按受访人核对；名册查不到的人先挂起，不影响其他人。
            </Dialog.Description>
            <Show when={reconcileReport()} fallback={<div class="mini-empty">尚未对账，点击左栏“按受访人对账”。</div>}>
              {(report) => (
                <div class="reconcile-table">
                  <div class="reconcile-head">
                    <span>受访人</span><span>授权</span><span>片段</span><span>在摘编</span><span>退回</span><span>禁提命中</span>
                  </div>
                  <For each={report().items}>
                    {(item) => (
                      <div class={`reconcile-row ${item.known ? "" : "hung"}`}>
                        <span><b>{item.known ? item.name : "挂起待查"}</b><small>{item.known ? item.intervieweeId : item.intervieweeId || "未回填受访人"}</small></span>
                        <span class={`cell-auth auth-${item.authorization ? item.authorization.status : "none"}`}>
                          {statusLabel(item.authorization ? item.authorization.status : "none")}
                        </span>
                        <span>{item.segmentCount}</span>
                        <span>{item.publishedCount}</span>
                        <span>{item.pendingCount}</span>
                        <span>{item.bannedHitCount}</span>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </Show>
            <div class="dialog-footer">
              <button class="btn btn-quiet" onClick={runBackfill}>回填旧稿受访人</button>
              <button class="btn btn-primary" onClick={() => setReconcileOpen(false)}>知道了</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </div>
  );
}
