'use strict';

const assert = require('assert');

// Side-effect import: initialises nconf/database needed by src/pubsub.
const db = require('./mocks/databasemock');

const cacheCreate = require('../src/cache/lru');

describe('cache', () => {
	it('should only call loader function once if key is same', async () => {
		const cache = cacheCreate({ name: 'testCache1', max: 10 });
		let loadCount = 0;
		const loader = async () => {
			loadCount += 1;
			return 'value';
		};

		const [first, second, third] = await Promise.all([
			cache.get('key', loader),
			cache.get('key', loader),
			cache.get('key', loader),
		]);

		assert.strictEqual(first, 'value');
		assert.strictEqual(second, 'value');
		assert.strictEqual(third, 'value');
		assert.strictEqual(loadCount, 1);
	});

	it('should only call loader function once if keys are same', async () => {
		const cache = cacheCreate({ name: 'testCache2', max: 10 });
		let loadCount = 0;
		const loader = async (keys) => {
			loadCount += 1;
			return keys.map(() => 'value');
		};

		const [first, second, third] = await Promise.all([
			cache.getMany(['key1', 'key2'], loader),
			cache.getMany(['key1', 'key2'], loader),
			cache.getMany(['key1', 'key2'], loader),
		]);

		assert.deepStrictEqual(first, ['value', 'value']);
		assert.deepStrictEqual(second, ['value', 'value']);
		assert.deepStrictEqual(third, ['value', 'value']);
		assert.strictEqual(loadCount, 1);
	});
});
