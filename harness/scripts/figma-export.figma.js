// Figma 노드 정보 내보내기 — use_figma(Plugin API)로 실행하는 코드 본문
// P3: concepts-export.json · P4: system-export.json · P5: flow-export.json 을 만들 때 쓴다.
// 반드시 /figma-use 스킬을 먼저 불러온 뒤 use_figma 로 실행할 것.
//
// 사용법: 아래 FRAME_IDS 에 내보낼 최상위 프레임 노드 ID를 넣고 실행한다.
// 반환된 JSON 을 그대로 해당 Phase 폴더의 파일로 저장한다. (값을 손으로 고치지 말 것)
//
// MODE
//   "export" — 작업 에이전트용. 노드 정보 JSON 전체를 돌려준다.
//   "digest" — judge 전용. 같은 순회 결과를 지문 한 줄("<해시>-<노드 수>")로만 돌려준다.
//              FRAME_IDS 는 `verify.mjs figma-ids <gate> <slug>` 출력 순서 그대로 넣는다.
//              digest 모드는 노드를 읽기만 한다 (judge 의 use_figma 는 이 모드만 허용됨).

const MODE = "export";
const FRAME_IDS = ["__FRAME_ID__"]; // 예: ["123:456", "123:789"]

// harness/rules.yaml template.system_instances 와 같게 유지한다.
// 이 컴포넌트의 인스턴스는 내부를 내보내지 않는다 (SF 서체·#000000 등 시스템 값).
const SYSTEM_INSTANCES = ["Status bar - iPhone 17 Pro"];

const toHex = (c) =>
  "#" +
  [c.r, c.g, c.b]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");

// 보이는 SOLID 페인트만 수집한다. 이미지 fill(콘텐츠)은 색상 검사 대상이 아니다.
function solidPaints(paints) {
  if (!paints || paints === figma.mixed) return [];
  return paints
    .filter((p) => p.visible !== false && p.type === "SOLID")
    .map((p) => toHex(p.color));
}

// 색 페인트에 연결된 변수 → "컬렉션:변수이름" (연결 없으면 null). 순서는 solidPaints 와 같다.
// verify.mjs 가 rules.yaml design.color_variables 로 검사한다 (Semantic 변수만 허용).
const varCache = new Map();
async function varLabel(id) {
  if (!varCache.has(id)) {
    const v = await figma.variables.getVariableByIdAsync(id);
    const c = v
      ? await figma.variables.getVariableCollectionByIdAsync(
          v.variableCollectionId,
        )
      : null;
    varCache.set(id, v ? `${c ? c.name : "?"}:${v.name}` : "?:?");
  }
  return varCache.get(id);
}
async function solidVars(paints) {
  if (!paints || paints === figma.mixed) return [];
  const out = [];
  for (const p of paints) {
    if (p.visible === false || p.type !== "SOLID") continue;
    const alias = p.boundVariables && p.boundVariables.color;
    out.push(alias ? await varLabel(alias.id) : null);
  }
  return out;
}

function radiusOf(node) {
  if (!("cornerRadius" in node)) return undefined;
  const r =
    node.cornerRadius === figma.mixed
      ? [
          node.topLeftRadius,
          node.topRightRadius,
          node.bottomRightRadius,
          node.bottomLeftRadius,
        ]
      : [node.cornerRadius];
  return [...new Set(r)].filter((v) => v > 0);
}

