# 영상별 신규 가입 조회

관리자 → 사용자 → 영상별 신규 가입에서 최근 7·30·90일 가입 기록을 조회한다. 외부 애널리틱스나 신규 서비스 계정은 필요 없다.

영상마다 `utm_content`를 다르게 지정한다. 예:

```text
https://gpkorea.ai.kr/?utm_source=instagram&utm_medium=social&utm_campaign=signup_test&utm_content=video_01
```

- 가입 직전 유입: 가입할 때 저장한 `signupAttribution.last_touch` 기준.
- 최초 유입: 가입할 때 저장한 `signupAttribution.first_touch` 기준.
- 동일 가입자는 선택한 기준에서 한 번만 집계한다. 두 기준의 숫자를 더하지 않는다.
- 채널은 정확히 필터링하고 영상·캠페인 검색은 부분 문자열로 찾는다.
- 한국 시간의 오늘을 포함한 7·30·90개 날짜에서 조회 시점까지의 가입을 집계한다.

`POST /admin/signup-attribution-summary`는 Firebase Bearer 토큰을 검증한 관리자에게만 집계값을 반환한다. 요청은 `{ "days": 30, "touch": "last_touch" }` 형식이다. `users`의 ISO UTC `createdAt` 범위를 조회하며 `createdAt`, `signupAttribution`만 읽는다. 단일 필드 인덱스를 사용하므로 새 복합 인덱스나 클라이언트 Firestore 권한은 필요 없다.

기록이 없는 계정은 direct로 추정하지 않고 미기록으로 표시한다. 관리자 UID는 제외한다. 현재 보관된 사용자 문서가 정본이므로 탈퇴·삭제된 계정은 제외되며, 과거 미기록 유입은 복원하지 않는다. 조회가 20,000건을 넘으면 `partial`과 `truncated`를 표시하고 기간 축소를 안내한다. DB 조회 실패는 503으로 반환하며 0명으로 표시하지 않는다.

브라우저 유입 기록은 기존 추적 정책(최초 90일·마지막 30일)을 따른다. 다른 기기·브라우저로 전환해서 링크 정보가 전달되지 않으면 연결이 누락될 수 있다. 이 화면은 링크 귀속 가입 수이며 영상 시청자 수나 순증 효과를 측정하지 않는다.
