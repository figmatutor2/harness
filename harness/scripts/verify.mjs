#!/usr/bin/env node
// 허들링 디자인 하네스 — 게이트 판정 스크립트
// 기준: harness/rules.yaml (SSOT). state.json 과 verify-report.md 는 이 스크립트만 쓴다.
//
// 사용법
//   node harness/scripts/verify.mjs init <slug> --topic "<화면 주제>" --figma <Figma 파일 URL>
//   node harness/scripts/verify.mjs <p1|p2|p3|p3-approval|p4> <slug>
//   node harness/scripts/verify.mjs status <slug>
//   node harness/scripts/verify.mjs unblock <slug>        # 3회 실패 차단 해제 (사람이 실행)
//
// 종료 코드: 0 통과 · 1 실패 · 2 사용법/전제 오류 · 3 차단(같은 게이트 3회 실패)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HARNESS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ROOT = path.resolve(HARNESS_DIR, "..");
const RULES = YAML.parse(
  fs.readFileSync(path.join(HARNESS_DIR, "rules.yaml"), "utf8"),
);
const RUNS = path.join(ROOT, RULES.run.runs_dir);
const GATES = RULES.gates.order;

// ─── 공통 유틸 ───────────────────────────────────────────

const re = (src, flags = "") => new RegExp(src, flags);
const now = () => new Date().toISOString();

function usage(msg) {
  if (msg) console.error(`⚠️  ${msg}`);
  console.error(
    '사용법: verify.mjs init <slug> --topic "<주제>" --figma <URL> | <p1|p2|p3|p3-approval|p4> <slug> | status <slug> | unblock <slug>',
  );
  process.exit(2);
}

function runDir(slug) {
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug))
    usage(
      "slug는 영문 소문자·숫자·하이픈만 쓸 수 있어요 (예: my-asset-register)",
    );
  return path.join(RUNS, slug);
}

const statePath = (slug) => path.join(runDir(slug), "state.json");

function loadState(slug) {
  const p = statePath(slug);
  if (!fs.existsSync(p))
    usage(`실행 기록이 없어요: ${path.relative(ROOT, p)} — 먼저 init 하세요`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveState(slug, state) {
  state.updatedAt = now();
  fs.writeFileSync(statePath(slug), JSON.stringify(state, null, 2) + "\n");
}

function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

function readJson(file, failures, label) {
  const raw = readText(file);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    failures.push(`${label}: JSON 형식 오류 (${e.message})`);
    return null;
  }
}

// "### R1 ..." 같은 제목 기준으로 블록을 자른다.
function blocks(text, headingSrc) {
  const lines = text.split("\n");
  const out = [];
  let cur = null;
  const h = re(headingSrc);
  for (const line of lines) {
    const m = line.match(h);
    if (m) {
      cur = { id: m[1], heading: line, body: "" };
      out.push(cur);
    } else if (cur) {
      if (/^#{1,3}\s/.test(line))
        cur = null; // 다른 제목이 나오면 블록 종료
      else cur.body += line + "\n";
    }
  }
  return out;
}

// "## 제목" 섹션 본문
function section(text, title) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) =>
    re(`^##\\s+${title}\\s*$`).test(l.trim()),
  );
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

function requireFiles(dir, files, failures) {
  for (const f of files) {
    if (!fs.existsSync(path.join(dir, f)))
      failures.push(`필수 파일 없음: ${f}`);
  }
}

function checkPlaceholders(dir, files, failures) {
  const ph = re(RULES.run.placeholder_pattern, "g");
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const t = readText(path.join(dir, f));
    const hits = t ? t.match(ph) : null;
    if (hits)
      failures.push(
        `${f}: 템플릿 미작성 항목 ${hits.length}건 (${[...new Set(hits)].slice(0, 3).join(", ")})`,
      );
  }
}

const normId = (id) => String(id).replace("-", ":");

// ─── 게이트별 검사 ────────────────────────────────────────
// 각 검사 함수는 { failures: string[], returnTo?: gate } 를 돌려준다.

