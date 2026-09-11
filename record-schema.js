// ============================================================================
// Disaster Response Person Record — Schema + helpers
// ============================================================================
// Design notes:
// - Every field that can be auto-filled by the AI has a matching "*_source"
//   marker: "manual" | "ai_draft" | "ai_confirmed".
//   This lets the UI visually distinguish "the person typed this" from
//   "the AI heard this and it hasn't been confirmed yet".
// - Nothing with source "ai_draft" should be treated as reliable until a
//   human flips it to "ai_confirmed" (or edits it, which becomes "manual").
// - Enums are fixed lists on purpose — free text doesn't sync/scan well
//   across devices or map to how real rescue teams triage.
// ============================================================================

export const TRIAGE_LEVELS = [
  "immediate", // life-threatening, treatable now — highest priority
  "delayed",   // serious, can wait
  "minor",     // walking wounded
  "uninjured", // safe, no injury — e.g. beacon check-ins
  "deceased",  // deceased / expectant
  "unknown",   // not yet assessed
];

export const HAZARD_TYPES = [
  "fire",
  "gas_leak",
  "structural_collapse",
  "structural_damage", // damaged but not collapsed
  "flooding",
  "none_reported",
  "other",
];

export const EMOTIONAL_STATE = [
  "appears_ok",
  "distressed",
  "crisis", // needs immediate emotional/psychological support
  "unknown",
];

export const GROUP_STATUS = [
  "alone",
  "with_family_here",       // with family, also needing help, at this location
  "with_family_elsewhere",  // has family elsewhere who also need help
  "family_confirmed_safe",  // knows family is safe in an unaffected area
];

export const HELP_DESTINATION_INTENT = [
  "stay_here",
  "go_to_confirmed_safe_family", // doesn't need a help center, going to known-safe family
  "go_to_help_center",
  "undecided",
];

export const RESIDENCY_STATUS = ["resident", "tourist", "unknown"];

// A single field's value + provenance
function draftableField(valueSchema) {
  return {
    type: "object",
    properties: {
      value: valueSchema,
      source: { type: "string", enum: ["manual", "ai_draft", "ai_confirmed"] },
    },
    required: ["value", "source"],
  };
}

export const personRecordSchema = {
  type: "object",
  properties: {
    // --- Identity (usually pre-filled from local profile if returning user) ---
    recordId: { type: "string" }, // hash(name+dob+nationality) — for dedup across devices
    name: draftableField({ type: "string" }),
    dateOfBirth: draftableField({ type: "string" }), // ISO date — only when an actual date/year was stated
    age: draftableField({ type: "number" }), // use this when only a stated AGE is known, not a birth date
    nationality: draftableField({ type: "string" }),
    residencyStatus: draftableField({ type: "string", enum: RESIDENCY_STATUS }),
    idNumber: draftableField({ type: "string" }), // optional, passport/national ID

    // --- Group / family situation ---
    groupStatus: draftableField({ type: "string", enum: GROUP_STATUS }),
    groupDetails: draftableField({ type: "string" }), // free text, e.g. "wife + 2 kids"
    helpDestinationIntent: draftableField({ type: "string", enum: HELP_DESTINATION_INTENT }),
    helpCenterName: draftableField({ type: "string" }), // if going to a specific center

    // --- Status ---
    triageLevel: draftableField({ type: "string", enum: TRIAGE_LEVELS }),
    statusDetail: draftableField({ type: "string" }), // free text description of condition
    hazardsPresent: {
      type: "array",
      items: { type: "string", enum: HAZARD_TYPES },
    },
    emotionalState: draftableField({ type: "string", enum: EMOTIONAL_STATE }),

    // --- Medical ---
    medications: draftableField({ type: "string" }), // name + dosage if known
    allergies: draftableField({ type: "string" }),
    chronicConditions: draftableField({ type: "string" }),
    bloodType: draftableField({ type: "string" }),
    mobilityDisability: draftableField({ type: "string" }),
    pregnancyStatus: draftableField({ type: "string" }),

    // --- Contact ---
    emergencyContactName: draftableField({ type: "string" }),
    emergencyContactPhone: draftableField({ type: "string" }),

    // --- Location ---
    location: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["gps", "coordinates", "address", "none"] },
        lat: { type: ["number", "null"] },
        lon: { type: ["number", "null"] },
        address: { type: ["string", "null"] },
        timestamp: { type: "string" }, // when this location was captured
      },
    },

    // --- Media ---
    mediaRefs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["photo", "video"] },
          path: { type: "string" }, // local file path
          synced: { type: "boolean" }, // has this transferred to peers yet
        },
      },
    },

    // --- Consent / visibility ---
    shareWithAnyNearbyDevice: { type: "boolean" }, // vs. official-responder-only

    // --- Timestamps ---
    conversationStart: { type: "string" },
    conversationEnd: { type: ["string", "null"] },
    lastUpdated: { type: "string" },

    // --- Raw log reference ---
    // Points to a SEPARATE file (records/<recordId>.transcript.jsonl) holding
    // every raw original/translated line for this conversation — kept apart
    // from the record itself so the small, essential record can be synced
    // and transferred fast, while the fuller audit trail stays available
    // separately, same recordId used to link them back together.
    transcriptRef: { type: "string" },

    // --- Contradiction flags ---
    // Raised when a later AI extraction pass disagrees with a field that's
    // already locked (manual or ai_confirmed). Never auto-resolved — an
    // agent has to look at it and either dismiss it (AI was wrong) or
    // edit the field (AI was right) or leave it noted.
    flags: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },              // which field disagreed
          lockedValue: { type: "string" },          // what the record currently says
          lockedSource: { type: "string", enum: ["manual", "ai_confirmed"] },
          conflictingValue: { type: "string" },     // what the new AI pass heard instead
          detectedAt: { type: "string" },
          status: { type: "string", enum: ["open", "dismissed", "resolved"] },
        },
        required: ["field", "lockedValue", "conflictingValue", "detectedAt", "status"],
      },
    },
  },
  required: ["recordId", "name", "triageLevel", "location", "lastUpdated"],
};

// Fields the AI extraction step is allowed to fill from conversation text.
// (Excludes recordId, mediaRefs, consent, timestamps — those are set by app logic, not inferred.)
// Note: extract.js now groups these into FIELD_GROUPS for smaller, more
// reliable extraction calls — this flat list is kept for reference/back-compat.
export const AI_EXTRACTABLE_FIELDS = [
  "name", "dateOfBirth", "age", "nationality", "residencyStatus", "idNumber",
  "groupStatus", "groupDetails", "helpDestinationIntent", "helpCenterName",
  "triageLevel", "statusDetail", "emotionalState",
  "medications", "allergies", "chronicConditions", "bloodType",
  "mobilityDisability", "pregnancyStatus",
  "emergencyContactName", "emergencyContactPhone",
];
