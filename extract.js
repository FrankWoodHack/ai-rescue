// ============================================================================
// extract.js — turns raw conversation text into a draft person record
// ============================================================================
// How it works:
// 1. Takes the running transcript (whatever's been said so far).
// 2. Instead of one giant call covering all ~19 fields at once (which proved
//    unreliable — small/mid local models either hallucinate placeholder
//    values or only grab a handful of fields somewhat arbitrarily), this
//    runs several SMALLER, focused extraction calls, each covering a
//    related group of fields (see FIELD_GROUPS below). Smaller schemas are
//    much easier for local models to reason over completely and correctly.
// 3. Each call's response is JSON-Schema-constrained, so it can only return
//    matching structured data.
// 4. Every returned field is wrapped with source: "ai_draft" — nothing here
//    is trusted until a human confirms it (see record-schema.js notes).
// 5. A field the model found no evidence for should be left out — a strong
//    programmatic filter below also strips common placeholder words as a
//    safety net, since prompting alone hasn't fully stopped models from
//    emitting things like "not specified" or "unknown".
// ============================================================================

import { completion } from '@qvac/sdk';
import { personRecordSchema } from './record-schema.js';

// Fields grouped by theme — each group becomes its own, smaller extraction
// call. Keeping each call to ~5-7 fields is far more reliable than asking
// for all ~19 at once.
export const FIELD_GROUPS = {
  identity: ['name', 'dateOfBirth', 'age', 'nationality', 'residencyStatus', 'idNumber'],
  situation: ['groupStatus', 'groupDetails', 'helpDestinationIntent', 'helpCenterName', 'triageLevel', 'statusDetail', 'emotionalState'],
  medical: ['medications', 'allergies', 'chronicConditions', 'bloodType', 'mobilityDisability', 'pregnancyStatus'],
  contact: ['emergencyContactName', 'emergencyContactPhone'],
};

// Common placeholder words models sometimes emit instead of just omitting
// a field. Filtered out regardless of what the prompt says, as a backstop.
const PLACEHOLDER_VALUES = new Set([
  'null', 'unknown', 'not specified', 'not_specified', 'n/a', 'na',
  'none', 'none specified', 'not mentioned', 'not stated', 'unspecified', 'tbd',
]);

function buildGroupSchema(fields) {
  const properties = {};
  for (const field of fields) {
    const fullFieldSchema = personRecordSchema.properties[field];
    // Each draftable field's schema is { properties: { value: <realSchema> } }
    properties[field] = fullFieldSchema.properties.value;
  }
  return {
    type: 'object',
    properties,
    required: [], // nothing required — omit what wasn't said, don't guess
    additionalProperties: false,
  };
}

function buildGroupPrompt(fields) {
  let enumGuidance = '';
  if (fields.includes('groupStatus')) {
    enumGuidance += `
groupStatus meanings — read carefully, these are easy to mix up:
- "with_family_here": family is physically with the person right now, also needing help at this same location
- "with_family_elsewhere": person has family who need help, but at a DIFFERENT location than the person
- "family_confirmed_safe": person knows their family is safe, in an unaffected area
- "alone": no family/group mentioned as being with them
If the person says something like "I'm here with my wife and kids," that is with_family_here, NOT with_family_elsewhere.
`;
  }
  if (fields.includes('dateOfBirth') || fields.includes('age')) {
    enumGuidance += `
dateOfBirth vs age — these are different fields, use the right one:
- If the person stated an actual birth date or birth year, put it in dateOfBirth.
- If the person only stated their current AGE (e.g. "I'm 55"), put the number in
  the "age" field instead. Do NOT calculate or guess a birth year from a stated
  age — just use the age field directly for that case, and leave dateOfBirth out.
`;
  }
  if (fields.includes('emergencyContactName') || fields.includes('emergencyContactPhone')) {
    enumGuidance += `
Emergency contact fields: only fill these if the person named a DIFFERENT
person as someone to contact in an emergency (e.g. "call my brother if
anything happens, his name is..."). Do NOT put the person's own name here —
they are not their own emergency contact. If no separate contact person was
named, leave both fields out entirely.
`;
  }

  return `
You are extracting facts from a real conversation with a person in a
disaster/emergency situation, to fill out a structured record.

You are ONLY responsible for these specific fields: ${fields.join(', ')}.
Ignore anything in the conversation that doesn't relate to these fields.
${enumGuidance}
For each of these fields, check the conversation carefully:
- If the person clearly stated that specific piece of information, extract
  it (their exact words, or a short accurate paraphrase).
- If it was NOT mentioned anywhere in the conversation, leave that field out
  of your JSON entirely. Do not guess, infer, or calculate a value. Do not
  use placeholder text like "unknown" or "not specified" — just omit the
  field.

Return only the JSON object, matching the schema you were given. No
explanation, no extra text, no markdown formatting.
`.trim();
}

/**
 * Run one focused extraction call for a single field group.
 */
