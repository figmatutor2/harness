#!/usr/bin/env node
// 허들링 디자인 하네스 — 게이트 판정 스크립트
// 기준: harness/rules.yaml (SSOT). state.json 과 verify-report.md 는 이 스크립트만 쓴다.
//
// 사용법
//   node harness/scripts/verify.mjs init <slug> --topic "<화면 주제>" --figma <Figma 파일 URL>
//   node harness/scripts/verify.mjs <p1|p2|p3-approval> <slug>
//   node harness/scripts/verify.mjs <p3|p4|p5> <slug> --figma-digest <지문>   # judge 가 Figma 에서 받은 지문
//   node harness/scripts/verify.mjs figma-ids <p3|p4|p5> <slug>               # 지문을 받을 fileKey·프레임 ID 출력
//   node harness/scripts/verify.mjs status <slug>
//   node harness/scripts/verify.mjs unblock <slug>        # 3회 실패 차단 해제 (사람이 실행)
//   node harness/scripts/verify.mjs reopen <slug> --from <gate>  # 특정 게이트부터 다시 열기 (산출물 유지)
//
// 종료 코드: 0 통과 · 1 실패 · 2 사용법/전제 오류 · 3 차단(같은 게이트 3회 실패)

import crypto from "node:crypto";
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
    '사용법: verify.mjs init <slug> --topic "<주제>" --figma <URL> | <p1|p2|p3-approval> <slug> | <p3|p4|p5> <slug> --figma-digest <지문> | figma-ids <p3|p4|p5> <slug> | status <slug> | unblock <slug> | reopen <slug> --from <gate>',
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

const sha = (text) =>
  crypto
    .createHash("sha256")
    .update(text ?? "")
    .digest("hex");

// cyrb53 — figma-export.figma.js 의 같은 함수와 글자까지 같아야 한다 (Figma 안에는 crypto 가 없음)
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0))
    .toString(16)
    .padStart(14, "0");
}

// export JSON 의 지문 = "<cyrb53(fileKey + frames JSON)>-<노드 수>" (Figma 쪽 digest 모드와 같은 계산)
function figmaDigest(fileKey, frames) {
  const nodes = frames.reduce((a, f) => a + (f.nodes ?? []).length, 0);
  return `${cyrb53(fileKey + "\n" + JSON.stringify(frames))}-${nodes}`;
}

const fileKeyOf = (url) =>
  String(url).match(/figma\.com\/(?:design|file)\/([A-Za-z0-9]+)/)?.[1] ?? null;

// judge 가 Figma 에서 받은 지문과 export JSON 을 대조한다 (rules.yaml figma_check)
function checkFigmaDigest(exp, file, state, digest, failures) {
  const key = fileKeyOf(state.figmaFileUrl);
  if (exp.fileKey !== key) {
    failures.push(
      `${file}: 다른 Figma 파일에서 내보냄 (export ${exp.fileKey ?? "-"} / 실행 ${key})`,
    );
    return;
  }
  const mine = figmaDigest(key, exp.frames ?? []);
  if (mine !== digest)
    failures.push(
      `Figma 실제 상태와 ${file} 불일치 (노드 수: Figma ${digest.split("-")[1]} / export ${mine.split("-")[1]}) — figma-export.figma.js 로 다시 내보내 수정 없이 저장하세요`,
    );
}

// 컨펌 잠금 대상 파일(rules.yaml p3-approval.lock_files + approval.md)의 현재 해시
function lockHashes(slug) {
  const r = RULES["p3-approval"];
  const files = Object.fromEntries(
    r.lock_files.map((f) => [f, sha(readText(path.join(runDir(slug), f)))]),
  );
  const approval = sha(readText(path.join(runDir(slug), r.dir, "approval.md")));
  return { files, approval };
}

