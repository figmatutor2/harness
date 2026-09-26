// Figma 노드 정보 내보내기 — use_figma(Plugin API)로 실행하는 코드 본문
// P3: concepts-export.json · P4: figma-export.json 을 만들 때 쓴다.
// 반드시 /figma-use 스킬을 먼저 불러온 뒤 use_figma 로 실행할 것.
//
// 사용법: 아래 FRAME_IDS 에 내보낼 최상위 프레임 노드 ID를 넣고 실행한다.
// 반환된 JSON 을 그대로 해당 Phase 폴더의 파일로 저장한다. (값을 손으로 고치지 말 것)

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

  if ("fills" in node) o.fills = solidPaints(node.fills);
  if ("strokes" in node) o.strokes = solidPaints(node.strokes);
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
    if (node.fills === figma.mixed)
      o.fills = [...new Set(seg.flatMap((s) => solidPaints(s.fills)))];
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
    width: frame.width,
    height: frame.height,
    nodes,
  });
}

return { fileKey: figma.fileKey, exportedAt: new Date().toISOString(), frames };