function checkP1(dir) {
  const r = RULES.p1;
  const failures = [];
  requireFiles(dir, r.files, failures);
  if (failures.length) return { failures };
  checkPlaceholders(dir, r.files, failures);

  const refs = blocks(
    readText(path.join(dir, "references.md")),
    r.reference_heading,
  );
  if (refs.length < r.min_references)
    failures.push(
      `레퍼런스 ${refs.length}개 — 최소 ${r.min_references}개 필요`,
    );
  const noUrl = refs.filter(
    (b) => !re(r.reference_url_pattern).test(b.body + b.heading),
  );
  if (noUrl.length)
    failures.push(
      `uibowl 링크 없는 레퍼런스 ${noUrl.length}건: ${noUrl.map((b) => "R" + b.id).join(", ")}`,
    );

  const refIds = new Set(refs.map((b) => b.id));
  const points = blocks(
    readText(path.join(dir, "analysis.md")),
    r.point_heading,
  );
  if (points.length < r.min_points)
    failures.push(
      `반영 포인트 ${points.length}개 — 최소 ${r.min_points}개 필요`,
    );
  for (const p of points) {
    const m = p.body.match(re(r.point_source_pattern));
    if (!m) failures.push(`RP-${p.id}: 출처 레퍼런스 번호 없음`);
    else if (!refIds.has(m[1]))
      failures.push(`RP-${p.id}: 출처 R${m[1]}이 references.md에 없음`);
  }
  return { failures };
}

function checkP2(dir) {
  const r = RULES.p2;
  const failures = [];
  if (fs.existsSync(path.join(dir, r.needs_research_file))) {
    return {
      failures: [
        `${r.needs_research_file} 있음 — 반영 포인트 부족으로 추가 리서치 요청`,
      ],
      returnTo: RULES.gates.return_to.p2_needs_research,
    };
  }
  requireFiles(dir, r.files, failures);
  if (failures.length) return { failures };
  checkPlaceholders(dir, r.files, failures);
  // 템플릿 안내 주석(<!-- -->)의 예시 문구가 판정에 섞이지 않도록 제거한다.
  const spec = readText(path.join(dir, "screen-spec.md")).replace(
    /<!--[\s\S]*?-->/g,
    "",
  );

  const missing = r.required_sections.filter((s) => section(spec, s) === null);
  if (missing.length)
    failures.push(`필수 섹션 누락 ${missing.length}건: ${missing.join(", ")}`);

  const storySec = section(spec, "연결 유저스토리") ?? "";
  const ids = [...storySec.matchAll(re(r.story_id_pattern, "g"))].map((m) =>
    Number(m[1]),
  );
  const [lo, hi] = r.story_id_range;
  if (!ids.length) failures.push("연결 유저스토리 번호(US-n) 없음");
  const bad = ids.filter((n) => n < lo || n > hi);
  if (bad.length)
    failures.push(
      `범위 밖 유저스토리 번호 ${bad.length}건: ${bad.map((n) => "US-" + n).join(", ")} (허용 US-${lo}~US-${hi})`,
    );

  const excluded = r.excluded_keywords
    .map((k) => [k, spec.split(k).length - 1])
    .filter(([, c]) => c > 0);
  if (excluded.length)
    failures.push(
      `MVP 범위 밖 키워드 ${excluded.reduce((a, [, c]) => a + c, 0)}건: ${excluded.map(([k, c]) => `${k}×${c}`).join(", ")}`,
    );

  // ★ 어기면 안 되는 것 1 — 기본 비공개
  const v = r.visibility;
  const visLines = spec
    .split("\n")
    .filter((l) => v.trigger_keywords.some((k) => l.includes(k)));
  if (visLines.length) {
    const forbidden = visLines.filter(
      (l) =>
        re(v.forbidden_default_pattern).test(l) &&
        !re(v.required_default_pattern).test(l),
    );
    if (forbidden.length)
      failures.push(`★ 공개 범위 기본값이 비공개가 아님 ${forbidden.length}건`);
    else if (!visLines.some((l) => re(v.required_default_pattern).test(l)))
      failures.push('★ 공개 범위가 있는데 "기본값: 비공개" 명시 없음');
  }

  // ★ 어기면 안 되는 것 2 — 판매 신청은 검수를 거친다
  const s = r.sale_review;
  if (s.trigger_keywords.some((k) => spec.includes(k))) {
    const stateSec = section(spec, "상태") ?? "";
    const miss = s.required_state_keywords.filter((k) => !stateSec.includes(k));
    if (miss.length)
      failures.push(`★ 판매 신청 흐름에 필수 상태 누락: ${miss.join(", ")}`);
    const skip = spec.match(re(s.forbidden_transition_pattern, "g"));
    if (skip)
      failures.push(`★ 검수 없이 판매로 넘어가는 흐름 ${skip.length}건`);
  }
  return { failures };
}

