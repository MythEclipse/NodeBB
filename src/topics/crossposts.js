'use strict';

const winston = require('winston');
const _ = require('lodash');
const db = require('../database');
const topics = require('.');
const meta = require('../meta');
const user = require('../user');
const categories = require('../categories');
const posts = require('../posts');
const privileges = require('../privileges');
const activitypub = require('../activitypub');
const utils = require('../utils');

const Crossposts = module.exports;

// Sorted sets on category tids that mirror data owned by the topic's own category.
// `key` is the suffix after `cid:<cid>:`, and `field` is the topic field holding the score.
const reconciledScores = [
	{ key: 'tids:posts', field: 'postcount' },
	{ key: 'tids:votes', field: 'votes' },
	{ key: 'tids:views', field: 'viewcount' },
];

/**
 * Convert a numeric string to a number, leaving non-numeric values (such as
 * ActivityPub ids) untouched.
 *
 * @param {string|number} value
 * @returns {string|number}
 */
function toNumberIfNumeric(value) {
	return utils.isNumber(value) ? parseInt(value, 10) : value;
}

/**
 * Fetch a topic's crossposts.
 *
 * @param {string|number|Array<string|number>} tids A tid, or an array of tids
 * @param {number} [uid] Viewer uid. When set, crossposts into categories the viewer
 * cannot find are omitted.
 * @returns {Promise<object[]|object[][]>} Crossposts, shaped to match `tids`
 */
Crossposts.get = async function (tids, uid) {
	const isArray = Array.isArray(tids);
	if (!isArray) {
		tids = [tids];
	}

	const crosspostIdsByTid = await db.getSortedSetsMembers(tids.map(tid => `tid:${tid}:crossposts`));
	const crosspostIds = crosspostIdsByTid.flat();
	const crossposts = await db.getObjects(crosspostIds.map(id => `crosspost:${id}`));

	const allCids = _.uniq(crossposts.map(crosspost => crosspost.cid));
	const allowedCids = uid ? await privileges.categories.filterCids('find', allCids, uid) : allCids;

	const categoriesData = await categories.getCategoriesFields(
		allowedCids, ['cid', 'name', 'icon', 'bgColor', 'color', 'slug']
	);
	const categoriesMap = new Map(
		categoriesData.map(category => [parseInt(category.cid, 10), category])
	);

	const allowedCidSet = new Set(allowedCids);
	const visibleCrossposts = crosspostIds
		.map((id, index) => ({ id, crosspost: crossposts[index] }))
		.filter(({ crosspost }) => !uid || allowedCidSet.has(crosspost.cid));

	const crosspostMap = new Map();
	visibleCrossposts.forEach(({ id, crosspost }) => {
		if (!id || !crosspost) {
			return;
		}
		crosspost.id = id;
		crosspost.category = categoriesMap.get(parseInt(crosspost.cid, 10));
		crosspost.uid = toNumberIfNumeric(crosspost.uid);
		crosspost.cid = toNumberIfNumeric(crosspost.cid);
		crosspostMap.set(id, crosspost);
	});

	const crosspostsByTid = crosspostIdsByTid.map(
		ids => ids.map(id => crosspostMap.get(id)).filter(Boolean)
	);
	return isArray ? crosspostsByTid : crosspostsByTid[0];
};

/**
 * Reconcile the post/vote/view scores that crossposted categories hold for a topic.
 *
 * @param {object[]} crossposts The topic's crossposts
 * @param {object} topicData Topic data containing `tid`, `pinned` and the score fields
 * @returns {Promise<void>}
 */
Crossposts.syncCrosspostedTopicCids = async function (crossposts, topicData) {
	// `:tids:posts`, `:tids:votes` and `:tids:views` are only written for the topic's own
	// category, so crossposted categories keep the values they were seeded with. Reconcile
	// them when the topic is read, which is cheap and only runs for crossposted topics.
	// Pinned topics are absent from these zsets by design, so they are skipped.
	if (!crossposts.length || topicData.pinned) {
		return;
	}

	const cids = crossposts.map(crosspost => crosspost.cid);
	const scores = await db.sortedSetsScore(
		reconciledScores.flatMap(({ key }) => cids.map(cid => `cid:${cid}:${key}`)),
		topicData.tid
	);

	// Scores come back in request order — all post counts, then all vote counts, then all
	// view counts — so a field's block starts at `fieldIndex * cids.length`.
	const bulkAdd = [];
	cids.forEach((cid, cidIndex) => {
		reconciledScores.forEach(({ key, field }, fieldIndex) => {
			const currentScore = scores[(fieldIndex * cids.length) + cidIndex];
			if (topicData[field] !== currentScore) {
				bulkAdd.push([`cid:${cid}:${key}`, topicData[field], topicData.tid]);
			}
		});
	});

	if (bulkAdd.length) {
		await db.sortedSetAddBulk(bulkAdd);
	}
};