// 잠금 기록과 달라진 파일 목록. 기록이 없으면 null
function lockChanges(slug, lock) {
  if (!lock) return null;
  const cur = lockHashes(slug);
  const changed = Object.keys(lock.files).filter(
    (f) => cur.files[f] !== lock.files[f],
  );
  if (cur.approval !== lock.approval) changed.push("p3-concept/approval.md");
  return changed;
}

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

  // 화면 목록 (P5 커버리지의 기준)
  const sl = r.screen_list;
  const screens = screenList(spec);
  if (screens.length < sl.min_screens)
    failures.push(
      `화면 목록 ${screens.length}개 — 최소 ${sl.min_screens}개 필요`,
    );
  const keys = screens.filter((x) => x.kind.includes(sl.key_label));
  if (keys.length !== sl.key_screens)
    failures.push(
      `키스크린 ${keys.length}개 — 정확히 ${sl.key_screens}개 필요`,
    );
  const names = screens.map((x) => x.name);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) failures.push(`화면명 중복: ${[...new Set(dup)].join(", ")}`);

  // ★ 검사는 실제 항목이 적히는 칸(trigger_scopes)에서만 켠다
  const scoped = scopedRows(spec, r.trigger_scopes);
  const hit = (keywords) =>
    scoped.filter((row) => keywords.some((k) => row.cells.includes(k)));

  // ★ 어기면 안 되는 것 1 — 기본 비공개
  const v = r.visibility;
  const visRows = hit(v.trigger_keywords);
  if (visRows.length) {
    const forbidden = visRows.filter(
      (row) =>
        re(v.forbidden_default_pattern).test(row.line) &&
        !re(v.required_default_pattern).test(row.line),
    );
    if (forbidden.length)
      failures.push(`★ 공개 범위 기본값이 비공개가 아님 ${forbidden.length}건`);
    else if (
      !visRows.some((row) => re(v.required_default_pattern).test(row.line))
    )
      failures.push('★ 공개 범위가 있는데 "기본값: 비공개" 명시 없음');
  }

  // ★ 어기면 안 되는 것 2 — 판매 신청은 검수를 거친다
  const sr = r.sale_review;
  if (hit(sr.trigger_keywords).length) {
    const stateSec = section(spec, "상태") ?? "";
    const miss = sr.required_state_keywords.filter(
      (k) => !stateSec.includes(k),
    );
    if (miss.length)
      failures.push(`★ 판매 신청 흐름에 필수 상태 누락: ${miss.join(", ")}`);
    const skip = spec.match(re(sr.forbidden_transition_pattern, "g"));
    if (skip)
      failures.push(`★ 검수 없이 판매로 넘어가는 흐름 ${skip.length}건`);
  }
  return { failures };
}

// 설계 문서의 "## 화면 목록" 표 → [{ id, name, kind }]
function screenList(spec) {
  const sl = RULES.p2.screen_list;
  const body = section(spec, sl.section) ?? "";
  return [...body.matchAll(re(sl.row_pattern, "gm"))].map((m) => ({
    id: m[1],
    name: m[2].trim(),
    kind: m[3].trim(),
  }));
}

function readSpec(slug) {
  const t =
    readText(path.join(runDir(slug), RULES.p2.dir, "screen-spec.md")) ?? "";
  return t.replace(/<!--[\s\S]*?-->/g, "");
}

// trigger_scopes 에 지정한 섹션·열만 모은다. row.cells = 검사 대상 칸, row.line = 원래 줄
function scopedRows(spec, scopes) {
  const out = [];
  for (const sc of scopes) {
    const body = section(spec, sc.section) ?? "";
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      if (sc.lines) {
        out.push({ cells: t, line: t });
        continue;
      }
      if (!t.startsWith("|") || /^\|[\s:|-]+\|$/.test(t)) continue; // 표 줄만, 구분선 제외
      const cells = t
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      out.push({
        cells: sc.columns.map((i) => cells[i - 1] ?? "").join(" | "),
        line: t,
      });
    }
  }
  return out;
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

// 화면 템플릿 규칙 (rules.yaml template + design.typography/radius) — P3·P5 공통
// expectLetter 가 있으면 프레임의 시안 문자가 그 값과 같아야 한다 (P5 = 선택 시안).
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

