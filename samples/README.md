# 엔진 테스트 샘플

`node engine-test.js samples/<파일> <mode>` 로 돌립니다.

실제 검증용으로는 보고서 §10 fixture 4종을 권장합니다:
- **PMF형**: 공식문서/조직 화자 글 → 개인 화자로 안 바뀌는지 (pov 가드)
- **만자형**: 긴 글에서 결론 반복·없는 미래전망 추가 안 하는지
- **thesis 허위**: 원문에 없는 Table/Eq/수치/논문명 생성 안 하는지
- **assignment**: opt-in 없이 새 1인칭 일화 강제 주입 안 하는지

`sample-assignment.txt`는 추상·일반론 위주의 과제 글(현재 엔진이 1인칭 일화를 강제 주입하던 유형)입니다.
본인의 실제 케이스로 교체해서 before/after를 보세요.
