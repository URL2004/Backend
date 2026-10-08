'use strict';
const CODES = {400:'INVALID_REQUEST',401:'AUTH_REQUIRED',402:'PAYMENT_REQUIRED',403:'FORBIDDEN',404:'NOT_FOUND',409:'STATE_CONFLICT',413:'PAYLOAD_TOO_LARGE',422:'INPUT_REJECTED',429:'RATE_LIMITED'};
module.exports = function errorEnvelope(req,res,next) {
  const send = res.json;
  res.json = function (body) {
    if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
      body = { ok:false, code:CODES[res.statusCode] || 'SERVER_ERROR', retryable:res.statusCode === 429 || res.statusCode >= 500,
        requestId:String(res.getHeader('x-request-id') || ''), billingState:'unknown', ...body };
    }
    return send.call(this,body);
  };
  next();
};
