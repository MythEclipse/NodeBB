'use strict';

/**
 * @typedef {object} CacheInstance
 * @property {string} name Cache name, used for pubsub channels and tracking.
 * @property {number} hits Number of cache hits.
 * @property {number} misses Number of cache misses.
 * @property {boolean} enabled Whether the cache is active.
 * @property {number} max Maximum number of entries.
 * @property {number} itemCount Number of entries (backcompat alias of `size`).
 * @property {number} size Number of entries.
 * @property {number} ttl Default TTL in milliseconds.
 */

/**
 * Create a TTL-backed cache.
 *
 * @param {object} opts Options passed through to `@isaacs/ttlcache`, plus `name` and `enabled`.
 * @param {string} [opts.name] Cache name, required for pubsub and tracking.
 * @param {boolean} [opts.enabled=true] When false, all cache operations are no-ops.
 * @returns {CacheInstance}
 */
module.exports = function (opts) {
	const { TTLCache } = require('@isaacs/ttlcache');
	const { LRUCache } = require('lru-cache');
	const os = require('os');
	const winston = require('winston');
	const chalk = require('chalk').default;

	const pubsub = require('../pubsub');
	const tracker = require('./tracker');

	const instanceId = `${os.hostname()}:${process.pid}`;

	const ttlCache = new TTLCache(opts);
	if (!opts.name) {
		winston.warn(`[cache/init] ${chalk.white.bgRed.bold('WARNING')} The cache name is not set. This will be required in the future.\n ${new Error('Cache name not set').stack} `);
	}

	const cache = {
		name: opts.name,
		hits: 0,
		misses: 0,
		enabled: Object.hasOwn(opts, 'enabled') ? opts.enabled : true,
	};

	// expose properties
	const propertyMap = new Map([
		['max', 'max'],
		['itemCount', 'size'],
		['size', 'size'],
		['ttl', 'ttl'],
	]);
	for (const [cacheProp, ttlProp] of propertyMap) {
		Object.defineProperty(cache, cacheProp, {
			get: function () {
				return ttlCache[ttlProp];
			},
			configurable: true,
			enumerable: true,
		});
	}

	// Per-key version counters let in-flight loads detect that their key was
	// deleted (locally or via pubsub) since the load started.
	const invalidationVersions = new LRUCache({
		max: Math.max(10000, opts.max ? Math.floor(opts.max / 5) : 10000),
	});

	// Loads in progress, keyed by cache key, so concurrent misses share one loader call.
	const inflight = new Map();

	cache.has = function (key) {
		if (!cache.enabled) {
			return false;
		}

		return ttlCache.has(key);
	};

	cache.set = function (key, value, ttl) {
		if (!cache.enabled) {
			return;
		}
		const setOpts = {};
		if (ttl) {
			setOpts.ttl = ttl;
		}
		ttlCache.set(key, value, setOpts);
	};

	/**
	 * Get a value, loading it on a miss. Concurrent misses for the same key
	 * share a single loader call.
	 *
	 * @param {string} key Cache key.
	 * @param {Function} [loader] Called on a miss; may return a promise.
	 * @returns {*|Promise<*>|undefined} The cached or loaded value.
	 */
	cache.get = function (key, loader) {
		if (!cache.enabled) {
			return loader ?
				Promise.resolve().then(loader) :
				undefined;
		}
		const data = ttlCache.get(key);
		if (data !== undefined) {
			cache.hits += 1;
			return data;
		}
		cache.misses += 1;
		if (!loader) {
			return undefined;
		}
		if (inflight.has(key)) {
			return inflight.get(key);
		}

		const version = getInvalidationVersion(key);
		const promise = Promise.resolve()
			.then(() => loader())
			.then((value) => {
				storeIfVersionMatches(key, value, version);
				return value;
			})
			.finally(() => inflight.delete(key));

		inflight.set(key, promise);
		return promise;
	};

	/**
	 * Get multiple values, passing all misses to a single loader call.
	 *
	 * @param {string[]} keys Cache keys.
	 * @param {Function} [loader] Called once with the uncached keys and their indexes.
	 * @returns {Array|Promise<Array>|undefined} Values in the same order as `keys`.
	 */
	cache.getMany = function (keys, loader) {
		if (!cache.enabled) {
			return loader ?
				Promise.resolve().then(() => loader(keys)) :
				keys.map(() => undefined);
		}

		const results = new Array(keys.length);
		const uncachedKeys = [];
		const uncachedIndexes = [];
		const pendingPromises = [];

		keys.forEach((key, index) => {
			const cachedValue = ttlCache.get(key);

			if (cachedValue !== undefined) {
				cache.hits += 1;
				results[index] = cachedValue;
			} else if (inflight.has(key)) {
				// Re-use the in-flight promise for this key
				cache.hits += 1;
				pendingPromises.push(inflight.get(key).then((value) => {
					results[index] = value;
				}));
			} else {
				cache.misses += 1;
				uncachedKeys.push(key);
				uncachedIndexes.push(index);
			}
		});

		// No loader, or everything was resolved synchronously from the cache
		if (!loader || (uncachedKeys.length === 0 && pendingPromises.length === 0)) {
			return results;
		}

		// Nothing to load, but still waiting on loads started by other calls
		if (uncachedKeys.length === 0) {
			return Promise.all(pendingPromises).then(() => results);
		}

		// Load the missing keys in one call and index the results by key
		const loaderPromise = Promise.resolve()
			.then(() => loader(uncachedKeys, uncachedIndexes))
			.then(values => new Map(uncachedKeys.map((key, index) => [key, values[index]])));

		// Track each key separately so concurrent single-key gets can join
		uncachedKeys.forEach((key, index) => {
			const targetIndex = uncachedIndexes[index];
			const version = getInvalidationVersion(key);

			const keyPromise = loaderPromise
				.then((valuesByKey) => {
					const value = valuesByKey.get(key);
					storeIfVersionMatches(key, value, version);
					results[targetIndex] = value;
					return value;
				})
				.finally(() => {
					inflight.delete(key);
				});

			inflight.set(key, keyPromise);
			pendingPromises.push(keyPromise);
		});

		return Promise.all(pendingPromises).then(() => results);
	};

	/**
	 * Delete one or more keys locally and on other NodeBB instances.
	 *
	 * @param {string|string[]} keys Key(s) to delete.
	 */
	cache.del = function (keys) {
		if (!cache.enabled) {
			return;
		}
		const keysToDelete = Array.isArray(keys) ? keys : [keys];

		localDel(keysToDelete);
		pubsub.publish(`${cache.name}:ttlCache:del`, { id: instanceId, keys: keysToDelete });
	};
	cache.delete = cache.del;

	cache.reset = function () {
		pubsub.publish(`${cache.name}:ttlCache:reset`, {
			id: instanceId,
		});
		localReset();
	};
	cache.clear = cache.reset;

	function localReset() {
		ttlCache.clear();
		cache.hits = 0;
		cache.misses = 0;
	}

	function getInvalidationVersion(key) {
		return invalidationVersions.get(key) || 0;
	}

	/**
	 * Store a value only if its key was not invalidated since the load started.
	 *
	 * @param {string} key Cache key.
	 * @param {*} value Value to store.
	 * @param {number} version Invalidation version captured before loading.
	 */
	function storeIfVersionMatches(key, value, version) {
		if (getInvalidationVersion(key) === version) {
			cache.set(key, value);
		}
	}

	function localDel(keys) {
		keys.forEach((key) => {
			invalidationVersions.set(key, getInvalidationVersion(key) + 1);
			ttlCache.delete(key);
		});
	}

	pubsub.on(`${cache.name}:ttlCache:reset`, ({ id }) => {
		if (id !== instanceId) {
			localReset();
		}
	});

	pubsub.on(`${cache.name}:ttlCache:del`, ({ id, keys }) => {
		if (id !== instanceId && Array.isArray(keys)) {
			localDel(keys);
		}
	});

	cache.dump = function () {
		return {
			cache: Array.from(ttlCache.entries()),
			invalidationVersions: invalidationVersions.dump(),
		};
	};

	cache.peek = function (key) {
		return ttlCache.get(key, { updateAgeOnGet: false });
	};

	tracker.addCache(opts.name, cache);
	return cache;
};
