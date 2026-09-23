import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MAX_SAVED_PAPERS = 5000;

function hashSyncCode(syncCode) {
  return createHash('sha256').update(String(syncCode)).digest('hex');
}

function stateObjectKey(syncCode) {
  return `user-state/${hashSyncCode(syncCode)}.json`;
}

function normalisePaperId(value) {
  const id = String(value || '').trim().replace(/v\d+$/i, '');
  return /^\d{4}\.\d{4,5}$|^[a-z-]+(?:\.[A-Z]+)?\/\d{7}$/i.test(id) ? id : '';
}

export function validateUserState(input) {
  const favorites = [...new Set(
    (Array.isArray(input?.favorites) ? input.favorites : [])
      .map(normalisePaperId)
      .filter(Boolean)
  )].slice(0, MAX_SAVED_PAPERS);

  const readingStates = {};
  for (const [rawId, state] of Object.entries(input?.readingStates || {})) {
    const id = normalisePaperId(rawId);
    if (id && (state === 'queue' || state === 'read')) readingStates[id] = state;
    if (Object.keys(readingStates).length >= MAX_SAVED_PAPERS) break;
  }

  return { schemaVersion: 1, favorites, readingStates };
}

export function createUserStore({ root, cacheStore }) {
  const localRoot = join(root, '.private-state');
  const remoteEnabled = cacheStore?.enabled &&
    typeof cacheStore.readObject === 'function' &&
    typeof cacheStore.writeObject === 'function';

  async function readLocal(key) {
    try {
      return JSON.parse(await readFile(join(localRoot, `${key}.json`), 'utf8'));
    } catch (_) {
      return null;
    }
  }

  async function writeLocal(key, value) {
    const path = join(localRoot, `${key}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value), 'utf8');
  }

  return {
    kind: remoteEnabled ? 's3' : 'filesystem',
    durable: remoteEnabled,

    async loadState(syncCode) {
      const key = stateObjectKey(syncCode);
      const value = remoteEnabled ? await cacheStore.readObject(key) : await readLocal(key);
      if (!value) return null;
      return { ...validateUserState(value), updatedAt: value.updatedAt || null };
    },

    async saveState(syncCode, state) {
      const value = { ...validateUserState(state), updatedAt: new Date().toISOString() };
      const key = stateObjectKey(syncCode);
      if (remoteEnabled) await cacheStore.writeObject(key, value);
      else await writeLocal(key, value);
      return value;
    },

    async saveFeedback(feedback) {
      const value = {
        schemaVersion: 1,
        submittedAt: new Date().toISOString(),
        ...feedback
      };
      const key = `feedback/${Date.now()}-${randomUUID()}.json`;
      if (remoteEnabled) await cacheStore.writeObject(key, value);
      else await writeLocal(key, value);
      return { durable: remoteEnabled };
    }
  };
}
