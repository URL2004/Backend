'use strict';

// Only a full, signed output may use this proof (the caller verifies its HMAC).
// PDF wrapping may INSERT newlines inside words. It may not delete a word
// boundary, add horizontal-only spaces, change a character, or match an excerpt.
function exactLinewrappedOutput(text, output) {
  const normalize=value=>String(value||'').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/gu,'').trim();
  const target=normalize(text),source=normalize(output);
  if(source.length<500||source.length>35000||target.length>35000||!/[\r\n]/u.test(target))return false;
  const tokens=value=>value.match(/\s+|\S/gu)||[];
  const a=tokens(source),b=tokens(target);let i=0,j=0,previous='',inserted=0;
  const space=value=>/^\s+$/u.test(value||'');
  while(i<a.length&&j<b.length){
    const leftGap=space(a[i])?a[i++]:'',rightGap=space(b[j])?b[j++]:'';
    const left=a[i++],right=b[j++];
    if(left!==right)return false;
    // Existing punctuation spacing is already equivalent in wordBoundaryKey.
    if(/[\p{L}\p{N}]/u.test(previous)&&/[\p{L}\p{N}]/u.test(left||'')
      &&Boolean(leftGap)!==Boolean(rightGap)){
      if(leftGap||!/^[ \t]*(?:\r?\n[ \t]*){1,2}$/u.test(rightGap)
        ||!/[\p{L}]/u.test(previous)||!/[\p{L}]/u.test(left))return false;
      inserted++;
    }
    previous=left;
  }
  // Several internal wraps distinguish a copied document from an isolated
  // ambiguous word-boundary edit. Runtime is linear in the bounded input.
  return i===a.length&&j===b.length&&inserted>=3;
}
module.exports={exactLinewrappedOutput};
