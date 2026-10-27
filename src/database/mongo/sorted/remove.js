'use strict';

module.exports = function (module) {
	const helpers = require('../helpers');

	// Explicit hints keep mongo on the index that matches the query shape.
	const hintKeyValue = { _key: 1, value: -1 };
	const hintKeyScore = { _key: 1, score: -1 };

	/**
	 * Removes one or more members from one or more sorted sets.
	 * @param {string|string[]} key
	 * @param {string|number|Array<string|number>} value
	 * @returns {Promise<void>}
	 */
	module.sortedSetRemove = async function (key, value) {
		if (!key) {
			return;
		}
		const isValueArray = Array.isArray(value);
		if (!value || (isValueArray && !value.length)) {
			return;
		}

		if (isValueArray) {
			value = value.map(helpers.valueToString);
		} else {
			value = helpers.valueToString(value);
		}

		await module.client.collection('objects').deleteMany({
			_key: Array.isArray(key) ? { $in: key } : key,
			value: isValueArray ? { $in: value } : value,
		}, {
			hint: hintKeyValue,
		});
	};

	/**
	 * Removes the same member from several sorted sets.
	 * @param {string[]} keys
	 * @param {string|number} value
	 * @returns {Promise<void>}
	 */
	module.sortedSetsRemove = async function (keys, value) {
		if (!Array.isArray(keys) || !keys.length) {
			return;
		}
		value = helpers.valueToString(value);

		await module.client.collection('objects').deleteMany({
			_key: { $in: keys }, value,
		}, {
			hint: hintKeyValue,
		});
	};

	/**
	 * Removes every member of the given sets whose score falls within `[min, max]`.
	 * @param {string[]} keys
	 * @param {string|number} min '-inf' for no lower bound
	 * @param {string|number} max '+inf' for no upper bound
	 * @returns {Promise<void>}
	 */
	module.sortedSetsRemoveRangeByScore = async function (keys, min, max) {
		if (!Array.isArray(keys) || !keys.length) {
			return;
		}
		const query = { _key: { $in: keys } };
		if (keys.length === 1) {
			query._key = keys[0];
		}
		if (min !== '-inf') {
			query.score = { $gte: parseFloat(min) };
		}
		if (max !== '+inf') {
			query.score = query.score || {};
			query.score.$lte = parseFloat(max);
		}

		await module.client.collection('objects').deleteMany(query, {
			hint: hintKeyScore,
		});
	};

	/**
	 * Removes many `[key, value]` pairs in a single delete.
	 * @param {Array<[string, string|number]>} data
	 * @returns {Promise<void>}
	 */
	module.sortedSetRemoveBulk = async function (data) {
		if (!Array.isArray(data) || !data.length) {
			return;
		}
		await module.client.collection('objects').deleteMany({
			$or: data.map(([key, value]) => ({ _key: key, value: String(value) })),
		}, {
			hint: hintKeyValue,
		});
	};
};