/**
 * Crosspost a topic into another category.
 *
 * `cid` is coerced up-front so that every comparison and database key below uses
 * the same string form; a numeric cid must not bypass the checks that follow.
 *
 * @param {string|number} tid
 * @param {string|number} cid Destination cid, local or remote (ActivityPub) identifier
 * @param {string|number} uid Actor performing the crosspost
 * @returns {Promise<object[]>} The topic's crossposts, including the new one
 */
Crossposts.add = async function (tid, cid, uid) {
	// NOTE: If uid is 0, the assumption is that it is a "system" crosspost, not a guest!
	// (Normally guest uid is 0)
	cid = String(cid);
	// Target cid must exist
	if (!utils.isNumber(cid)) {
		await activitypub.actors.assert(cid);
	}
	const [exists, destAllowed, sourceAllowed] = await Promise.all([
		categories.exists(cid),
		uid === 0 || privileges.categories.can('topics:crosspost', cid, uid),
		uid === 0 || privileges.topics.can('topics:read', tid, uid),
	]);
	if (!exists) {
		throw new Error('[[error:invalid-cid]]');
	}
	if (!destAllowed || !sourceAllowed) {
		throw new Error('[[error:not-allowed]]');
	}
	if (uid < 0) {
		throw new Error('[[error:invalid-uid]]');
	}

	const crossposts = await Crossposts.get(tid);
	const crosspostedCids = crossposts.map(crosspost => String(crosspost.cid));
	if (crosspostedCids.includes(cid)) {
		throw new Error('[[error:topic-already-crossposted]]');
	}

	const now = Date.now();
	const crosspostId = utils.generateUUID();
	const [topicData, pids, tags] = await Promise.all([
		topics.getTopicFields(tid, [
			'uid', 'cid', 'timestamp', 'lastposttime', 'pinned',
			'postcount', 'viewcount', 'upvotes', 'downvotes',
		]),
		topics.getPids(tid),
		topics.getTopicTags(tid),
	]);
	const pidTimestamps = (await posts.getPostsFields(pids, ['timestamp']))
		.map(({ timestamp }) => timestamp);

	if (cid === String(topicData.cid)) {
		throw new Error('[[error:invalid-cid]]');
	}

	// Scores are derived from topic data, not copied from the source category's
	// sorted sets — a pinned topic is absent from those sets, and copying a null
	// score throws (`[[error:invalid-score, null]]`)
	const votes = (parseInt(topicData.upvotes, 10) || 0) - (parseInt(topicData.downvotes, 10) || 0);
	const bulkAdd = [
		[`cid:${cid}:tids:lastposttime`, topicData.lastposttime, tid],
		[`cid:${cid}:uid:${topicData.uid}:tids`, topicData.timestamp, tid],
		...tags.map(tag => [`cid:${cid}:tag:${tag}:topics`, topicData.timestamp, tid]),
	];
	if (topicData.pinned) {
		bulkAdd.push([`cid:${cid}:tids:pinned`, now, tid]);
	} else {
		bulkAdd.push([`cid:${cid}:tids`, topicData.lastposttime, tid]);
		bulkAdd.push([`cid:${cid}:tids:create`, topicData.timestamp, tid]);
		bulkAdd.push([`cid:${cid}:tids:posts`, topicData.postcount || 0, tid]);
		bulkAdd.push([`cid:${cid}:tids:votes`, votes, tid]);
		bulkAdd.push([`cid:${cid}:tids:views`, topicData.viewcount || 0, tid]);
	}

	await Promise.all([
		db.sortedSetAddBulk(bulkAdd),
		db.sortedSetAdd(`cid:${cid}:pids`, pidTimestamps, pids),
		db.setObject(`crosspost:${crosspostId}`, { uid, tid, cid, timestamp: now }),
		db.sortedSetAdd(`tid:${tid}:crossposts`, now, crosspostId),
		uid > 0 ? db.sortedSetAdd(`uid:${uid}:crossposts`, now, crosspostId) : false,
		topics.events.log(tid, { uid, type: 'crosspost', toCid: cid }),
	]);
	await Promise.all([
		topics.updateCategoryTagsCount([cid], tags),
		categories.onTopicsMoved([cid]), // must be done after
	]);

	return [...crossposts, { id: crosspostId, uid, tid, cid, timestamp: now }];
};