function checkP3(dir, slug, state, ctx) {
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
    checkFigmaDigest(exp, "concepts-export.json", state, ctx.digest, failures);
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

  // 컨펌 잠금 — 예전에 통과한 approval.md 가 그대로인데 설계·시안이 바뀌었으면 그 컨펌은 무효
  //   · state.approval 기록이 있으면: 같은 approval.md 인지 + lock_files 가 그대로인지 비교
  //   · 기록 키 자체가 없는 예전 실행(잠금 도입 전)에서 이미 컨펌을 통과했다면: 확인할 수 없으므로 무효
  const lock = state.approval;
  const legacy =
    !("approval" in state) &&
    (state.history ?? []).some(
      (h) => h.gate === "p3-approval" && h.result === "pass",
    );
  const changed =
    lock && sha(t) === lock.approval
      ? lockChanges(slug, lock).filter((f) => !f.endsWith("approval.md"))
      : [];
  if (legacy || changed.length) {
    let n = 1;
    while (fs.existsSync(path.join(dir, `${r.stale_prefix}-${n}.md`))) n++;
    const archived = `${r.stale_prefix}-${n}.md`;
    fs.renameSync(file, path.join(dir, archived));
    const why = legacy
      ? "컨펌 잠금 도입 전의 컨펌이라 설계·시안과 맞는지 확인할 수 없음"
      : `컨펌 뒤 바뀐 파일: ${changed.join(", ")}`;
    return {
      waiting: true,
      stale: { archived, why },
      message: `⏳ p3-approval: 기존 컨펌 무효 (${why}) — ${archived} 로 보관했어요. 현재 설계·시안으로 다시 컨펌받아 approval.md 를 작성해 주세요.`,
    };
  }

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

const DESIGN_LABELS = {
  font: `Pretendard 외 서체`,
  color: `허용 색상 외`,
  spacing: `허용 간격 외`,
  shadow: `그림자 효과`,
  privacy: `★ 개인정보·기밀 패턴`,
};

// 서체·색·간격·그림자·개인정보 — P4 컴포넌트와 P5 화면 공통
function designTally(frames, dir, reportFile, stats) {
  const d = RULES.design;
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
    .filter((x) => x.endsWith(".md") && x !== reportFile))
    scanText(f, readText(path.join(dir, f)));
  return tally;
}

// P4 시스템 확장 — system.md 의 컴포넌트가 모두 내보내졌고, 스타일 규칙·변수 연결을 지키는지
function checkP4(dir, slug, state, ctx) {
  const r = RULES.p4;
  const d = RULES.design;
  const failures = [];
  const stats = { frames: 0, nodes: 0, textNodes: 0 };
  requireFiles(dir, r.files, failures);
  if (failures.length) return { failures };
  checkPlaceholders(dir, r.files, failures);

  const doc = readText(path.join(dir, "system.md"));
  if (!re(RULES.run.figma_url_pattern.replace("^", "")).test(doc))
    failures.push("system.md: Figma 링크 없음");
  const listed = blocks(doc, r.component_heading).map((b) =>
    b.heading.match(re(r.component_heading))[2].trim(),
  );
  if (listed.length < r.min_components)
    failures.push(
      `컴포넌트 ${listed.length}개 — 최소 ${r.min_components}개 필요`,
    );

  const exp = readJson(
    path.join(dir, "system-export.json"),
    failures,
    "system-export.json",
  );
  if (!exp) return { failures };
  checkFigmaDigest(exp, "system-export.json", state, ctx.digest, failures);
  const roots = exp.frames ?? [];
  const exported = new Set(
    roots
      .filter((f) => /^COMPONENT(_SET)?$/.test(f.type ?? ""))
      .map((f) => f.name),
  );
  const missing = listed.filter((n) => !exported.has(n));
  if (missing.length)
    failures.push(
      `system-export.json에 없는 컴포넌트 ${missing.length}건: ${missing.join(", ")}`,
    );

  const tally = designTally(roots, dir, null, stats);
  const typo = new Set(d.typography.map(([sz, w]) => `${sz}/${w}`));
  const radius = new Set(d.radius);
  tally.typography = [];
  tally.radius = [];
  tally.unbound = [];
  for (const f of roots)
    for (const n of f.nodes ?? []) {
      if (n.system) continue;
      const at = `"${n.name}"(${n.id})`;
      for (const w of n.fontWeights ?? []) {
        if (d.forbidden_weights.includes(w))
          tally.typography.push(`${at}: 굵기 ${w} 금지`);
        for (const sz of n.fontSizes ?? [])
          if (!typo.has(`${sz}/${w}`))
            tally.typography.push(`${at}: ${sz}px/${w}`);
      }
      for (const rv of n.radius ?? [])
        if (!radius.has(rv)) tally.radius.push(`${at}: 모서리 ${rv}`);
      if (r.require_bound_variables && (n.unbound ?? []).length)
        tally.unbound.push(`${at}: ${n.unbound.join(", ")}`);
    }
  pushTally(
    tally,
    {
      ...DESIGN_LABELS,
      typography: "design.md 타이포 스케일 외",
      radius: "허용 모서리 외",
      unbound: "변수 미연결 값",
    },
    failures,
  );
  return { failures, stats, tally };
}

