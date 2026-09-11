// test-sync.js — run this in two separate terminals to simulate two devices
// on the same network discovering and syncing with each other.
import { startAlwaysOn } from './sync.js';

await startAlwaysOn();
console.log('Waiting for peers... (Ctrl+C to stop)');