function checkFrames(frames, label, failures) {
  const { width, height } = RULES.design.frame;
  for (const f of frames) {
    if (Math.round(f.width) !== width || Math.round(f.height) !== height)
      failures.push(
        `${label} 프레임 "${f.name}"(${f.id}) ${f.width}×${f.height} — ${width}×${height} 필요`,
      );
  }
}

// 화면 템플릿 규칙 (rules.yaml template + design.typography/radius) — P3·P4 공통
// expectLetter 가 있으면 프레임의 시안 문자가 그 값과 같아야 한다 (P4 = 선택 시안).
function checkStructure(frames, expectLetter) {
  const t = RULES.template;
  const d = RULES.design;
  const tally = {
    layout: [],
    naming: [],
    typography: [],
    radius: [],
    touch: [],
    cta: [],
  };
  const typo = new Set(d.typography.map(([s, w]) => `${s}/${w}`));
  const radius = new Set(d.radius);
  const sys = new Set(t.system_instances);
  const near = (a, b) => Math.abs(Math.round(a) - b) <= 0;

  for (const f of frames) {
    const fm = String(f.name).match(re(t.frame_name_pattern));
    if (!fm) {
      tally.naming.push(`프레임 "${f.name}": "<A~C> · <화면명>" 형식 아님`);
      continue;
    }
    const letter = fm[1];
    if (expectLetter && letter !== expectLetter)
      tally.naming.push(
        `프레임 "${f.name}": 선택 시안 ${expectLetter}와 문자가 다름`,
      );
    const p = letter.toLowerCase();
    const layerRe = re(t.layer_name_pattern.replace("{p}", p));
    const nodes = (f.nodes ?? []).filter((n) => n.id !== f.id);
    const byName = (k) => nodes.find((n) => n.name === `${p}.${k}`);
    const at = (n) => `"${n.name}"(${n.id})`;

    // 1 상태바
    const sb = nodes.find(
      (n) => n.system && sys.has(n.componentName ?? n.name),
    );
    if (!sb)
      tally.layout.push(
        `${f.name}: 상태바 인스턴스(${t.system_instances.join(", ")}) 없음`,
      );
    else if (
      !near(sb.y, t.status_bar.y) ||
      !near(sb.height, t.status_bar.height)
    )
      tally.layout.push(
        `${f.name}: 상태바 y${sb.y}·h${sb.height} — y${t.status_bar.y}·h${t.status_bar.height} 필요`,
      );
    // 2 고정 영역
    for (const [k, v] of Object.entries(t.regions)) {
      const n = byName(k);
      if (!n) tally.layout.push(`${f.name}: ${p}.${k} 없음`);
      else if (!near(n.y, v.y) || !near(n.height, v.height))
        tally.layout.push(
          `${at(n)}: y${n.y}·h${n.height} — y${v.y}·h${v.height} 필요`,
        );
    }
    // 3 스크롤 영역은 탭바와 겹치지 않는다
    const sc = byName(t.scroll_region);
    const tabs = byName("tabs");
    if (sc && tabs && Math.round(sc.y + sc.height) > Math.round(tabs.y))
      tally.layout.push(
        `${at(sc)}: 탭바와 ${Math.round(sc.y + sc.height - tabs.y)}px 겹침`,
      );
    // 4 본문 좌우 여백
    const body = byName(t.body.name);
    if (!body) tally.layout.push(`${f.name}: ${p}.${t.body.name} 없음`);
    else {
      const [, r, , l] = body.padding ?? [];
      if (r !== t.body.side_padding || l !== t.body.side_padding)
        tally.layout.push(
          `${at(body)}: 좌우 padding ${l ?? "-"}/${r ?? "-"} — ${t.body.side_padding} 필요`,
        );
    }

    for (const n of nodes) {
      if (n.system) continue;
      // 5·6 레이어 이름
      if (!layerRe.test(n.name))
        tally.naming.push(`${at(n)}: "${p}.역할명" 형식 아님`);
      // 7 타이포
      if (n.type === "TEXT") {
        for (const w of n.fontWeights ?? []) {
          if (d.forbidden_weights.includes(w))
            tally.typography.push(`${at(n)}: 굵기 ${w} 금지`);
          for (const s of n.fontSizes ?? [])
            if (!typo.has(`${s}/${w}`))
              tally.typography.push(
                `${at(n)}: ${s}px/${w} — design.md 스케일에 없음`,
              );
        }
      }
      // 8 모서리
      const isBtn = t.interactive_suffixes.some((s) => n.name.endsWith(s));
      for (const rv of n.radius ?? [])
        if (!radius.has(rv))
          tally.radius.push(
            `${at(n)}: 모서리 ${rv} — 허용 ${[...radius].join("/")}`,
          );
      if (
        isBtn &&
        (n.radius ?? []).some((rv) => rv < Math.min(n.width, n.height) / 2)
      )
        tally.radius.push(`${at(n)}: 버튼은 pill 이어야 함`);
      // 9 터치 영역
      const isTab = re(t.tab_item_pattern.replace("{p}", p)).test(n.name);
      if (
        (isBtn || isTab) &&
        (n.width < t.sizes.tap_min || n.height < t.sizes.tap_min)
      )
        tally.touch.push(
          `${at(n)}: ${n.width}×${n.height} — 최소 ${t.sizes.tap_min}×${t.sizes.tap_min}`,
        );
      if (n.name.endsWith(t.cta_suffix) && !near(n.height, t.sizes.button))
        tally.touch.push(
          `${at(n)}: CTA 높이 ${n.height} — ${t.sizes.button} 필요`,
        );
      // 10 CTA 에 액센트 금지
      if (n.name.endsWith(t.cta_suffix)) {
        const bad = (n.fills ?? []).filter((c) =>
          t.cta_forbidden_fills.includes(String(c).toLowerCase()),
        );
        if (bad.length)
          tally.cta.push(`${at(n)}: CTA 배경에 ${bad.join(", ")} 사용`);
      }
    }
  }
  return tally;
}

