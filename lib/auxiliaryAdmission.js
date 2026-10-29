'use strict';
function responseForDenial(reason) {
  if(reason==='capacity')return {status:503,body:{code:'ENGINE_CAPACITY_BUSY',retryable:true,retryAfterMs:15000,
    billingState:'not_started',error:'현재 처리 중인 작업이 많아 요청한 작업을 아직 시작하지 못했어요. 입력한 내용은 유지되며, 잠시 후 다시 시도할 수 있어요.'}};
  if(reason==='account_deletion')return {status:409,body:{code:'ACCOUNT_DELETION_IN_PROGRESS',retryable:false,
    billingState:'not_started',error:'회원 탈퇴 처리가 진행 중이라 작업을 시작할 수 없어요.'}};
  return {status:409,body:{code:reason==='user_busy'?'USER_TRANSFORM_ACTIVE':'TRANSFORM_STATE_CHANGED',retryable:false,
    billingState:'not_started',error:reason==='user_busy'?'이미 진행 중인 작업이 있어요. 완료 후 다시 시도해 주세요.':'작업 상태가 바뀌었어요. 결과를 다시 열어 확인해 주세요.'}};
}
module.exports={responseForDenial};
