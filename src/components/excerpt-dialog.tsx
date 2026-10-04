import { Dialog } from "@kobalte/core/dialog";
import { For, Show, createMemo, createSignal } from "solid-js";
import { compileExcerpts, reconcileParagraphs } from "../domain/excerpts";
import type {
  AuthorizationRecord,
  AuthorizationSyncState,
  ExcerptParagraph,
  ProjectData,
} from "../types";

interface ExcerptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectData;
  ledger: AuthorizationRecord[];
  paragraphs: ExcerptParagraph[];
  syncStates: Record<string, AuthorizationSyncState>;
  onCompile: () => void;
  onReconcile: () => void;
  onDraftChange: (paragraphId: string, draft: string) => void;
  onRetry: (intervieweeId: string) => void;
}

const STATUS_LABEL: Record<ExcerptParagraph["status"], string> = {
  已编入: "已编入",
  待处理: "待处理",
  已挂起: "已挂起",
};

export default function ExcerptDialog(props: ExcerptDialogProps) {
  const [filter, setFilter] = createSignal<"all" | ExcerptParagraph["status"]>("all");

  const segmentById = createMemo(() => {
    const map = new Map<string, { text: string; trackName: string }>();
    for (const track of props.project.tracks) {
      for (const segment of track.segments) {
        map.set(segment.id, { text: segment.text, trackName: track.name });
      }
    }
    return map;
  });

  const intervieweeName = (intervieweeId: string) =>
    props.ledger.find((record) => record.intervieweeId === intervieweeId)?.intervieweeName
    ?? intervieweeId.replace(/^interviewee:/, "");

  const grouped = createMemo(() => {
    const list = props.paragraphs;
    if (filter() === "all") return list;
    return list.filter((paragraph) => paragraph.status === filter());
  });

  const counts = createMemo(() => ({
    已编入: props.paragraphs.filter((p) => p.status === "已编入").length,
    待处理: props.paragraphs.filter((p) => p.status === "待处理").length,
    已挂起: props.paragraphs.filter((p) => p.status === "已挂起").length,
  }));

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="dialog-overlay" />
        <Dialog.Content class="dialog-content excerpt-dialog">
          <Dialog.Title>公开摘编与授权对账</Dialog.Title>
          <Dialog.Description>
            摘编只收有效授权内的片段。授权收回或封存到期，已编入段落退回待处理；
            批注与整理稿保留。授权登记由征集科维护，校对员只读、不能修改。
          </Dialog.Description>

          <section class="excerpt-ledger">
            <div class="excerpt-section-head">
              <h3>授权登记（征集科维护）</h3>
              <span class="excerpt-hint">校对员只读</span>
            </div>
            <div class="ledger-grid">
              <For each={props.ledger}>
                {(record) => {
                  const sync = () => props.syncStates[record.intervieweeId];
                  return (
                    <div class={`ledger-card state-${record.state}`}>
                      <div class="ledger-top">
                        <strong>{record.intervieweeName}</strong>
                        <span class={`ledger-state state-${record.state}`}>{record.state}</span>
                      </div>
                      <Show when={record.sealedUntil}>
                        <small>封存至 {record.sealedUntil}</small>
                      </Show>
                      <Show when={sync()?.status === "failed"}>
                        <div class="ledger-retry">
                          <span>同步失败：{sync()?.lastError ?? "未知错误"}</span>
                          <button
                            class="btn btn-quiet"
                            onClick={() => props.onRetry(record.intervieweeId)}
                          >
                            重试这位受访人
                          </button>
                        </div>
                      </Show>
                      <Show when={sync()?.status === "pending"}>
                        <small class="ledger-pending">正在同步…</small>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </section>

          <section class="excerpt-toolbar">
            <button class="btn btn-primary" onClick={props.onCompile}>编制摘编</button>
            <button class="btn btn-quiet" onClick={props.onReconcile}>按受访人对账</button>
            <div class="excerpt-filters" role="group" aria-label="摘编状态筛选">
              <button class={filter() === "all" ? "active" : ""} onClick={() => setFilter("all")}>
                全部 {props.paragraphs.length}
              </button>
              <button class={filter() === "已编入" ? "active" : ""} onClick={() => setFilter("已编入")}>
                已编入 {counts().已编入}
              </button>
              <button class={filter() === "待处理" ? "active" : ""} onClick={() => setFilter("待处理")}>
                待处理 {counts().待处理}
              </button>
              <button class={filter() === "已挂起" ? "active" : ""} onClick={() => setFilter("已挂起")}>
                已挂起 {counts().已挂起}
              </button>
            </div>
          </section>

          <section class="excerpt-list">
            <For each={grouped()} fallback={<div class="mini-empty">还没有摘编段落。点击“编制摘编”按有效授权收集片段。</div>}>
              {(paragraph) => {
                const info = () => segmentById().get(paragraph.segmentId);
                return (
                  <article class={`excerpt-card status-${paragraph.status}`}>
                    <div class="excerpt-card-head">
                      <span class={`excerpt-status status-${paragraph.status}`}>{STATUS_LABEL[paragraph.status]}</span>
                      <span class="excerpt-interviewee">{intervieweeName(paragraph.intervieweeId)}</span>
                      <span class="excerpt-track">{info()?.trackName ?? "未知轨道"}</span>
                    </div>
                    <p class="excerpt-text">{info()?.text ?? "（片段已删除）"}</p>
                    <label class="excerpt-draft">
                      <span>整理稿</span>
                      <textarea
                        rows="2"
                        placeholder="校对员整理稿，授权回退后仍保留"
                        value={paragraph.draft}
                        onInput={(event) => props.onDraftChange(paragraph.id, event.currentTarget.value)}
                      />
                    </label>
                  </article>
                );
              }}
            </For>
          </section>

          <div class="dialog-footer">
            <button class="btn btn-primary" onClick={() => props.onOpenChange(false)}>关闭</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}