const STRUCTURE_LABELS = {
  layout: "화면 골격(상태바·헤더·탭바·여백)",
  naming: "프레임·레이어 이름 규칙",
  typography: "design.md 타이포 스케일 외",
  radius: "허용 모서리 외 / 버튼 pill 아님",
  touch: "터치 영역·CTA 높이",
  cta: "CTA 배경 액센트 사용",
};

function pushTally(tally, labels, failures) {
  for (const [k, list] of Object.entries(tally)) {
    if (list.length)
      failures.push(
        `${labels[k]} ${list.length}건: ${list.slice(0, 5).join(" / ")}${list.length > 5 ? " …" : ""}`,
      );
  }
}

function concepts(dir) {
  return blocks(
    readText(path.join(dir, "concepts.md")),
    RULES.p3.concept_heading,
  );
}

function checkP3(dir) {
  const r = RULES.p3;
  const failures = [];
  requireFiles(dir, r.files, failures);
  if (failures.length) return { failures };
  checkPlaceholders(dir, r.files, failures);

  const list = concepts(dir);
  if (list.length < r.min_concepts || list.length > r.max_concepts)
    failures.push(
      `시안 ${list.length}개 — ${r.min_concepts}~${r.max_concepts}개 필요`,
    );
  const nodeIds = [];
  for (const c of list) {
    const text = c.heading + "\n" + c.body;
    if (!re(RULES.run.figma_url_pattern.replace("^", "")).test(text))
      failures.push(`시안 ${c.id}: Figma 링크 없음`);
    const m = c.body.match(re("노드 ID\\s*[:：]\\s*" + r.node_id_pattern));
    if (!m) failures.push(`시안 ${c.id}: 노드 ID 없음`);
    else nodeIds.push(normId(m[1]));
  }

  const exp = readJson(
    path.join(dir, "concepts-export.json"),
    failures,
    "concepts-export.json",
  );
  if (exp) {
    const frames = exp.frames ?? [];
    checkFrames(frames, "시안", failures);
    pushTally(checkStructure(frames), STRUCTURE_LABELS, failures);
    const exported = new Set(frames.map((f) => normId(f.id)));
    const notExported = nodeIds.filter((id) => !exported.has(id));
    if (notExported.length)
      failures.push(
        `concepts-export.json에 없는 시안 노드 ${notExported.length}건: ${notExported.join(", ")}`,
      );
  }
  return { failures };
}

