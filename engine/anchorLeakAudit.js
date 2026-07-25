'use strict';

// Historical style-anchor vocabulary must never leak into a production
// rewrite unless the same subject already exists in the user's source or
// explicitly allowed material. This small deterministic audit replaces the
// former dependency on the retired prompt builder.
const ANCHOR_LEAK_RE = /갭투자|전세|보증금|임대인|임차인|다주택|집값|월세|분양|슬럼화|직주근접|초고밀|매매차익/gu;

function findAnchorLeaks(text, allowedWorld = '') {
  const allowed = String(allowedWorld || '');
  return [...new Set(String(text || '').match(ANCHOR_LEAK_RE) || [])]
    .filter(token => !allowed.includes(token));
}

module.exports = { ANCHOR_LEAK_RE, findAnchorLeaks };
