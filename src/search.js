'use strict';

const _ = require('lodash');

const db = require('./database');
const batch = require('./batch');
const posts = require('./posts');
const topics = require('./topics');
const categories = require('./categories');
const user = require('./user');
const plugins = require('./plugins');
const privileges = require('./privileges');
const activitypub = require('./activitypub');
const utils = require('./utils');

const search = module.exports;

const IN_TOPIC_REGEX = /^in:topic-(\S+) /;
const CONTENT_SEARCH_IN = ['posts', 'titles', 'titlesposts', 'bookmarks'];

/**
 * Execute a search request across posts, topics, users, categories, or tags.
 *
 * @param {object} data Search parameters including query, searchIn, sortBy, etc.
 * @returns {Promise<object>} Search results object with matchCount, timing, and items.
 */
search.search = async function (data) {
	const start = process.hrtime();
	data.sortBy = data.sortBy || 'relevance';

	let result;
	switch (data.searchIn) {
		case 'users': {
			result = await user.search(data);
			break;
		}

		case 'categories': {
			result = await categories.search(data);
			break;
		}

		case 'tags': {
			result = await topics.searchAndLoadTags(data);
			break;
		}

		default: {
			if (CONTENT_SEARCH_IN.includes(data.searchIn)) {
				result = await searchInContent(data);
			} else if (data.searchIn) {
				result = await plugins.hooks.fire('filter:search.searchIn', {
					data,
				});
			} else {
				throw new Error('[[error:unknown-search-filter]]');
			}
		}
	}

	result.time = (process.elapsedTimeSince(start) / 1000).toFixed(2);
	return result;
};

/**
 * Perform a content-based search across posts, titles, or bookmarks.
 *
 * @param {object} data Search request options
 * @returns {Promise<object>} Content search result with posts array and pagination metadata
 */
async function searchInContent(data) {
	data.uid = data.uid || 0;

	const [searchCids, searchUids] = await Promise.all([
		getSearchCids(data),
		getSearchUids(data),
	]);

	async function doSearch(type, searchIn) {
		if (searchIn.includes(data.searchIn)) {
			const result = await plugins.hooks.fire('filter:search.query', {
				index: type,
				content: data.query,
				matchWords: data.matchWords || 'all',
				cid: searchCids,
				uid: searchUids,
				searchData: data,
				ids: [],
			});
			return Array.isArray(result) ? result : result.ids;
		}
		return [];
	}
	let pids;
	let tids = [];
	const inTopic = String(data.query || '').match(IN_TOPIC_REGEX);
	if (inTopic) {
		const tid = inTopic[1];
		const cleanedTerm = data.query.replace(inTopic[0], '');
		pids = await topics.search(tid, cleanedTerm);
	} else if (data.searchIn === 'bookmarks') {
		pids = await searchInBookmarks(data, searchCids, searchUids);
	} else {
		let result;
		if (data.uid && activitypub.helpers.isUri(data.query)) {
			const local = await activitypub.helpers.resolveLocalId(data.query);
			if (local.type === 'post') {
				result = [[local.id], []];
			} else {
				try {
					result = await fetchRemoteObject(data);
					if (result && Object.hasOwn(result, 'users')) {
						return result;
					}
				} catch {
					// Ignored: remote lookup failures fall back to local search
				}
			}
		}

		if (result) {
			[pids, tids] = result;
		} else {
			[pids, tids] = await Promise.all([
				doSearch('post', ['posts', 'titlesposts']),
				doSearch('topic', ['titles', 'titlesposts']),
			]);
		}
	}

	const mainPids = await topics.getMainPids(tids);

	let allPids = mainPids.concat(pids).filter(Boolean);

	allPids = await privileges.posts.filter('topics:read', allPids, data.uid);
	allPids = await filterAndSort(allPids, data);

	const metadata = await plugins.hooks.fire('filter:search.inContent', {
		pids: allPids,
		data,
	});

	if (data.returnIds) {
		const mainPidsSet = new Set(mainPids);
		const mainPidToTid = _.zipObject(mainPids, tids);
		const pidsSet = new Set(pids);
		const returnPids = allPids.filter(pid => pidsSet.has(pid));
		const returnTids = allPids.filter(pid => mainPidsSet.has(pid)).map(pid => mainPidToTid[pid]);
		return { pids: returnPids, tids: returnTids };
	}

	const itemsPerPage = Math.min(data.itemsPerPage || 10, 100);
	const returnData = {
		posts: [],
		matchCount: metadata.pids.length,
		pageCount: Math.max(1, Math.ceil(metadata.pids.length / itemsPerPage)),
	};

	if (data.page) {
		const start = Math.max(0, (data.page - 1)) * itemsPerPage;
		metadata.pids = metadata.pids.slice(start, start + itemsPerPage);
	}

	returnData.posts = await posts.getPostSummaryByPids(metadata.pids, data.uid, {
		extraFields: ['attachments'],
	});
	await plugins.hooks.fire('filter:search.contentGetResult', { result: returnData, data });
	delete metadata.pids;
	delete metadata.data;
	return Object.assign(returnData, metadata);
}