async function extractFieldGroup(transcriptText, modelId, fields) {
  const schema = buildGroupSchema(fields);
  const systemPrompt = buildGroupPrompt(fields);

  const result = completion({
    modelId,
    history: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `--- REAL CONVERSATION TO ANALYZE ---\n${transcriptText}\n--- END REAL CONVERSATION ---` },
    ],
    stream: false,
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'person_record_field_group', schema },
    },
  });

  let extracted;
  try {
    const raw = await result.text;
    console.log(`Raw extraction response [${fields.join(',')}]:`, raw); // TEMP debug log
    extracted = JSON.parse(raw);
  } catch (err) {
    console.error(`Extraction failed for group [${fields.join(',')}]:`, err);
    return {};
  }

  const groupDraft = {};
  for (const field of fields) {
    const value = extracted[field];
    const isPlaceholder = typeof value === 'string' && PLACEHOLDER_VALUES.has(value.trim().toLowerCase());
    const isRealValue = value !== undefined && value !== null && value !== '' && !isPlaceholder;
    if (isRealValue) {
      groupDraft[field] = { value, source: 'ai_draft' };
    }
  }
  return groupDraft;
}

/**
 * Run extraction against the current transcript, across all field groups.
 * @param {string} transcriptText - everything said so far, concatenated
 * @param {string} modelId - the loaded local model id (e.g. from loadModel())
 * @returns {Promise<object>} draft record: { fieldName: { value, source: "ai_draft" }, ... }
 */
export async function extractDraftRecord(transcriptText, modelId) {
  let combinedDraft = {};
  for (const fields of Object.values(FIELD_GROUPS)) {
    const groupDraft = await extractFieldGroup(transcriptText, modelId, fields);
    combinedDraft = { ...combinedDraft, ...groupDraft };
  }
  return combinedDraft;
}

/**
 * Merge a new draft into an existing record WITHOUT overwriting fields a
 * human has already confirmed or manually entered. AI drafts only fill gaps
 * or update other still-unconfirmed AI drafts — they never clobber
 * "manual" or "ai_confirmed" fields.
 *
 * If a locked field DISAGREES with what the new pass just heard, by default
 * we raise a flag on the record — visible to the agent, who can dismiss it
 * (AI was wrong), edit the field (AI was right), or just leave it as a
 * note. Nothing is ever auto-resolved. This can be turned off per-call if
 * an agent wants less noise and prefers to just trust locked fields as-is.
 *
 * @param {object} existingRecord
 * @param {object} newDraft - output of extractDraftRecord()
 * @param {object} [options]
 * @param {boolean} [options.flagContradictions=true] - if false, disagreements
 *   on locked fields are silently ignored instead of flagged
 * @returns {object} merged record
 */
export function mergeDraftIntoRecord(existingRecord, newDraft, options = {}) {
  const { flagContradictions = true } = options;
  const merged = { ...existingRecord };
  const flags = Array.isArray(merged.flags) ? [...merged.flags] : [];

  for (const [field, draftField] of Object.entries(newDraft)) {
    const current = merged[field];
    const isLocked = current && (current.source === 'manual' || current.source === 'ai_confirmed');

    if (!isLocked) {
      merged[field] = draftField; // safe to overwrite — still just a draft
      continue;
    }

    if (!flagContradictions) continue; // locked field, flagging disabled — leave silently as is

    // Locked field — only flag if the new value actually disagrees.
    // Simple equality here; free-text fields may flag on rephrasing too —
    // fine to start, can be tuned later (e.g. fuzzy match) if it gets noisy.
    const valuesDiffer = JSON.stringify(current.value) !== JSON.stringify(draftField.value);
    if (valuesDiffer) {
      flags.push({
        field,
        lockedValue: String(current.value),
        lockedSource: current.source,
        conflictingValue: String(draftField.value),
        detectedAt: new Date().toISOString(),
        status: 'open',
      });
    }
    // Locked and matching — nothing to do, leave as is.
  }

  merged.flags = flags;
  merged.lastUpdated = new Date().toISOString();
  return merged;
}

/**
 * Helper for the UI: resolve a flag by index — either dismiss it (AI was
 * wrong, keep the locked value) or accept it (AI was right, overwrite the
 * field as ai_confirmed and mark the flag resolved).
 * @param {object} record
 * @param {number} flagIndex
 * @param {"dismiss"|"accept"} action
 */
export function resolveFlag(record, flagIndex, action) {
  const existingFlags = record.flags ? record.flags.slice() : [];
  const updated = Object.assign({}, record, { flags: existingFlags });
  const flag = updated.flags[flagIndex];
  if (!flag) return updated;

  if (action === 'accept') {
    updated[flag.field] = { value: flag.conflictingValue, source: 'ai_confirmed' };
    flag.status = 'resolved';
  } else if (action === 'dismiss') {
    flag.status = 'dismissed';
  }

  updated.lastUpdated = new Date().toISOString();
  return updated;
}