/**
 * Add a pending crosspost to the post queue instead of creating it immediately.
 *
 * @param {string|number} tid
 * @param {string|number} cid Destination cid
 * @param {string|number} uid Actor requesting the crosspost
 * @returns {Promise<void>}
 */
Crossposts.queue = async function (tid, cid, uid) {
	if (!meta.config.postQueue) {
		return;
	}
	const title = await topics.getTopicField(tid, 'title');
	await posts.addToQueue({
		uid: uid || 0,
		tid,
		title,
		crosspostCid: cid,
	});
};

/**
 * Remove a topic's crosspost into the given category.
 *
 * `cid` is coerced before the moderator check, so a caller cannot pass a type
 * that compares equal in one place and not another.
 *
 * @param {string|number} tid
 * @param {string|number} cid Destination cid of the crosspost to remove
 * @param {string|number} uid Actor performing the removal
 * @returns {Promise<object[]>} The topic's remaining crossposts
 */
Crossposts.remove = async function (tid, cid, uid) {
	cid = String(cid);
	const crossposts = await Crossposts.get(tid);
	const [isPrivileged, isMod] = await Promise.all([
		user.isAdminOrGlobalMod(uid),
		user.isModerator(uid, cid),
	]);
	const crosspostId = crossposts.findLast(({ cid: crosspostCid, uid: crosspostUid }) => {
		const sameCid = cid === String(crosspostCid);
		const canRemove = isPrivileged || isMod || String(uid) === String(crosspostUid);
		return sameCid && canRemove;
	})?.id;
	if (!crosspostId) {
		throw new Error('[[error:invalid-data]]');
	}

	const [topicData, pids] = await Promise.all([
		topics.getTopicFields(tid, ['uid', 'tags']),
		topics.getPids(tid),
	]);
	const tags = topicData.tags.map(tag => tag.value);
	const bulkRemove = [
		`cid:${cid}:tids`,
		`cid:${cid}:tids:create`,
		`cid:${cid}:tids:lastposttime`,
		`cid:${cid}:tids:pinned`,
		`cid:${cid}:uid:${topicData.uid}:tids`,
		`cid:${cid}:tids:votes`,
		`cid:${cid}:tids:posts`,
		`cid:${cid}:tids:views`,
		...tags.map(tag => `cid:${cid}:tag:${tag}:topics`),
	].map(zset => [zset, tid]);

	await Promise.all([
		db.sortedSetRemoveBulk(bulkRemove),
		db.delete(`crosspost:${crosspostId}`),
		db.sortedSetRemove(`tid:${tid}:crossposts`, crosspostId),
		db.sortedSetRemove(`cid:${cid}:pids`, pids),
		uid > 0 ? db.sortedSetRemove(`uid:${uid}:crossposts`, crosspostId) : false,
	]);
	await Promise.all([
		topics.updateCategoryTagsCount([cid], tags),
		categories.onTopicsMoved([cid]),
	]);

	topics.events.find(tid, { uid, toCid: cid, type: 'crosspost' }).then((eventIds) => {
		topics.events.purge(tid, eventIds);
	}).catch(err => winston.error(err));

	return await Crossposts.get(tid);
};

/**
 * Remove every crosspost belonging to the given topics.
 *
 * @param {string|number|Array<string|number>} tids A tid, or an array of tids
 * @returns {Promise<void>}
 */
Crossposts.removeAll = async function (tids) {
	if (!Array.isArray(tids)) {
		tids = [tids];
	}
	const crosspostIds = (await db.getSortedSetsMembers(
		tids.map(tid => `tid:${tid}:crossposts`)
	)).flat();
	const crossposts = (await db.getObjects(
		crosspostIds.map(id => `crosspost:${id}`)
	)).filter(Boolean);

	await Promise.all(
		crossposts.map(({ tid, cid, uid }) => Crossposts.remove(tid, cid, uid))
	);
};
