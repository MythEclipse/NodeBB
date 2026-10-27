'use strict';

module.exports = function (module) {
	const _ = require('lodash');
	const helpers = require('./helpers');
	const { secureRandom } = require('../../utils');

	// Explicit hints keep mongo on the index that matches the query shape.
	const hintKeyScore = { _key: 1, score: -1 };
	const hintMembersKey = { members: 1, _key: 1 };

	/**
	 * Runs `retry` when the error is the duplicate key error mongo raises when
	 * two concurrent upserts try to create the same document, rethrows otherwise.
	 * @param {Error} err error thrown by the failing operation
	 * @param {Array} context extra values logged next to the stack trace
	 * @param {Function} retry operation to run again
	 * @returns {Promise<void>}
	 */
	async function retryOnDuplicateKey(err, context, retry) {
		if (!err || !err.message.includes('E11000 duplicate key error')) {
			throw err;
		}
		console.log(new Error('e11000').stack, ...context);
		return await retry();
	}

	/**
	 * Adds one or more members to a set, creating the set if it does not exist.
	 * @param {string} key
	 * @param {string|number|Array<string|number>} value
	 * @returns {Promise<void>}
	 */
	module.setAdd = async function (key, value) {
		if (!Array.isArray(value)) {
			value = [value];
		}
		if (!value.length) {
			return;
		}
		value = value.map(helpers.valueToString);

		try {
			await module.client.collection('objects').updateOne({
				_key: key,
			}, {
				$addToSet: {
					members: {
						$each: value,
					},
				},
			}, {
				upsert: true,
			});
		} catch (err) {
			return await retryOnDuplicateKey(err, [key, value], () => module.setAdd(key, value));
		}
	};

	/**
	 * Adds the same member(s) to several sets in a single unordered bulk write.
	 * @param {string[]} keys
	 * @param {string|number|Array<string|number>} value
	 * @returns {Promise<void>}
	 */
	module.setsAdd = async function (keys, value) {
		if (!Array.isArray(keys) || !keys.length) {
			return;
		}

		if (!Array.isArray(value)) {
			value = [value];
		}

		value = value.map(helpers.valueToString);

		const bulk = module.client.collection('objects').initializeUnorderedBulkOp();
		keys.forEach((key) => {
			bulk.find({ _key: key }).upsert().updateOne({
				$addToSet: {
					members: {
						$each: value,
					},
				},
			});
		});

		try {
			await bulk.execute();
		} catch (err) {
			return await retryOnDuplicateKey(err, [keys, value], () => module.setsAdd(keys, value));
		}
	};

	/**
	 * Adds a list of `[key, member]` pairs to their respective sets.
	 * @param {Array<[string, string|number]>} data
	 * @returns {Promise<void>}
	 */
	module.setAddBulk = async function (data) {
		if (!data.length) {
			return;
		}

		const bulk = module.client.collection('objects').initializeUnorderedBulkOp();

		data.forEach(([key, member]) => {
			bulk.find({ _key: key }).upsert().updateOne({
				$addToSet: {
					members: helpers.valueToString(member),
				},
			});
		});

		try {
			await bulk.execute();
		} catch (err) {
			return await retryOnDuplicateKey(err, [data], () => module.setAddBulk(data));
		}
	};

	/**
	 * Removes one or more members from a set.
	 * @param {string|string[]} key
	 * @param {string|number|Array<string|number>} value
	 * @returns {Promise<void>}
	 */
	module.setRemove = async function (key, value) {
		await bulkSetRemove(key, value);
	};

	/**
	 * Removes the same member from several sets.
	 * @param {string[]} keys
	 * @param {string|number|Array<string|number>} value
	 * @returns {Promise<void>}
	 */
	module.setsRemove = async function (keys, value) {
		if (!Array.isArray(keys) || !keys.length) {
			return;
		}
		await bulkSetRemove(keys, value);
	};

	/**
	 * Pulls members from one or many sets, then drops sets left without members.
	 * @param {string|string[]} key
	 * @param {string|number|Array<string|number>} values
	 * @returns {Promise<void>}
	 */
	async function bulkSetRemove(key, values) {
		const isKeyArray = Array.isArray(key);
		if (!key || (isKeyArray && !key.length)) return;

		const filterKey = isKeyArray ? { $in: key } : key;
		const update = Array.isArray(values) ?
			{ $pullAll: { members: values.map(helpers.valueToString) } } :
			{ $pull: { members: helpers.valueToString(values) } };

		await module.client.collection('objects').bulkWrite([
			{ updateMany: { filter: { _key: filterKey }, update: update } },
			{ deleteMany: { filter: { _key: filterKey, members: [] } } },
		], { ordered: true });
	}

	/**
	 * @param {string} key
	 * @param {string|number} value
	 * @returns {Promise<boolean>} whether the set contains the member
	 */
	module.isSetMember = async function (key, value) {
		if (!key) {
			return false;
		}
		value = helpers.valueToString(value);

		const item = await module.client.collection('objects').findOne({
			_key: key, members: value,
		}, {
			projection: { _id: 0, _key: 1 },
			hint: hintMembersKey,
		});

		return item !== null && item !== undefined;
	};

	/**
	 * Checks several members against a single set in one round trip.
	 * @param {string} key
	 * @param {Array<string|number>} values
	 * @returns {Promise<boolean[]>} one entry per input value, in order
	 */
	module.isSetMembers = async function (key, values) {
		if (!key || !Array.isArray(values) || !values.length) {
			return [];
		}
		const stringValues = values.map(v => helpers.valueToString(v));

		const pipeline = [
			{
				$match: {
					_key: key,
					members: { $in: stringValues, $exists: true }, // Trigger the partial index
				},
			},
			{
				$project: {
					_id: 0,
					results: {
						$map: {
							input: stringValues,
							as: 'val',
							in: { $in: ['$$val', '$members'] },
						},
					},
				},
			},
		];

		const [doc] = await module.client.collection('objects')
			.aggregate(pipeline, { hint: hintMembersKey })
			.toArray();
		return doc ? doc.results : values.map(() => false);
	};

	/**
	 * Checks whether a member is present in each of the given sets.
	 * @param {string[]} sets
	 * @param {string|number} value
	 * @returns {Promise<boolean[]>} one entry per set, in order
	 */
	module.isMemberOfSets = async function (sets, value) {
		if (!Array.isArray(sets) || !sets.length) {
			return [];
		}
		value = helpers.valueToString(value);

		const result = await module.client.collection('objects').find({
			_key: { $in: sets }, members: value,
		}, {
			projection: { _id: 0, _key: 1 },
			hint: hintMembersKey,
		}).toArray();

		const foundMembers = new Set(result.map(item => item._key));
		return sets.map(set => foundMembers.has(set));
	};

	/**
	 * @param {string} key
	 * @returns {Promise<string[]>} the members of the set, empty if it does not exist
	 */
	module.getSetMembers = async function (key) {
		if (!key) {
			return [];
		}

		const data = await module.client.collection('objects').findOne({
			_key: key,
		}, {
			projection: { _id: 0, members: 1 },
			hint: hintKeyScore,
		});
		return data ? data.members : [];
	};

	/**
	 * @param {string[]} keys
	 * @returns {Promise<string[][]>} members per key, in the same order as `keys`
	 */
	module.getSetsMembers = async function (keys) {
		if (!Array.isArray(keys) || !keys.length) {
			return [];
		}
		const data = await module.client.collection('objects').find({
			_key: { $in: keys },
		}, {
			projection: { _id: 0 },
			hint: hintKeyScore,
		}).toArray();

		const sets = Object.create(null);
		data.forEach((set) => {
			sets[set._key] = set.members || [];
		});

		return keys.map(k => sets[k] || []);
	};

	/**
	 * @param {string} key
	 * @returns {Promise<number>} number of members in the set
	 */
	module.setCount = async function (key) {
		if (!key) {
			return 0;
		}
		const data = await module.client.collection('objects').aggregate([
			{ $match: { _key: key } },
			{ $project: { _id: 0, count: { $size: '$members' } } },
		], { hint: hintKeyScore }).toArray();
		return Array.isArray(data) && data.length ? data[0].count : 0;
	};

	/**
	 * @param {string[]} keys
	 * @returns {Promise<number[]>} member count per key, in the same order as `keys`
	 */
	module.setsCount = async function (keys) {
		const data = await module.client.collection('objects').aggregate([
			{ $match: { _key: { $in: keys } } },
			{ $project: { _id: 0, _key: 1, count: { $size: '$members' } } },
		], { hint: hintKeyScore }).toArray();
		const map = _.keyBy(data, '_key');
		return keys.map(key => (Object.hasOwn(map, key) ? map[key].count : 0));
	};

	/**
	 * Removes and returns a randomly picked member of the set.
	 * @param {string} key
	 * @returns {Promise<string|undefined>} the removed member, undefined if the set is empty
	 */
	module.setRemoveRandom = async function (key) {
		const data = await module.client.collection('objects').findOne({ _key: key });
		if (!data) {
			return;
		}

		const randomIndex = secureRandom(0, data.members.length - 1);
		const value = data.members[randomIndex];
		await module.setRemove(data._key, value);
		return value;
	};
};
