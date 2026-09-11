// ============================================================================
// translate.js — the main loop: transcribe → translate → extract → save
// ============================================================================
// This is the file you actually run. It ties together:
//   - record-schema.js  (the shape of a person record)
//   - extract.js         (AI extraction + safe merging)
// and adds: model loading, transcription, translation, a growing transcript,
// and periodic extraction passes that update a draft record as the
// conversation continues.
//
// GPS and peer sync are NOT wired in yet on purpose — this file focuses on
// getting transcribe → translate → extract → save working end to end first.
// Those two pieces plug in cleanly once this is solid (see TODOs below).
// ============================================================================

import { loadModel, unloadModel, WHISPER_TINY, QWEN3_4B_INST_Q4_K_M, BERGAMOT_EN_ES, transcribe, translate as translateText, completion } from '@qvac/sdk';
import { appendFile, writeFile } from 'fs/promises';
import { randomUUID, createHash } from 'crypto';
import { extractDraftRecord, mergeDraftIntoRecord } from './extract.js';
import { startAlwaysOn, destroySwarm } from './sync.js';
import { getLocation } from './gps.js';

// Guarantee Ctrl+C always works, even if a background network handle
// (swarm/DHT socket) is keeping the process alive after logical completion.
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT — forcing exit.');
  process.exit(1);
});

// --- Config: adjust language pair here for now ---
const SOURCE_LANG = 'en'; // set to 'auto' once autodetect is wired in
const TARGET_LANG = 'es';
const ALWAYS_ON_SYNC = true; // set false if you'd rather call syncNow() manually instead

// --- Models to load once at startup ---
let whisperModelId;
let llmModelId;
let nmtModelId;

async function loadModels() {
  console.log('Loading models (first run downloads them — do this once online)...');
  whisperModelId = await loadModel({ modelSrc: WHISPER_TINY });
  llmModelId = await loadModel({
    modelSrc: QWEN3_4B_INST_Q4_K_M,
    modelConfig: { ctx_size: 4096, reasoning_budget: 0 },
  }); // used for extraction — bigger model than transcription/translation, since this step needs more reliable structured reasoning
  nmtModelId = await loadModel({
    modelSrc: BERGAMOT_EN_ES,
    modelType: 'nmt',
    modelConfig: { engine: 'Bergamot', from: SOURCE_LANG, to: TARGET_LANG },
  });
  console.log('Models loaded.');
}

// --- A record ID from name+DOB+nationality, for cross-device dedup ---
// Placeholder-safe: works even before those fields are known, using a
// session UUID until real identity fields get confirmed, at which point
// you'd re-derive and migrate the ID (not handled yet — noted as a TODO).
function makeRecordId({ name, dateOfBirth, nationality } = {}) {
  if (name && dateOfBirth) {
    return createHash('sha256')
      .update((name + '|' + dateOfBirth + '|' + (nationality || '')).toLowerCase())
      .digest('hex')
      .slice(0, 16);
  }
  return randomUUID();
}

// --- Append one line to this record's own transcript/audit file ---
// Kept SEPARATE from the main record file on purpose: the record itself
// stays small so it syncs/transfers fast between devices, while the full
// raw original + translated audit trail lives in its own file, linked back
// by the same recordId.
async function logTranscriptLine(recordId, speaker, original, translated) {
  const entry = {
    timestamp: new Date().toISOString(),
    speaker, // 'person' | 'agent'
    original,
    translated,
  };
  await appendFile(`./records/${recordId}.transcript.jsonl`, JSON.stringify(entry) + '\n');
}

// --- Save the current draft/confirmed record to its own file ---
async function saveRecord(record) {
  await writeFile(`./records/${record.recordId}.json`, JSON.stringify(record, null, 2));
}

// --- One transcribe+translate turn ---
async function handleTurn(audioPath, record, fullTranscript) {
  const original = await transcribe({ modelId: whisperModelId, audioChunk: audioPath });
  console.log('Heard:', original);

  const translationResult = translateText({
    modelId: nmtModelId,
    text: original,
    modelType: 'nmt',
    stream: false,
  });
  const translated = (await translationResult.text).trim();
  console.log('Translated:', translated);

  await logTranscriptLine(record.recordId, 'person', original, translated);
  record.transcriptRef = `./records/${record.recordId}.transcript.jsonl`;

  // Grow the running transcript used for extraction (original-language text
  // is fine here — extraction doesn't require translation first)
  fullTranscript.text += `\n${original}`;

  // Run an extraction pass and merge it in
  const draft = await extractDraftRecord(fullTranscript.text, llmModelId);
  console.log('Extraction draft:', JSON.stringify(draft, null, 2)); // TEMP debug log
  const merged = mergeDraftIntoRecord(record, draft); // flagContradictions defaults to true

  const openFlags = merged.flags ? merged.flags.filter(function (f) { return f.status === 'open'; }) : [];
  if (openFlags.length > 0) {
    console.warn('⚠ ' + openFlags.length + ' open flag(s) on this record — needs agent review.');
  }

  await saveRecord(merged);
  return merged;
}

// --- Entry point ---
async function main() {
  await loadModels();

  if (ALWAYS_ON_SYNC) {
    await startAlwaysOn(); // begins listening for nearby peers right away, runs alongside everything else
  }

  // Start a fresh record for this conversation
  console.log('Getting location...');
  const location = await getLocation();

  let record = {
    recordId: makeRecordId(),
    triageLevel: { value: 'unknown', source: 'manual' },
    location, // real GPS or manual entry, instead of the old placeholder
    conversationStart: new Date().toISOString(),
    conversationEnd: null,
    lastUpdated: new Date().toISOString(),
    shareWithAnyNearbyDevice: true, // TODO: make this a real toggle
    flags: [],
  };

  const fullTranscript = { text: '' };

  // --- TEMPORARY: replace this with real mic input / streaming later ---
  // Pass a filename as a command-line arg to override, e.g.:
  //   node translate.js my-other-recording.wav
  // Defaults to test.wav if nothing is given.
  const testAudioFile = process.argv[2] || './test.wav';
  record = await handleTurn(testAudioFile, record, fullTranscript);

  console.log('\nCurrent record state:');
  console.log(JSON.stringify(record, null, 2));

  // Shut down the worker process cleanly, then force exit —
  // otherwise Node hangs waiting on the background worker indefinitely.
  await unloadModel({ modelId: whisperModelId, autoClose: true });
  await unloadModel({ modelId: llmModelId, autoClose: true });
  await unloadModel({ modelId: nmtModelId, autoClose: true });
  await destroySwarm();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

// ============================================================================
// TODOs to wire in next:
// - Live mic instead of a static test file (streaming/VAD transcription)
// - Language autodetect instead of the fixed SOURCE_LANG/TARGET_LANG
// ============================================================================
