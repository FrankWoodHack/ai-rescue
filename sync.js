// ============================================================================
// sync.js — peer-to-peer record syncing over the local network
// ============================================================================
// Uses Hyperswarm for peer discovery (mDNS on LAN, no internet needed) and
// data exchange. Two modes, both using the same connection-handling logic:
//   - startAlwaysOn(): stays discoverable/listening the whole session
//   - syncNow(): opens a short discovery window, then stops announcing
//
// What gets sent: the small record JSON first (fast, always), then the
// fuller transcript file for that record if the connection holds — matches
// the "sync the essential data first, media/detail opportunistically"
// principle from earlier.
// ============================================================================

import Hyperswarm from 'hyperswarm';
import crypto from 'crypto';
import { readFile, readdir, writeFile } from 'fs/promises';
import path from 'path';

const TOPIC_NAME = 'qvac-sos-demo'; // change per deployment/team if needed
const topic = crypto.createHash('sha256').update(TOPIC_NAME).digest();

const swarm = new Hyperswarm();
let isJoined = false;

// --- Send every local record + its transcript to a newly connected peer ---
async function sendAllRecords(socket) {
  const files = await readdir('./records');
  const recordFiles = files.filter((f) => f.endsWith('.json'));

  for (const file of recordFiles) {
    const recordPath = path.join('./records', file);
    const recordText = await readFile(recordPath, 'utf-8');
    socket.write(JSON.stringify({ type: 'record', data: JSON.parse(recordText) }) + '\n');

    // Transcript is bigger and lower priority — send it right after,
    // opportunistically, same connection
    const transcriptFile = file.replace('.json', '.transcript.jsonl');
    try {
      const transcriptText = await readFile(path.join('./records', transcriptFile), 'utf-8');
      socket.write(JSON.stringify({ type: 'transcript', recordId: file.replace('.json', ''), data: transcriptText }) + '\n');
    } catch {
      // no transcript file yet for this record — fine, skip it
    }
  }
}

// --- Merge an incoming record from a peer into local storage ---
// Simple dedup: if we already have this recordId, only overwrite if the
// incoming one is newer (by lastUpdated). Doesn't merge field-by-field yet —
// that's a reasonable next step once this basic version is proven.
async function receiveRecord(incomingRecord) {
  const localPath = path.join('./records', `${incomingRecord.recordId}.json`);
  let shouldWrite = true;

  try {
    const existingText = await readFile(localPath, 'utf-8');
    const existing = JSON.parse(existingText);
    shouldWrite = new Date(incomingRecord.lastUpdated) > new Date(existing.lastUpdated);
  } catch {
    // no local copy yet — write it
  }

  if (shouldWrite) {
    await writeFile(localPath, JSON.stringify(incomingRecord, null, 2));
    console.log(`Synced record ${incomingRecord.recordId} from peer.`);
  }
}

async function receiveTranscript(recordId, transcriptText) {
  const localPath = path.join('./records', `${recordId}.transcript.jsonl`);
  // Simple approach for now: only write if we don't already have one.
  // A line-level merge would be a good upgrade once basic sync is proven.
  try {
    await readFile(localPath, 'utf-8');
    // already have one — skip for now
  } catch {
    await writeFile(localPath, transcriptText);
    console.log(`Synced transcript for ${recordId} from peer.`);
  }
}

function handleConnection(socket, info) {
  console.log('Connected to peer:', info.publicKey.toString('hex').slice(0, 12) + '...');

  sendAllRecords(socket).catch((err) => console.error('Error sending records:', err));

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let lineEnd;
    while ((lineEnd = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      if (!line.trim()) continue;

      try {
        const msg = JSON.parse(line);
        if (msg.type === 'record') {
          receiveRecord(msg.data).catch((err) => console.error('Error receiving record:', err));
        } else if (msg.type === 'transcript') {
          receiveTranscript(msg.recordId, msg.data).catch((err) => console.error('Error receiving transcript:', err));
        }
      } catch (err) {
        console.error('Received malformed peer message, skipping:', err);
      }
    }
  });

  socket.on('error', (err) => console.error('Peer connection error:', err));
}

swarm.on('connection', handleConnection);

// --- Mode 1: always-on background discovery ---
export async function startAlwaysOn() {
  if (isJoined) return;
  await swarm.join(topic, { server: true, client: true }).flushed();
  isJoined = true;
  console.log('Peer sync: always-on, discoverable now.');
}

// --- Mode 2: manual "sync now" — open briefly, then stop announcing ---
export async function syncNow(timeoutMs = 10000) {
  if (!isJoined) {
    await swarm.join(topic, { server: true, client: true }).flushed();
    isJoined = true;
  }
  console.log('Peer sync: looking for nearby devices...');

  return new Promise((resolve) => {
    setTimeout(async () => {
      await swarm.leave(topic);
      isJoined = false;
      console.log('Peer sync: window closed, no longer discoverable.');
      resolve();
    }, timeoutMs);
  });
}

// --- Turn off discoverability without closing the whole swarm ---
export async function stopSync() {
  if (isJoined) {
    await swarm.leave(topic);
    isJoined = false;
    console.log('Peer sync: stopped.');
  }
}

// --- Full shutdown, e.g. alongside model unloading at app exit ---
export async function destroySwarm() {
  await swarm.destroy();
}