// P5 유저 플로우 화면 — 화면 목록 S1~Sn ↔ 프레임 1:1 + 디자인·골격 검사 전부
function checkP5(dir, slug, state, ctx) {
  const r = RULES.p5;
  const failures = [];
  const stats = { frames: 0, nodes: 0, textNodes: 0 };
  requireFiles(dir, r.files, failures);
  if (failures.length) return { failures, stats };
  checkPlaceholders(dir, r.files, failures);

  const doc = readText(path.join(dir, "flow.md"));
  if (!re(RULES.run.figma_url_pattern.replace("^", "")).test(doc))
    failures.push("flow.md: Figma 링크 없음");

  const exp = readJson(
    path.join(dir, "flow-export.json"),
    failures,
    "flow-export.json",
  );
  if (!exp) return { failures, stats };
  checkFigmaDigest(exp, "flow-export.json", state, ctx.digest, failures);
  const frames = exp.frames ?? [];
  if (!frames.length) failures.push("flow-export.json: 프레임 0개");
  checkFrames(frames, "플로우", failures);

  // 커버리지: 화면 목록의 각 화면 = "<선택 시안> · <화면명>" 프레임 1개
  const L = state.selectedConcept;
  const screens = screenList(readSpec(slug));
  const frameNames = frames.map((f) => String(f.name));
  const coverage = [];
  if (!screens.length) coverage.push("p2 화면 목록을 읽지 못함");
  for (const sc of screens) {
    const n = frameNames.filter((fn) => fn === `${L} · ${sc.name}`).length;
    if (n !== 1)
      coverage.push(
        `S${sc.id} "${sc.name}": 프레임 ${n}개 (정확히 1개 필요 — 이름 "${L} · ${sc.name}")`,
      );
  }
  const expected = new Set(screens.map((sc) => `${L} · ${sc.name}`));
  for (const fn of frameNames)
    if (!expected.has(fn)) coverage.push(`화면 목록에 없는 프레임: "${fn}"`);

  const tally = {
    coverage,
    ...designTally(frames, dir, r.report_file, stats),
    ...checkStructure(frames, L),
  };
  pushTally(
    tally,
    { coverage: "화면 목록 커버리지", ...DESIGN_LABELS, ...STRUCTURE_LABELS },
    failures,
  );
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
  for (const g of ["p1", "p2", "p3", "p4", "p5"])
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
    approval: null, // 컨펌 잠금 기록 (p3-approval 통과 시 해시 저장)
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
      `컨펌 잠금: ${s.approval ? `있음 (${s.approval.at})` : "없음"}`,
      `연속 실패: ${GATES.map((g) => `${g}=${s.attempts[g] ?? 0}`).join(" ")}`,
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
  const dir = path.join(runDir(slug), RULES.p5.dir);
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
    row("화면 목록 커버리지 (p2 화면 목록 ↔ 프레임)", "coverage"),
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
  fs.writeFileSync(path.join(dir, RULES.p5.report_file), md);
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

function cmdGate(gate, slug, args) {
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
    p5: checkP5,
  };
  // Figma 대조: export 파일이 있으면 judge 가 받은 지문이 반드시 있어야 한다 (없으면 판정하지 않음)
  const fc = RULES.figma_check;
  const ctx = {};
  if (fc.gates.includes(gate)) {
    const i = args.indexOf("--figma-digest");
    ctx.digest = i >= 0 ? args[i + 1] : undefined;
    if (ctx.digest !== undefined && !re(fc.digest_pattern).test(ctx.digest))
      usage(`--figma-digest 형식이 아니에요: ${ctx.digest}`);
    if (!ctx.digest && fs.existsSync(path.join(dir, fc.export_files[gate])))
      usage(
        `${gate} 는 Figma 대조 지문이 필요해요 — figma-ids ${gate} ${slug} → use_figma(MODE="digest") → --figma-digest <지문>`,
      );
  }

  // 컨펌 잠금: P4·P5 는 승인받은 설계·시안·컨펌이 그대로일 때만 판정한다
  const lockGates = RULES["p3-approval"].lock_check_gates;
  let res;
  const changed = lockGates.includes(gate) ? lockChanges(slug, s.approval) : [];
  if (changed === null || changed.length)
    res = {
      failures: [
        changed === null
          ? "컨펌 잠금 기록 없음 — 현재 설계·시안으로 받은 컨펌인지 확인할 수 없음"
          : `컨펌 뒤 바뀐 파일: ${changed.join(", ")} — 승인받은 상태와 다름`,
      ],
      returnTo: RULES.gates.return_to.approval_lock,
      lock: true, // 산출물 문제가 아니라 컨펌 상태 문제 → 연속 실패 횟수에 넣지 않음
    };
  else res = checks[gate](dir, slug, s, ctx);

  if (res.waiting) {
    if (res.stale) {
      s.approval = null; // 잠금 해제 — 다음 approval.md 는 새 컨펌으로 판정
      s.history.push({
        gate,
        result: "stale",
        at: now(),
        archived: res.stale.archived,
        reason: res.stale.why,
      });
      saveState(slug, s);
    }
    console.log(
      res.message ??
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
    if (gate === "p3-approval") s.approval = { ...lockHashes(slug), at: now() }; // 컨펌 잠금
    if (gate === "p5") writeReport(slug, s, res);
    saveState(slug, s);
    console.log(
      `✅ ${gate} 통과 → ${s.done ? "완료! verify-report.md 를 확인하세요" : `다음: ${s.next}`}`,
    );
    process.exit(0);
  }

  if (!res.lock) s.attempts[gate] = (s.attempts[gate] ?? 0) + 1;
  const returnTo = res.returnTo ?? RULES.gates.return_to[gate];
  const entry = {
    gate,
    result: "fail",
    at: now(),
    failures: res.failures,
    returnTo,
  };
  if (res.rejected) entry.rejected = true;
  if (res.lock) entry.lock = true;
  s.history.push(entry);
  const rIdx = GATES.indexOf(returnTo);
  s.next = returnTo;
  s.lastPassed = rIdx > 0 ? GATES[rIdx - 1] : null;
  if (s.attempts[gate] >= RULES.run.max_attempts) {
    s.blocked = true;
    s.blockedGate = gate;
  }
  if (gate === "p5") writeReport(slug, s, res);
  saveState(slug, s);

  console.log(
    `❌ ${gate} 실패 (${res.failures.length}개 조건) — 연속 실패 ${s.attempts[gate]}/${RULES.run.max_attempts}${res.lock ? " (컨펌 잠금 실패는 횟수에 넣지 않음)" : ""}`,
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

// judge 가 Figma 지문(use_figma MODE="digest")을 받을 때 쓸 fileKey 와 프레임 ID (export 순서 그대로)
function cmdFigmaIds(gate, slug) {
  const fc = RULES.figma_check;
  if (!fc.gates.includes(gate))
    usage(`figma-ids 는 ${fc.gates.join(" | ")} 게이트에만 써요`);
  const s = loadState(slug);
  const file = path.join(runDir(slug), RULES[gate].dir, fc.export_files[gate]);
  const failures = [];
  const exp = readJson(file, failures, fc.export_files[gate]);
  if (!exp) usage(failures[0] ?? `${fc.export_files[gate]} 이 없어요`);
  console.log(
    JSON.stringify({
      fileKey: fileKeyOf(s.figmaFileUrl),
      frameIds: (exp.frames ?? []).map((f) => f.id),
    }),
  );
}

// 완료되었거나 진행 중인 실행을 특정 게이트부터 다시 연다. 산출물 파일은 지우지 않는다.
function cmdReopen(slug, args) {
  const from = args[args.indexOf("--from") + 1];
  if (!args.includes("--from") || !GATES.includes(from))
    usage(`--from 에 게이트 이름이 필요해요 (${GATES.join(" | ")})`);
  const s = loadState(slug);
  const idx = GATES.indexOf(from);
  for (const g of GATES) if (s.attempts[g] === undefined) s.attempts[g] = 0; // 게이트 추가 이전 실행 호환
  for (const g of GATES.slice(idx)) s.attempts[g] = 0;
  for (const g of ["p1", "p2", "p3", "p4", "p5"])
    fs.mkdirSync(path.join(runDir(slug), RULES[g].dir), { recursive: true });
  s.next = from;
  s.lastPassed = idx > 0 ? GATES[idx - 1] : null;
  s.done = false;
  s.blocked = false;
  s.blockedGate = null;
  s.history.push({ gate: from, result: "reopened", at: now() });
  saveState(slug, s);
  console.log(`🔁 다시 열림: runs/${slug} → 다음 게이트 ${from}`);
}

// ─── 진입점 ─────────────────────────────────────────────

const [cmd, slug, ...rest] = process.argv.slice(2);
if (!cmd) usage();
if (cmd === "init") cmdInit(slug, rest);
else if (cmd === "status") cmdStatus(slug);
else if (cmd === "unblock") cmdUnblock(slug);
else if (cmd === "reopen") cmdReopen(slug, rest);
else if (cmd === "figma-ids")
  cmdFigmaIds(slug, rest[0]); // figma-ids <gate> <slug>
else if (GATES.includes(cmd)) cmdGate(cmd, slug, rest);
else usage(`알 수 없는 명령: ${cmd}`);
