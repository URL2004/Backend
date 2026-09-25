'use strict';

// Shared by generation and local repair. Preferences, not new delivery gates:
// parallelism and rhythm never license a new fact or a stronger assertion.
function academicStyleLines(profile) {
  if (!['academic_paper','report_assignment','long_explainer'].includes(String(profile?.profile || profile))) return [];
  return [
    '병렬 목적: “접수 및 확인을 위해”를 “접수하고 확인을 위해”로 바꿔 목적을 완료 행동으로 만들지 않는다.',
    '범위는 주장 가까이에 둔다. “이번 조사에서 응답 비율은”처럼 귀속을 유지한다.',
    '분할하며 “필요가 있다”를 복제하지 않는다. 제언·전문 용어는 유지하며 필요·가능성·권고의 강도를 바꾸는 단정형 치환은 피한다.',
    '거대 은유는 같은 강도의 평이한 행위 서술로 정리한다. 고가·빈도·속도는 사실이므로 삭제하지 않는다.'
  ];
}

module.exports = { academicStyleLines };