function box(node, origin) {
  const b = node.absoluteBoundingBox;
  if (!b) return {};
  return {
    x: Math.round(b.x - origin.x),
    y: Math.round(b.y - origin.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
  };
}

// 값이 있는데 Figma 변수에 연결되지 않은 속성 목록 (P4 게이트: 변수 미연결 0건)
function unboundProps(node, o) {
  const bv = node.boundVariables || {};
  const out = [];
  if (
    (o.fills || []).length &&
    node.fills !== figma.mixed &&
    !(bv.fills && bv.fills.length)
  )
    out.push("fills");
  if ((o.strokes || []).length && !(bv.strokes && bv.strokes.length))
    out.push("strokes");
  if (
    typeof o.itemSpacing === "number" &&
    o.itemSpacing !== 0 &&
    !bv.itemSpacing
  )
    out.push("itemSpacing");
  for (const k of [
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
  ])
    if (typeof node[k] === "number" && node[k] !== 0 && !bv[k]) out.push(k);
  const rk = [
    "topLeftRadius",
    "topRightRadius",
    "bottomRightRadius",
    "bottomLeftRadius",
  ];
  if ((o.radius || []).length && !rk.some((k) => bv[k]) && !bv.cornerRadius)
    out.push("radius");
  return out;
}

async function walk(node, origin, out) {
  if (node.visible === false) return;
  const o = {
    id: node.id,
    name: node.name,
    type: node.type,
    ...box(node, origin),
  };

  if (node.type === "INSTANCE") {
    const main = await node.getMainComponentAsync();
    const setName =
      main && main.parent && main.parent.type === "COMPONENT_SET"
        ? main.parent.name
        : null;
    o.componentName = setName || (main ? main.name : null);
    if (
      SYSTEM_INSTANCES.includes(o.componentName) ||
      SYSTEM_INSTANCES.includes(node.name)
    ) {
      o.system = true;
      out.push(o);
      return; // 시스템 인스턴스 내부는 내보내지 않는다
    }
  }

  if ("fills" in node) {
    o.fills = solidPaints(node.fills);
    o.fillVars = await solidVars(node.fills);
  }
  if ("strokes" in node) {
    o.strokes = solidPaints(node.strokes);
    o.strokeVars = await solidVars(node.strokes);
  }
  if ("effects" in node)
    o.effects = node.effects
      .filter((e) => e.visible !== false)
      .map((e) => e.type);
  const r = radiusOf(node);
  if (r && r.length) o.radius = r;

  if (node.type === "TEXT") {
    o.text = node.characters;
    const seg = node.getStyledTextSegments([
      "fontName",
      "fontSize",
      "fontWeight",
      "fills",
    ]);
    o.fontFamilies = [...new Set(seg.map((s) => s.fontName.family))];
    o.fontSizes = [...new Set(seg.map((s) => s.fontSize))];
    o.fontWeights = [...new Set(seg.map((s) => s.fontWeight))];
    if (node.fills === figma.mixed) {
      // 글자 구간마다 색이 다르면 [색, 변수] 쌍으로 모아 중복만 없앤다
      const pairs = new Map();
      for (const s of seg) {
        const hex = solidPaints(s.fills);
        const vars = await solidVars(s.fills);
        hex.forEach((h, i) => pairs.set(`${h}|${vars[i]}`, [h, vars[i]]));
      }
      o.fills = [...pairs.values()].map(([h]) => h);
      o.fillVars = [...pairs.values()].map(([, v]) => v);
    }
  }

  if ("layoutMode" in node && node.layoutMode !== "NONE") {
    o.itemSpacing = node.itemSpacing;
    o.padding = [
      node.paddingTop,
      node.paddingRight,
      node.paddingBottom,
      node.paddingLeft,
    ];
  }
  const ub = unboundProps(node, o);
  if (ub.length) o.unbound = ub;
  out.push(o);
  if ("children" in node)
    for (const child of node.children) await walk(child, origin, out);
}

const frames = [];
for (const id of FRAME_IDS) {
  const frame = await figma.getNodeByIdAsync(id);
  if (!frame) throw new Error(`노드를 찾을 수 없음: ${id}`);
  const origin = frame.absoluteBoundingBox;
  const nodes = [];
  await walk(frame, origin, nodes);
  frames.push({
    id: frame.id,
    name: frame.name,
    type: frame.type,
    width: frame.width,
    height: frame.height,
    nodes,
  });
}

// cyrb53 — harness/scripts/verify.mjs 의 같은 함수와 글자까지 같아야 한다
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

if (MODE === "digest") {
  const count = frames.reduce((a, f) => a + f.nodes.length, 0);
  const hash = cyrb53(figma.fileKey + "\n" + JSON.stringify(frames));
  return { fileKey: figma.fileKey, digest: `${hash}-${count}` };
}

return { fileKey: figma.fileKey, exportedAt: new Date().toISOString(), frames };
