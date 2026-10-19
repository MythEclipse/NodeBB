'use strict';

/**
 * @typedef {object} CacheInstance
 * @property {string} name Cache name, used for pubsub channels and tracking.
 * @property {number} hits Number of cache hits.
 * @property {number} misses Number of cache misses.
 * @property {boolean} enabled Whether the cache is active.
 * @property {number} length Number of entries (backcompat alias of `calculatedSize`).
 * @property {number} calculatedSize Total calculated size of all entries.
 * @property {number} max Maximum number of entries.
 * @property {number} maxSize Maximum total calculated size.
 * @property {number} itemCount Number of entries (backcompat alias of `size`).
 * @property {number} size Number of entries.
 * @property {number} ttl Default TTL in milliseconds.
 */

/**
 * Create an LRU-backed cache.
 *
 * @param {object} opts Options passed through to `lru-cache`, plus `name` and `enabled`.
 * @param {string} [opts.name] Cache name, required for pubsub and tracking.
 * @param {boolean} [opts.enabled=true] When false, all cache operations are no-ops.
 * @returns {CacheInstance}
 */
module.exports = function (opts) {
	const { LRUCache } = require('lru-cache');
	const os = require('os');

	const pubsub = require('../pubsub');
	const tracker = require('./tracker');

	// lru-cache@7 deprecations
	const winston = require('winston');
	const chalk = require('chalk').default;

	const instanceId = `${os.hostname()}:${process.pid}`;

	// sometimes we kept passing in `length` with no corresponding `maxSize`.
	// This is now enforced in v7; drop superfluous property
	if (Object.hasOwn(opts, 'length') && !Object.hasOwn(opts, 'maxSize')) {
		winston.warn(`[cache/init(${opts.name})] ${chalk.white.bgRed.bold('DEPRECATION')} ${chalk.yellow('length')} was passed in without a corresponding ${chalk.yellow('maxSize')}. Both are now required as of lru-cache@7.0.0.`);
		delete opts.length;
	}

	const deprecatedOptions = new Map([
		['stale', 'allowStale'],
		['maxAge', 'ttl'],
		['length', 'sizeCalculation'],
	]);
	for (const [oldProp, newProp] of deprecatedOptions) {
		if (Object.hasOwn(opts, oldProp) && !Object.hasOwn(opts, newProp)) {
			winston.warn(`[cache/init(${opts.name})] ${chalk.white.bgRed.bold('DEPRECATION')} The option ${chalk.yellow(oldProp)} has been deprecated as of lru-cache@7.0.0. Please change this to ${chalk.yellow(newProp)} instead.`);
			opts[newProp] = opts[oldProp];
			delete opts[oldProp];
		}
	}

	const lruCache = new LRUCache(opts);
	if (!opts.name) {
		winston.warn(`[cache/init] ${chalk.white.bgRed.bold('WARNING')} The cache name is not set. This will be required in the future.\n ${new Error('Cache name not set').stack} `);
	}

	const cache = {
		name: opts.name,
		hits: 0,
		misses: 0,
		enabled: Object.hasOwn(opts, 'enabled') ? opts.enabled : true,
	};

	// expose properties while keeping backwards compatibility
	const propertyMap = new Map([
		['length', 'calculatedSize'],
		['calculatedSize', 'calculatedSize'],
		['max', 'max'],
		['maxSize', 'maxSize'],
		['itemCount', 'size'],
		['size', 'size'],
		['ttl', 'ttl'],
	]);
	for (const [cacheProp, lruProp] of propertyMap) {
		Object.defineProperty(cache, cacheProp, {
			get: function () {
				return lruCache[lruProp];
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

		return lruCache.has(key);
	};

	cache.set = function (key, value, ttl) {
		if (!cache.enabled) {
			return;
		}
		const setOpts = {};
		if (ttl) {
			setOpts.ttl = ttl;
		}
		lruCache.set(key, value, setOpts);
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
		const data = lruCache.get(key);
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
			const cachedValue = lruCache.get(key);

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
		pubsub.publish(`${cache.name}:lruCache:del`, {
			id: instanceId,
			keys: keysToDelete,
		});
	};
	cache.delete = cache.del;

	cache.reset = function () {
		pubsub.publish(`${cache.name}:lruCache:reset`, {
			id: instanceId,
		});
		localReset();
	};
	cache.clear = cache.reset;

	function localReset() {
		lruCache.clear();
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
			lruCache.delete(key);
		});
	}

	pubsub.on(`${cache.name}:lruCache:reset`, ({ id }) => {
		if (id !== instanceId) {
			localReset();
		}
	});

	pubsub.on(`${cache.name}:lruCache:del`, ({ id, keys }) => {
		if (id !== instanceId && Array.isArray(keys)) {
			localDel(keys);
		}
	});

	cache.dump = function () {
		return {
			cache: lruCache.dump(),
			invalidationVersions: invalidationVersions.dump(),
		};
	};

	cache.peek = function (key) {
		return lruCache.peek(key);
	};

	tracker.addCache(opts.name, cache);
	return cache;
};
