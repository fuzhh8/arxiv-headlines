const REQUIRED_ENV = [
  'CACHE_S3_ENDPOINT',
  'CACHE_S3_BUCKET',
  'CACHE_S3_ACCESS_KEY_ID',
  'CACHE_S3_SECRET_ACCESS_KEY'
];

function cacheKey(prefix, category, date) {
  const dir = category.replaceAll('.', '-');
  return `${prefix}${dir}/${date}.json`;
}

function objectKey(prefix, key) {
  const clean = String(key || '').replace(/^\/+/, '');
  if (!clean || clean.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid object-store key');
  }
  return `${prefix}${clean}`;
}

async function bodyToString(body) {
  if (!body) return '';
  if (typeof body.transformToString === 'function') return body.transformToString();
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export function createObjectCacheStore(env = process.env) {
  const configured = REQUIRED_ENV.filter(name => env[name]);
  const enabled = configured.length === REQUIRED_ENV.length;
  const partial = configured.length > 0 && !enabled;
  const prefixValue = String(env.CACHE_S3_PREFIX || 'arxiv-headlines/').replace(/^\/+|\/+$/g, '');
  const prefix = prefixValue ? `${prefixValue}/` : '';
  let sdkPromise = null;

  if (partial) {
    const missing = REQUIRED_ENV.filter(name => !env[name]);
    console.warn(`[cache] S3 cache disabled; missing ${missing.join(', ')}`);
  }

  async function sdk() {
    if (!enabled) return null;
    if (!sdkPromise) {
      sdkPromise = import('@aws-sdk/client-s3').then(({ S3Client, GetObjectCommand, PutObjectCommand }) => ({
        client: new S3Client({
          region: env.CACHE_S3_REGION || 'auto',
          endpoint: String(env.CACHE_S3_ENDPOINT).replace(/\/+$/, ''),
          credentials: {
            accessKeyId: env.CACHE_S3_ACCESS_KEY_ID,
            secretAccessKey: env.CACHE_S3_SECRET_ACCESS_KEY
          }
        }),
        GetObjectCommand,
        PutObjectCommand
      }));
    }
    return sdkPromise;
  }

  return {
    enabled,
    kind: enabled ? 's3' : 'filesystem',

    async read(category, date) {
      if (!enabled) return null;
      const { client, GetObjectCommand } = await sdk();
      try {
        const result = await client.send(new GetObjectCommand({
          Bucket: env.CACHE_S3_BUCKET,
          Key: cacheKey(prefix, category, date)
        }));
        return JSON.parse(await bodyToString(result.Body));
      } catch (error) {
        const status = error?.$metadata?.httpStatusCode;
        if (status === 404 || error?.name === 'NoSuchKey' || error?.Code === 'NoSuchKey') return null;
        throw error;
      }
    },

    async write(payload) {
      if (!enabled || !payload?.category || !payload?.date) return false;
      const { client, PutObjectCommand } = await sdk();
      await client.send(new PutObjectCommand({
        Bucket: env.CACHE_S3_BUCKET,
        Key: cacheKey(prefix, payload.category, payload.date),
        Body: JSON.stringify(payload),
        ContentType: 'application/json; charset=utf-8',
        CacheControl: 'no-cache'
      }));
      return true;
    },

    async readObject(key) {
      if (!enabled) return null;
      const { client, GetObjectCommand } = await sdk();
      try {
        const result = await client.send(new GetObjectCommand({
          Bucket: env.CACHE_S3_BUCKET,
          Key: objectKey(prefix, key)
        }));
        return JSON.parse(await bodyToString(result.Body));
      } catch (error) {
        const status = error?.$metadata?.httpStatusCode;
        if (status === 404 || error?.name === 'NoSuchKey' || error?.Code === 'NoSuchKey') return null;
        throw error;
      }
    },

    async writeObject(key, value) {
      if (!enabled) return false;
      const { client, PutObjectCommand } = await sdk();
      await client.send(new PutObjectCommand({
        Bucket: env.CACHE_S3_BUCKET,
        Key: objectKey(prefix, key),
        Body: JSON.stringify(value),
        ContentType: 'application/json; charset=utf-8',
        CacheControl: 'no-store'
      }));
      return true;
    }
  };
}