/**
 * Fetch and assert an ActivityPub remote object for search queries matching a URI.
 *
 * @param {object} data Search parameters containing uid and query URI
 * @returns {Promise<Array<string[]>|object|null>} Resolved pids/tids pair, user search result, or null
 */
async function fetchRemoteObject(data) {
	const { uid, query: uri } = data;

	try {
		let id = uri;
		let exists = await posts.exists(id);
		let tid = exists ? await posts.getPostField(id, 'tid') : undefined;
		if (!exists) {
			let type;
			({ id, type } = await activitypub.get('uid', 0, id));
			if (activitypub._constants.acceptedPostTypes.includes(type)) {
				exists = await posts.exists(id);
				if (!exists) {
					({ tid } = await activitypub.notes.assert(uid, id));
				} else {
					tid = await posts.getPostField(id, 'tid');
				}
			} else if (activitypub._constants.acceptableActorTypes.has(type)) {
				data.searchIn = 'users';
				return await user.search(data);
			} else if (activitypub._constants.acceptable.contextTypes.has(type)) {
				({ tid } = await activitypub.notes.assert(uid, id));
				id = await topics.getTopicField(tid, 'mainPid');
			}
		}

		return tid ? [[id], []] : null;
	} catch {
		return null;
	}
}

/**
 * Search inside user's bookmarked posts.
 *
 * @param {object} data Search parameters containing uid, query, and matchWords
 * @param {Array<number|string>} searchCids Category IDs to filter by
 * @param {Array<number|string>} searchUids User IDs to filter by
 * @returns {Promise<Array<number|string>>} Matching post IDs
 */
async function searchInBookmarks(data, searchCids, searchUids) {
	const { uid, query, matchWords } = data;
	const allPids = [];
	await batch.processSortedSet(`uid:${uid}:bookmarks`, async (pids) => {
		if (Array.isArray(searchCids) && searchCids.length) {
			pids = await posts.filterPidsByCid(pids, searchCids);
		}
		if (Array.isArray(searchUids) && searchUids.length) {
			pids = await posts.filterPidsByUid(pids, searchUids);
		}
		if (query) {
			const tokens = String(query).split(' ');
			const postData = await db.getObjectsFields(pids.map(pid => `post:${pid}`), ['content', 'tid']);
			const tids = _.uniq(postData.map(p => p.tid));
			const topicData = await db.getObjectsFields(tids.map(tid => `topic:${tid}`), ['title']);
			const tidToTopic = _.zipObject(tids, topicData);
			pids = pids.filter((pid, i) => {
				const content = String(postData[i].content);
				const title = String(tidToTopic[postData[i].tid]?.title || '');
				const method = (matchWords === 'any' ? 'some' : 'every');
				return tokens[method](
					token => content.includes(token) || title.includes(token)
				);
			});
		}
		allPids.push(...pids);
	}, {
		batch: 500,
	});

	return allPids;
}

/**
 * Apply filters (post count, time range, tags) and sorting to a list of post IDs.
 *
 * @param {Array<number|string>} pids Post IDs
 * @param {object} data Filter and sort criteria
 * @returns {Promise<Array<number|string>>} Filtered and sorted post IDs
 */