function checkP3Approval(dir, slug, state) {
  const r = RULES["p3-approval"];
  const failures = [];
  requireFiles(dir, r.files, failures);
  if (failures.length) return { failures, waiting: true };
  const file = path.join(dir, "approval.md");
  const t = readText(file);
  checkPlaceholders(dir, r.files, failures);

  const result = t.match(re(r.result_pattern))?.[1];
  const approver = t.match(re(r.approver_pattern))?.[1]?.trim();
  const date = t.match(re(r.date_pattern))?.[1];
  if (!result) failures.push("결과(승인/반려) 없음");
  if (!approver) failures.push("승인자 없음");
  if (!date) failures.push("날짜(YYYY-MM-DD) 없음");

  if (result === "반려" && approver && date) {
    // 반려 기록은 보관하고 다음 컨펌을 위해 approval.md 를 비운다.
    const n =
      (state.history ?? []).filter(
        (h) => h.gate === "p3-approval" && h.rejected,
      ).length + 1;
    fs.renameSync(file, path.join(dir, `approval-rejected-${n}.md`));
    return {
      failures: [`내부 컨펌 반려 — approval-rejected-${n}.md로 보관`],
      returnTo: RULES.gates.return_to["p3-approval"],
      rejected: true,
    };
  }
  if (result === "승인") {
    const sel = t.match(re(r.selected_pattern))?.[1];
    if (!sel) failures.push("승인인데 선택 시안 없음");
    else if (!concepts(dir).some((c) => c.id === sel))
      failures.push(`선택 시안 ${sel}이 concepts.md에 없음`);
    else state.selectedConcept = sel;
  }
  return { failures };
}

function checkP4(dir, slug, state) {
  const r = RULES.p4;
  const d = RULES.design;
  const failures = [];
  const stats = { frames: 0, nodes: 0, textNodes: 0 };
  requireFiles(dir, r.files, failures);
  if (failures.length) return { failures, stats };
  checkPlaceholders(
    dir,
    r.files.filter((f) => f.endsWith(".md")),
    failures,
  );

  const build = readText(path.join(dir, "build.md"));
  if (!re(RULES.run.figma_url_pattern.replace("^", "")).test(build))
    failures.push("build.md: Figma 완성본 링크 없음");

  const exp = readJson(
    path.join(dir, "figma-export.json"),
    failures,
    "figma-export.json",
  );
  if (!exp) return { failures, stats };
  const frames = exp.frames ?? [];
  if (!frames.length) failures.push("figma-export.json: 프레임 0개");
  checkFrames(frames, "완성본", failures);

  const palette = new Set(Object.values(d.colors).map((c) => c.toLowerCase()));
  const fonts = new Set(d.allowed_fonts);
  const spacing = new Set(d.spacing);
  const tally = { font: [], color: [], spacing: [], shadow: [], privacy: [] };
  const privacy = Object.entries(RULES.privacy.patterns).map(([k, src]) => [
    k,
    re(src),
  ]);
  const scanText = (where, text) => {
    for (const [k, rx] of privacy)
      if (rx.test(text)) tally.privacy.push(`${where}: ${k}`);
    for (const kw of RULES.privacy.banned_keywords)
      if (text.toLowerCase().includes(kw.toLowerCase()))
        tally.privacy.push(`${where}: 금지 키워드 "${kw}"`);
  };

  for (const f of frames) {
    stats.frames++;
    for (const n of f.nodes ?? []) {
      stats.nodes++;
      if (n.system) continue; // 상태바 등 시스템 인스턴스는 색·서체 검사 제외
      const where = `"${n.name}"(${n.id})`;
      for (const fam of n.fontFamilies ?? [])
        if (!fonts.has(fam)) tally.font.push(`${where}: ${fam}`);
      for (const c of [...(n.fills ?? []), ...(n.strokes ?? [])])
        if (!palette.has(String(c).toLowerCase()))
          tally.color.push(`${where}: ${c}`);
      for (const e of n.effects ?? [])
        if (d.forbidden_effects.includes(e))
          tally.shadow.push(`${where}: ${e}`);
      const sp = [n.itemSpacing, ...(n.padding ?? [])].filter(
        (x) => typeof x === "number",
      );
      for (const x of sp)
        if (!spacing.has(Math.round(x))) tally.spacing.push(`${where}: ${x}px`);
      if (typeof n.text === "string") {
        stats.textNodes++;
        scanText(where, n.text);
      }
    }
  }
  for (const f of fs
    .readdirSync(dir)
    .filter((x) => x.endsWith(".md") && x !== r.report_file))
    scanText(f, readText(path.join(dir, f)));

  const labels = {
    font: `Pretendard 외 서체`,
    color: `허용 색상 외`,
    spacing: `허용 간격 외`,
    shadow: `그림자 효과`,
    privacy: `★ 개인정보·기밀 패턴`,
  };
  Object.assign(tally, checkStructure(frames, state.selectedConcept));
  pushTally(tally, { ...labels, ...STRUCTURE_LABELS }, failures);
  return { failures, stats, tally };
}

