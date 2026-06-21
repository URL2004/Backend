# engine/experimental — 파킹된 실험 (런타임 미연결)

이 폴더의 모듈은 **프로덕션 생성 루프에 연결되어 있지 않다**(런타임 0참조, dev 도구에서만 호출).
삭제하지 말고 보존 — 향후 재개를 위한 파킹.

## copykiller 프록시 rerank 실험 (2026-06, `gp-proxy-rerank-experiment`)
- `mutation-lattice.js` — 카피킬러 프록시 기반 후보 rerank(N변형 생성→최저위험 선택). 미배포.
- `mutators.js` — 결정론 변형 연산(rerank 후보 생성용).
- `fidelity-guard.js` — 변형 충실도 가드(`checkFabrication`).
- `meta-strip.js` — 구조 메타 누수 제거(`stripSectionMeta`).

배경: 프록시(현 `engine/copykiller-proxy.js`)의 실제 카피킬러 상관이 r=0.30(2026-06-19 실측)이라
rerank 신뢰도가 부족 → 데이터 누적·프록시 재학습 후 재평가 예정. 그때 이 lattice를 생성 루프에 연결.

※ `engine/copykiller/risk-router.js`는 **라이브**(analyze.js 입력 AI% 게이트 shadow) — 여기로 옮기지 않음.