async function filterAndSort(pids, data) {
	if (data.sortBy === 'relevance' &&
		!data.replies &&
		!data.timeRange &&
		!data.hasTags &&
		data.searchIn !== 'bookmarks' &&
		!plugins.hooks.hasListeners('filter:search.filterAndSort')) {
		return pids;
	}
	let postsData = await getMatchedPosts(pids, data);
	if (!postsData.length) {
		return pids;
	}
	postsData = postsData.filter(Boolean);

	postsData = filterByPostcount(postsData, data.replies, data.repliesFilter);
	postsData = filterByTimerange(postsData, data.timeRange, data.timeFilter);
	postsData = filterByTags(postsData, data.hasTags);

	sortPosts(postsData, data);

	const result = await plugins.hooks.fire('filter:search.filterAndSort', { pids, posts: postsData, data });
	return result.posts.map(post => post && post.pid);
}

/**
 * Fetch hydrated post, topic, and category data for filtering and sorting.
 *
 * @param {Array<number|string>} pids Post IDs
 * @param {object} data Search parameters
 * @returns {Promise<object[]>} Hydrated post objects
 */
async function getMatchedPosts(pids, data) {
	const postFields = ['pid', 'uid', 'tid', 'timestamp', 'deleted', 'upvotes', 'downvotes'];

	let postsData = await posts.getPostsFields(pids, postFields);
	postsData = postsData.filter(post => post && !post.deleted);
	const uids = _.uniq(postsData.map(post => post.uid));
	const tids = _.uniq(postsData.map(post => post.tid));

	const [users, topics] = await Promise.all([
		getUsers(uids, data),
		getTopics(tids, data),
	]);

	const tidToTopic = _.zipObject(tids, topics);
	const uidToUser = _.zipObject(uids, users);
	postsData.forEach((post) => {
		if (topics && tidToTopic[post.tid]) {
			post.topic = tidToTopic[post.tid];
			if (post.topic && post.topic.category) {
				post.category = post.topic.category;
			}
		}

		if (uidToUser[post.uid]) {
			post.user = uidToUser[post.uid];
		}
	});

	return postsData.filter(post => post && post.topic && !post.topic.deleted);
}

/**
 * Fetch username data for posts when sorting by user.
 *
 * @param {Array<number|string>} uids User IDs
 * @param {object} data Search parameters
 * @returns {Promise<object[]>} Users list
 */
async function getUsers(uids, data) {
	if (data.sortBy.startsWith('user')) {
		return user.getUsersFields(uids, ['username']);
	}
	return [];
}

/**
 * Fetch topic objects with associated categories and normalized tags.
 *
 * @param {Array<number|string>} tids Topic IDs
 * @param {object} data Search parameters
 * @returns {Promise<object[]>} Hydrated topic objects
 */
async function getTopics(tids, data) {
	const topicsData = await topics.getTopicsData(tids);
	const cids = _.uniq(topicsData.map(topic => topic && topic.cid));
	const categories = await getCategories(cids, data);

	const cidToCategory = _.zipObject(cids, categories);
	topicsData.forEach((topic) => {
		if (topic && categories && cidToCategory[topic.cid]) {
			topic.category = cidToCategory[topic.cid];
		}
		if (topic && topic.tags) {
			topic.tags = topic.tags.map(tag => tag.value);
		}
	});

	return topicsData;
}

/**
 * Fetch category fields required for category-based sorting.
 *
 * @param {Array<number|string>} cids Category IDs
 * @param {object} data Search parameters
 * @returns {Promise<object[]|null>} Category objects or null
 */
async function getCategories(cids, data) {
	const categoryFields = [];

	if (data.sortBy.startsWith('category.')) {
		categoryFields.push(data.sortBy.split('.')[1]);
	}
	if (!categoryFields.length) {
		return null;
	}

	return await db.getObjectsFields(cids.map(cid => `category:${cid}`), categoryFields);
}

/**
 * Filter posts by topic reply count.
 *
 * @param {object[]} posts Post objects
 * @param {number|string} postCount Minimum or maximum reply count
 * @param {string} repliesFilter 'atleast' or 'atmost'
 * @returns {object[]} Filtered post objects
 */
function filterByPostcount(posts, postCount, repliesFilter) {
	postCount = parseInt(postCount, 10);
	if (postCount) {
		if (repliesFilter === 'atleast') {
			posts = posts.filter(post => post.topic && post.topic.postcount >= postCount);
		} else {
			posts = posts.filter(post => post.topic && post.topic.postcount <= postCount);
		}
	}
	return posts;
}