// ─── 명령 ───────────────────────────────────────────────

function cmdInit(slug, args) {
  const dir = runDir(slug);
  const topic = args[args.indexOf("--topic") + 1];
  const figma = args[args.indexOf("--figma") + 1];
  if (!args.includes("--topic") || !topic)
    usage('--topic "<화면 주제>"가 필요해요');
  if (
    !args.includes("--figma") ||
    !figma ||
    !re(RULES.run.figma_url_pattern).test(figma)
  )
    usage(
      "--figma 에 Figma 파일 URL이 필요해요 (https://www.figma.com/design/...)",
    );
  if (fs.existsSync(statePath(slug)))
    usage(`이미 있는 실행이에요: ${slug} — status 로 확인하세요`);
  for (const g of ["p1", "p2", "p3", "p4"])
    fs.mkdirSync(path.join(dir, RULES[g].dir), { recursive: true });
  const state = {
    slug,
    topic,
    figmaFileUrl: figma,
    createdAt: now(),
    updatedAt: now(),
    lastPassed: null,
    next: GATES[0],
    attempts: Object.fromEntries(GATES.map((g) => [g, 0])),
    blocked: false,
    blockedGate: null,
    selectedConcept: null,
    done: false,
    history: [],
  };
  saveState(slug, state);
  console.log(
    `✅ 실행 생성: runs/${slug} (주제: ${topic})\n   다음 게이트: ${state.next}`,
  );
}

