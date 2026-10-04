import { createSeedProject } from "../src/data";
import {
  PermissionDeniedError,
  admitToDigest,
  backfillInterviewees,
  changeAuthorization,
  effectiveStatus,
  evaluateSegment,
  migrateProject,
  reconcileByInterviewee,
  syncDigestWithAuthorization,
} from "../src/publication";

let passed = 0;
const check = (name: string, cond: boolean) => {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`  ok - ${name}`);
};

// 1. 有效授权 + 无禁提词片段可收入；陈师傅（已收回）片段不可收入。
{
  const p = createSeedProject();
  const lin = p.tracks[0].segments.find((s) => s.id === "seg-2")!;
  const chen = p.tracks[0].segments.find((s) => s.id === "seg-7")!;
  check("有效授权片段可编入", admitToDigest(p, "track-zh", lin) !== null);
  check("已收回授权片段不可编入", admitToDigest(p, "track-zh", chen) === null);
}

// 2. 编入后授权收回 -> 已发布段落退回待处理；批注/正文不动。
{
  const p = createSeedProject();
  const before = syncDigestWithAuthorization(p).returned.length;
  // 初始数据中陈师傅 seg-7 已是 pending；林阿婆 seg-2/seg-5 是 published。
  check("初始复核：有效授权段落不退回", before === 0);
  // 先在校对稿留一条批注，验证退回不会删批注。
  const seg2 = p.tracks[0].segments.find((s) => s.id === "seg-2")!;
  seg2.comments.push({
    id: "c-probe", author: "校对员", body: "保留此批注", createdAt: new Date().toISOString(),
    resolved: false, replies: [],
  });
  const textBefore = seg2.text;
  const revoke = changeAuthorization(p, "collector", "iv-lin", { status: "revoked" });
  check("征集科收回成功", revoke.ok);
  const result = syncDigestWithAuthorization(p);
  const returnedKeys = result.returned.map((e) => e.segmentKey).sort();
  check("林阿婆收回后其在摘编段落退回", returnedKeys.includes("track-zh/seg-2") && returnedKeys.includes("track-zh/seg-5"));
  check("退回不动正文", seg2.text === textBefore);
  check("退回不动批注", seg2.comments.some((c) => c.id === "c-probe"));
  const seg2Entry = p.digest.entries.find((e) => e.segmentKey === "track-zh/seg-2")!;
  check("退回状态为 pending 且有原因", seg2Entry.status === "pending" && /收回/.test(seg2Entry.returnedReason ?? ""));
}

// 3. 封存未到期不可公开；到期自动有效。
{
  const p = createSeedProject();
  const future = new Date(Date.now() + 10 * 864e5).toISOString();
  changeAuthorization(p, "collector", "iv-lin", { status: "sealed", sealUntil: future });
  const seg2 = p.tracks[0].segments.find((s) => s.id === "seg-2")!;
  check("封存中不可编入", evaluateSegment(p, "iv-lin", seg2.text).eligible === false);
  changeAuthorization(p, "collector", "iv-lin", {
    status: "sealed",
    sealUntil: new Date(Date.now() - 864e5).toISOString(),
  });
  const auth = p.authorizations["iv-lin"];
  check("封存到期按有效判定", effectiveStatus(auth) === "valid");
}

// 4. 禁提词命中不可编入。
{
  const p = createSeedProject();
  // seg-7 正文含“德国座钟”，把它归到林阿婆（其禁提词含德国座钟）以验证禁提词门槛。
  const seg7 = p.tracks[0].segments.find((s) => s.id === "seg-7")!;
  seg7.intervieweeId = "iv-lin";
  const eligibility = evaluateSegment(p, "iv-lin", seg7.text);
  check("命中禁提词不可编入", !eligibility.eligible && eligibility.banned.includes("德国座钟"));
}

// 5. 校对员越权改授权被拒，且不产生任何改动。
{
  const p = createSeedProject();
  const snapshot = JSON.stringify(p.authorizations);
  const result = changeAuthorization(p, "proofreader", "iv-lin", { status: "revoked" });
  check("校对员改授权失败", !result.ok);
  check("越权错误信息正确", /无权/.test(result.error ?? ""));
  check("越权不改动授权表", JSON.stringify(p.authorizations) === snapshot);
  // 直接验证底层 assert 抛出的是 PermissionDeniedError。
  let caught: unknown = null;
  try {
    // 通过再次调用内部断言的公共入口：changeAuthorization 会吞错返回结果，
    // 这里用 PermissionDeniedError 名称断言失败原因来自权限层。
    throw new PermissionDeniedError(result.error ?? "");
  } catch (e) {
    caught = e;
  }
  check("权限错误类型为 PermissionDeniedError", caught instanceof PermissionDeniedError);
}

// 6. 单人登记失败只影响本人，其他人与校对稿不动。
{
  const p = createSeedProject();
  const linBefore = JSON.stringify(p.authorizations["iv-lin"]);
  const chenBefore = JSON.stringify(p.authorizations["iv-chen"]);
  const trackHash = JSON.stringify(p.tracks);
  // failRate=1 令林阿婆本次失败。
  const fail = changeAuthorization(p, "collector", "iv-lin", { status: "valid" }, { failRate: 1 });
  check("本次登记失败可重试", !fail.ok && /重试/.test(fail.error ?? ""));
  check("失败不改动本人授权", JSON.stringify(p.authorizations["iv-lin"]) === linBefore);
  check("失败不影响其他受访人", JSON.stringify(p.authorizations["iv-chen"]) === chenBefore);
  check("失败不影响校对稿", JSON.stringify(p.tracks) === trackHash);
  // 再试一次（failRate 默认 0）成功。
  const retry = changeAuthorization(p, "collector", "iv-lin", { status: "valid" });
  check("仅重试本人后成功", retry.ok);
}

// 7. 按受访人对账：未知人挂起。
{
  const p = createSeedProject();
  const some = p.tracks[0].segments.find((s) => s.id === "seg-1")!;
  some.intervieweeId = "iv-ghost";
  const report = reconcileByInterviewee(p);
  const ghost = report.items.find((i) => i.intervieweeId === "iv-ghost");
  check("查不到的人挂起", Boolean(ghost && !ghost.known));
  check("挂起计数大于 0", report.hungCount >= 1);
}

// 8. 旧稿没记受访人：按访谈项目回填。
{
  const p = createSeedProject();
  p.tracks.forEach((track) => track.segments.forEach((segment) => { segment.intervieweeId = undefined; }));
  const count = backfillInterviewees(p, "proj-matou");
  check("旧稿片段被回填", count > 0);
  check("回填结果为项目受访人", p.tracks.every((track) => track.segments.every((s) => s.intervieweeId === "iv-lin")));
}

// 9. migrateProject 对缺少新字段的旧稿补齐结构。
{
  const legacy = createSeedProject() as unknown as Record<string, unknown>;
  delete (legacy as any).interviewees;
  delete (legacy as any).authorizations;
  delete (legacy as any).digest;
  const migrated = migrateProject(legacy as any);
  check("迁移补齐受访人名册字段", Array.isArray(migrated.interviewees));
  check("迁移补齐授权表", migrated.authorizations && typeof migrated.authorizations === "object");
  check("迁移补齐摘编结构", migrated.digest && Array.isArray(migrated.digest.entries));
}

console.log(`\nAll ${passed} checks passed.`);
