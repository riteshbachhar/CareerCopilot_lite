// Validator for the LLM resume-extraction output. Pure function, never throws.
// The LLM's prompt asks for {facts: [{section, subsection, text}, ...]}; this
// validator filters anything off-shape and returns the safe subset plus a list
// of dropped reasons (useful for logging during dev).
//
// Background converges to the existing per-fact ingest loop, so the output
// shape mirrors what `parseProfileMarkdown` produces — same keys, same
// downstream code path.

const MIN_TEXT_LEN = 3;

const isString = (v) => typeof v === 'string';
const isNonEmpty = (v) => isString(v) && v.trim().length > 0;

export function validateResumeFacts(obj) {
  const dropped = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: [], dropped: ['root: not an object'] };
  }
  const arr = obj.facts;
  if (!Array.isArray(arr)) {
    return { valid: [], dropped: ['root: facts is not an array'] };
  }

  const valid = [];
  arr.forEach((f, i) => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      dropped.push(`#${i}: not an object`);
      return;
    }
    if (!isNonEmpty(f.section)) {
      dropped.push(`#${i}: missing section`);
      return;
    }
    if (!isString(f.text) || f.text.trim().length < MIN_TEXT_LEN) {
      dropped.push(`#${i}: text missing or too short`);
      return;
    }
    const subsection = isNonEmpty(f.subsection) ? f.subsection.trim() : null;
    valid.push({
      section: f.section.trim(),
      subsection,
      text: f.text.trim(),
    });
  });

  return { valid, dropped };
}