function cmdStatus(slug) {
  const s = loadState(slug);
  console.log(
    [
      `주제: ${s.topic}  (runs/${s.slug})`,
      `Figma: ${s.figmaFileUrl}`,
      `마지막 통과: ${s.lastPassed ?? "없음"}  → 다음: ${s.done ? "완료" : s.next}`,
      `선택 시안: ${s.selectedConcept ?? "-"}`,
      `연속 실패: ${GATES.map((g) => `${g}=${s.attempts[g]}`).join(" ")}`,
      s.blocked
        ? `🛑 차단됨: ${s.blockedGate} 게이트 ${RULES.run.max_attempts}회 실패 — 사람 확인 후 unblock 필요`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  process.exit(s.blocked ? 3 : 0);
}

function cmdUnblock(slug) {
  const s = loadState(slug);
  if (!s.blocked) return console.log("차단 상태가 아니에요.");
  s.attempts[s.blockedGate] = 0;
  s.history.push({ gate: s.blockedGate, result: "unblocked", at: now() });
  console.log(`🔓 차단 해제: ${s.blockedGate} (연속 실패 0으로 초기화)`);
  s.blocked = false;
  s.blockedGate = null;
  saveState(slug, s);
}

function writeReport(slug, state, res) {
  const dir = path.join(runDir(slug), RULES.p4.dir);
  const ok = res.failures.length === 0;
  const t = res.tally ?? {};
  const row = (label, k) =>
    `| ${label} | ${t[k]?.length ?? "-"} | ${t[k] && !t[k].length ? "✅" : "❌"} |`;
  const md = [
    `# 검증 리포트 — ${state.topic}`,
    "",
    `- 실행: runs/${slug}`,
    `- 판정 시각: ${now()}`,
    `- 선택 시안: ${state.selectedConcept ?? "-"}`,
    `- 결과: ${ok ? "✅ 통과" : "❌ 실패"}`,
    `- 검사 대상: 프레임 ${res.stats?.frames ?? 0}개 · 노드 ${res.stats?.nodes ?? 0}개 · 텍스트 ${res.stats?.textNodes ?? 0}개`,
    "",
    "| 조건 | 위반 | 판정 |",
    "|---|---|---|",
    row("Pretendard 외 서체", "font"),
    row("허용 색상 외 (rules.yaml design.colors)", "color"),
    row("허용 간격 외 (rules.yaml design.spacing)", "spacing"),
    row("그림자 효과", "shadow"),
    row("★ 개인정보·기밀 패턴", "privacy"),
    ...Object.entries(STRUCTURE_LABELS).map(([k, label]) => row(label, k)),
    "",
    "## 실패 상세",
    "",
    ...(ok ? ["없음"] : res.failures.map((f) => `- ${f}`)),
    "",
    "## 게이트 이력",
    "",
    ...state.history.map(
      (h) =>
        `- ${h.at} · ${h.gate} · ${h.result}${h.returnTo ? ` → ${h.returnTo}` : ""}`,
    ),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, RULES.p4.report_file), md);
}

// 추가 리서치가 끝나 P1을 다시 통과하면, P2의 리서치 요청 파일을 보관 처리해 P2가 다시 진행되게 한다.
function archiveNeedsResearch(slug) {
  const dir = path.join(runDir(slug), RULES.p2.dir);
  const file = path.join(dir, RULES.p2.needs_research_file);
  if (!fs.existsSync(file)) return;
  let n = 1;
  while (fs.existsSync(path.join(dir, `needs-research-resolved-${n}.md`))) n++;
  fs.renameSync(file, path.join(dir, `needs-research-resolved-${n}.md`));
}

function cmdGate(gate, slug) {
  const s = loadState(slug);
  if (s.blocked) {
    console.error(
      `🛑 차단됨: ${s.blockedGate} 게이트 ${RULES.run.max_attempts}회 실패. 사람 확인 후 'unblock ${slug}' 하세요.`,
    );
    process.exit(3);
  }
  if (s.done) usage("이미 완료된 실행이에요.");
  if (s.next !== gate)
    usage(`지금 판정할 게이트는 ${s.next}예요 (요청: ${gate})`);

  const dir = path.join(runDir(slug), RULES[gate].dir);
  const checks = {
    p1: checkP1,
    p2: checkP2,
    p3: checkP3,
    "p3-approval": checkP3Approval,
    p4: checkP4,
  };
  const res = checks[gate](dir, slug, s);

  if (res.waiting) {
    console.log(
      `⏳ ${gate}: 사람의 컨펌 대기 중 — ${RULES["p3-approval"].dir}/approval.md 가 아직 없어요.`,
    );
    process.exit(1);
  }

  const idx = GATES.indexOf(gate);
  if (!res.failures.length) {
    s.attempts[gate] = 0;
    s.lastPassed = gate;
    s.next = GATES[idx + 1] ?? null;
    s.done = s.next === null;
    s.history.push({ gate, result: "pass", at: now() });
    if (gate === "p1") archiveNeedsResearch(slug);
    if (gate === "p4") writeReport(slug, s, res);
    saveState(slug, s);
    console.log(
      `✅ ${gate} 통과 → ${s.done ? "완료! verify-report.md 를 확인하세요" : `다음: ${s.next}`}`,
    );
    process.exit(0);
  }

  s.attempts[gate] += 1;
  const returnTo = res.returnTo ?? RULES.gates.return_to[gate];
  const entry = {
    gate,
    result: "fail",
    at: now(),
    failures: res.failures,
    returnTo,
  };
  if (res.rejected) entry.rejected = true;
  s.history.push(entry);
  const rIdx = GATES.indexOf(returnTo);
  s.next = returnTo;
  s.lastPassed = rIdx > 0 ? GATES[rIdx - 1] : null;
  if (s.attempts[gate] >= RULES.run.max_attempts) {
    s.blocked = true;
    s.blockedGate = gate;
  }
  if (gate === "p4") writeReport(slug, s, res);
  saveState(slug, s);

  console.log(
    `❌ ${gate} 실패 (${res.failures.length}개 조건) — 연속 실패 ${s.attempts[gate]}/${RULES.run.max_attempts}`,
  );
  for (const f of res.failures) console.log(`   - ${f}`);
  if (s.blocked) {
    console.log(
      `🛑 ${gate} 게이트 ${RULES.run.max_attempts}회 실패 — 멈추고 사람에게 보고하세요.`,
    );
    process.exit(3);
  }
  console.log(`↩️  복귀: ${returnTo}`);
  process.exit(1);
}

// ─── 진입점 ─────────────────────────────────────────────

const [cmd, slug, ...rest] = process.argv.slice(2);
if (!cmd) usage();
if (cmd === "init") cmdInit(slug, rest);
else if (cmd === "status") cmdStatus(slug);
else if (cmd === "unblock") cmdUnblock(slug);
else if (GATES.includes(cmd)) cmdGate(cmd, slug);
else usage(`알 수 없는 명령: ${cmd}`);
