import path from 'node:path';

// fs.watch's `filename` argument can be null on some platforms/events (nothing we can act on
// then). Turns a raw (root, eventType, filename) callback tuple into one addressable event.
export function normalizeRawEvent({ root, eventType, filename }) {
  if (!filename) return null;
  return { root, absPath: path.join(root, filename), rawEventType: eventType, occurredAt: new Date().toISOString() };
}