/**
 * Filter posts by timestamp range.
 *
 * @param {object[]} posts Post objects
 * @param {number|string} timeRange Duration in seconds
 * @param {string} timeFilter 'newer' or 'older'
 * @returns {object[]} Filtered post objects
 */
function filterByTimerange(posts, timeRange, timeFilter) {
	timeRange = parseInt(timeRange, 10) * 1000;
	if (timeRange) {
		const time = Date.now() - timeRange;
		if (timeFilter === 'newer') {
			posts = posts.filter(post => post.timestamp >= time);
		} else {
			posts = posts.filter(post => post.timestamp <= time);
		}
	}
	return posts;
}

/**
 * Filter posts by required topic tags.
 *
 * @param {object[]} posts Post objects
 * @param {string[]} hasTags Array of required tag strings
 * @returns {object[]} Filtered post objects
 */
function filterByTags(posts, hasTags) {
	if (Array.isArray(hasTags) && hasTags.length) {
		return posts.filter(post =>
			Array.isArray(post?.topic?.tags) &&
			hasTags.every(tag => post.topic.tags.includes(tag))
		);
	}
	return posts;
}

/**
 * In-place sort post objects by relevance, timestamp, numeric or string field.
 *
 * @param {object[]} posts Post objects to sort
 * @param {object} data Search parameters including sortBy and sortDirection
 */
function sortPosts(posts, data) {
	if (!posts.length || data.sortBy === 'relevance') {
		return;
	}

	data.sortDirection = data.sortDirection || 'desc';
	const direction = data.sortDirection === 'desc' ? 1 : -1;
	const fields = data.sortBy.split('.');
	if (fields.length === 1) {
		return posts.sort((p1, p2) => direction * (p2[fields[0]] - p1[fields[0]]));
	}

	const [rootField, subField] = fields;
	const firstPost = posts[0];
	if (!fields || fields.length !== 2 || !firstPost[rootField] || !firstPost[rootField][subField]) {
		return;
	}

	const isNumeric = utils.isNumber(firstPost[rootField][subField]);

	if (isNumeric) {
		posts.sort((p1, p2) => direction * (p2[rootField][subField] - p1[rootField][subField]));
	} else {
		posts.sort((p1, p2) => {
			const val1 = p1[rootField]?.[subField];
			const val2 = p2[rootField]?.[subField];
			if (val1 > val2) {
				return -direction;
			} else if (val1 < val2) {
				return direction;
			}
			return 0;
		});
	}
}

/**
 * Resolve target category IDs including watched categories and child categories.
 *
 * @param {object} data Search parameters
 * @returns {Promise<Array<number|string>>} List of category IDs
 */
async function getSearchCids(data) {
	if (!Array.isArray(data.categories) || !data.categories.length) {
		return [];
	}

	if (data.categories.includes('all')) {
		return await categories.getCidsByPrivilege('categories:cid', data.uid, 'read');
	}

	const [watchedCids, childrenCids] = await Promise.all([
		getWatchedCids(data),
		getChildrenCids(data),
	]);
	return _.uniq(watchedCids.concat(childrenCids).concat(data.categories).filter(Boolean));
}

/**
 * Resolve watched category IDs for the user.
 *
 * @param {object} data Search parameters containing uid and categories
 * @returns {Promise<Array<number|string>>} Watched category IDs
 */
async function getWatchedCids(data) {
	if (!data.categories.includes('watched')) {
		return [];
	}
	return await user.getWatchedCategories(data.uid);
}

/**
 * Resolve accessible child category IDs when searchChildren is enabled.
 *
 * @param {object} data Search parameters containing categories, uid, and searchChildren
 * @returns {Promise<Array<number|string>>} Filtered child category IDs
 */
async function getChildrenCids(data) {
	if (!data.searchChildren) {
		return [];
	}
	const childrenCids = await Promise.all(data.categories.map(categories.getChildrenCids));
	return await privileges.categories.filterCids(
		'find',
		_.uniq(_.flatten(childrenCids)),
		data.uid
	);
}

/**
 * Resolve author user IDs from postedBy search parameter.
 *
 * @param {object} data Search parameters containing postedBy
 * @returns {Promise<number[]>} User IDs
 */
async function getSearchUids(data) {
	if (!data.postedBy) {
		return [];
	}
	return await user.getUidsByUsernames(Array.isArray(data.postedBy) ? data.postedBy : [data.postedBy]);
}

require('./promisify')(search);
