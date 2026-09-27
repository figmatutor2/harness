# 시스템 확장 — {{화면 주제}}

> P4 · builder 작성. 입력: p2-spec/screen-spec.md "화면 목록"(S1~Sn 전체), p3-concept/approval.md(선택 시안), design.md, harness/rules.yaml
> 규칙: `### C<번호>. <Figma 컴포넌트 이름>` 제목 1개 = 컴포넌트 1개. 제목의 이름은 Figma 컴포넌트(또는 컴포넌트 세트) 이름과 **똑같이** 씁니다.
> system-export.json 에는 이 목록의 컴포넌트를 루트로 내보냅니다. 컴포넌트 안의 색·간격·모서리는 모두 변수에 연결되어야 합니다.

## Figma

- 페이지: {{P4 · 화면 주제 · 시스템}}
- 링크: {{https://www.figma.com/design/<fileKey>/...?node-id=<id>}}

## 토큰 확장

| 컬렉션 / 스타일    | 추가·변경              | 이유(사용 화면) |
| ------------------ | ---------------------- | --------------- |
| {{harness/colors}} | {{재사용 / 추가 없음}} | {{...}}         |

## 컴포넌트

### C1. {{컴포넌트 이름}}

- 노드 ID: {{9:27}}
- 속성(variant): {{State=Selected/Default}}
- 사용 화면: {{S1, S2}}
- 새로 만듦 / 재사용: {{...}}
