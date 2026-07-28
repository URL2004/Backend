// llm/profile.js - backend-specific engine behavior switches.
//
// Gemini follows broad style prompts more literally than Claude. Keep the
// local test behavior explicit: strength 0/1 is preservation, strength 2/3
// opens the formal rewriting/repair passes. Claude fallback remains disabled
// in Gemini backend by router policy.

function backend() {
  return (process.env.LLM_BACKEND || 'api').toLowerCase();
}

function isGeminiBackend() {
  return backend() === 'gemini';
}

function isFormalMode(mode) {
  return mode === 'assignment' || mode === 'thesis' || mode === 'formal';
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'on', 'yes'].includes(String(raw).toLowerCase());
}

function offEnv(name) {
  return ['0', 'false', 'off', 'none'].includes(String(process.env[name] || '').toLowerCase());
}

function geminiStrength() {
  const n = Number(process.env.GEMINI_EVADE_STRENGTH || '2');
  if (!Number.isFinite(n)) return 2;
  return Math.max(0, Math.min(3, Math.round(n)));
}

function geminiAssignmentProfile() {
  return (process.env.GEMINI_ASSIGNMENT_PROFILE || 'auto').toLowerCase();
}

function isLooseRewriteProfileValue(v) {
  return [
    'loose',
    'rewrite',
    'rewrite_loose',
    'loose_rewrite',
    'adaptive',
    'adaptive_rewrite',
    'copykiller',
    'natural',
    'creative',
  ].includes(v);
}

function isSourceBoundProfileValue(v) {
  return ['source_bound', 'source-bound', 'source', 'conservative', 'super_conservative', 'super-conservative'].includes(v);
}

function geminiLooseRewriteProfile(mode, floorV2 = true) {
  if (!isGeminiBackend() || !floorV2 || !isFormalMode(mode)) return false;
  return isLooseRewriteProfileValue(geminiAssignmentProfile())
    || ['loose', 'rewrite', 'low', '0.65'].includes(String(process.env.GEMINI_PRESERVATION_RATE || '').toLowerCase());
}

function geminiSourceBoundProfile(mode, floorV2 = true) {
  if (!isGeminiBackend() || !floorV2 || !isFormalMode(mode)) return false;
  if (geminiLooseRewriteProfile(mode, floorV2)) return false;
  return isSourceBoundProfileValue(geminiAssignmentProfile());
}

function geminiPreserveProfile(mode, floorV2 = true) {
  if (!isGeminiBackend() || !floorV2 || !isFormalMode(mode)) return false;
  const v = geminiAssignmentProfile();
  if (['off', 'none'].includes(v) || isLooseRewriteProfileValue(v)) return false;
  return v === 'preserve' || v === 'tone_polish' || isSourceBoundProfileValue(v) || geminiStrength() <= 0;
}

function geminiStudentNoteProfile(mode, floorV2 = true) {
  if (!isGeminiBackend() || !floorV2 || !isFormalMode(mode)) return false;
  const v = geminiAssignmentProfile();
  if (['off', 'none', 'creative', 'rewrite', 'copykiller', 'natural'].includes(v)) return false;
  if (v === 'student_note' || v === 'student') return geminiStrength() <= 1;
  return geminiStrength() === 1;
}

function allowGeminiCreativePasses(mode, floorV2 = true) {
  if (!isGeminiBackend() || !floorV2 || !isFormalMode(mode)) return false;
  if (geminiSourceBoundProfile(mode, floorV2) || geminiPreserveProfile(mode, floorV2) || geminiStudentNoteProfile(mode, floorV2)) return false;
  if (offEnv('GEMINI_CREATIVE_PASSES')) return false;
  if (geminiLooseRewriteProfile(mode, floorV2)) return true;
  if (boolEnv('GEMINI_CREATIVE_PASSES', false)) return true;
  return geminiStrength() >= 2 && !geminiPreserveProfile(mode, floorV2) && !geminiStudentNoteProfile(mode, floorV2);
}

function disableGeminiCreativePasses(mode, floorV2 = true) {
  if (!isGeminiBackend() || !floorV2 || !isFormalMode(mode)) return false;
  return !allowGeminiCreativePasses(mode, floorV2);
}

function geminiBlocksCopykillerQuality(mode, floorV2 = true) {
  if (!isGeminiBackend() || !floorV2 || !isFormalMode(mode)) return false;
  if (offEnv('GEMINI_COPYKILLER_BLOCK')) return false;
  if (boolEnv('GEMINI_COPYKILLER_BLOCK', false)) return true;
  return geminiStrength() <= 1;
}

function allowGeminiBlogRegister(mode, floorV2 = true) {
  return isGeminiBackend() && floorV2 && isFormalMode(mode) && geminiStrength() >= 3;
}

function geminiFormalHumanJudgment(mode, floorV2 = true) {
  return isGeminiBackend()
    && floorV2
    && isFormalMode(mode)
    && allowGeminiCreativePasses(mode, floorV2);
}

function geminiVoiceRepairEnabled(mode, floorV2 = true) {
  if (!isGeminiBackend() || !floorV2 || !isFormalMode(mode)) return false;
  if (offEnv('GEMINI_VOICE_REPAIR')) return false;
  if (boolEnv('GEMINI_VOICE_REPAIR', false)) return true;
  return allowGeminiCreativePasses(mode, floorV2);
}

module.exports = {
  backend,
  isGeminiBackend,
  isFormalMode,
  geminiStrength,
  geminiAssignmentProfile,
  geminiLooseRewriteProfile,
  geminiSourceBoundProfile,
  geminiPreserveProfile,
  geminiStudentNoteProfile,
  allowGeminiCreativePasses,
  disableGeminiCreativePasses,
  geminiBlocksCopykillerQuality,
  allowGeminiBlogRegister,
  geminiFormalHumanJudgment,
  geminiVoiceRepairEnabled,
};
