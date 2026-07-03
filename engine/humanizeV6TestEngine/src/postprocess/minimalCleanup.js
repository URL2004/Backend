function minimalCleanup(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\t\u00a0]+/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { minimalCleanup };
