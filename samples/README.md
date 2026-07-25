# 엔진 테스트 샘플

운영 엔진의 자동 검증은 아래 명령으로 실행합니다.

```powershell
npm test
npm run eval
npm run check:production-imports
```

실제 OpenAI 호출 재생은 `scripts/humanize-v2-eval.js`의 manifest 기반 명령을 사용하고,
원문·결과·UID가 포함된 산출물은 저장소 밖에 둡니다. 삭제된 단일 파일용
`engine-test.js` 러너는 운영 엔진과 다른 경로를 실행하던 도구라 더 이상 사용하지 않습니다.

실제 검증용으로는 보고서 §10 fixture 4종을 권장합니다:
- **PMF형**: 공식문서/조직 화자 글 → 개인 화자로 안 바뀌는지 (pov 가드)
- **만자형**: 긴 글에서 결론 반복·없는 미래전망 추가 안 하는지
- **thesis 허위**: 원문에 없는 Table/Eq/수치/논문명 생성 안 하는지
- **assignment**: opt-in 없이 새 1인칭 일화 강제 주입 안 하는지

`sample-assignment.txt`는 추상·일반론 위주의 과제 글(현재 엔진이 1인칭 일화를 강제 주입하던 유형)입니다.
본인의 실제 케이스로 교체해서 before/after를 보세요.
