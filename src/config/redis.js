const Redis = require('ioredis');
const dotenv = require('dotenv');
dotenv.config();

let redisClient = null;
let isRedisConnected = false;

// In-memory mutex map fallback when Redis is not available
const localLocks = new Map();

function initRedis() {
  const host = process.env.REDIS_HOST || 'localhost';
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || undefined;

  try {
    redisClient = new Redis({
      host,
      port,
      password,
      retryStrategy(times) {
        if (times > 3) {
          // Stop reconnecting after 3 tries and use memory lock fallback
          return null;
        }
        return Math.min(times * 100, 2000);
      },
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false
    });

    redisClient.on('connect', () => {
      isRedisConnected = true;
      console.log(`[Redis] Connected successfully to ${host}:${port}`);
    });

    redisClient.on('error', (err) => {
      if (isRedisConnected) {
        console.warn('[Redis Warning] Connection lost, falling back to atomic DB/memory lock:', err.message);
      }
      isRedisConnected = false;
    });
  } catch (err) {
    console.warn('[Redis Warning] Could not initialize Redis client, using local locking:', err.message);
    isRedisConnected = false;
  }
}

/**
 * Acquire distributed lock for pass scanning or critical batch operations
 * @param {string} resourceKey - e.g. "lock:scan:AS-12345"
 * @param {number} ttlMs - Lock expiration in milliseconds (default 5000ms)
 * @returns {Promise<{acquired: boolean, release: Function}>}
 */
async function acquireLock(resourceKey, ttlMs = 5000) {
  const lockId = Math.random().toString(36).substring(2) + Date.now().toString(36);

  if (isRedisConnected && redisClient) {
    try {
      // SET resourceKey lockId PX ttlMs NX
      const result = await redisClient.set(resourceKey, lockId, 'PX', ttlMs, 'NX');
      if (result === 'OK') {
        return {
          acquired: true,
          release: async () => {
            // Lua script to release lock only if lockId matches
            const releaseScript = `
              if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
              else
                return 0
              end
            `;
            try {
              await redisClient.eval(releaseScript, 1, resourceKey, lockId);
            } catch (e) {
              // Ignore release errors
            }
          }
        };
      }
      return { acquired: false, release: async () => {} };
    } catch (e) {
      // Redis command failed, proceed to local lock fallback
    }
  }

  // Local in-memory lock fallback with self-pruning to prevent memory growth
  const now = Date.now();
  if (localLocks.size > 100) {
    for (const [key, lockObj] of localLocks.entries()) {
      if (lockObj.expiresAt <= now) {
        localLocks.delete(key);
      }
    }
  }

  const existingLock = localLocks.get(resourceKey);
  if (existingLock && existingLock.expiresAt > now) {
    return { acquired: false, release: async () => {} };
  }

  localLocks.set(resourceKey, { lockId, expiresAt: now + ttlMs });
  return {
    acquired: true,
    release: async () => {
      const current = localLocks.get(resourceKey);
      if (current && current.lockId === lockId) {
        localLocks.delete(resourceKey);
      }
    }
  };
}

module.exports = {
  initRedis,
  acquireLock,
  isRedisConnected: () => isRedisConnected,
  getRedisClient: () => redisClient
};
