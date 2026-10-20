'use strict';

const nconf = require('nconf');
const path = require('path');
const winston = require('winston');
const qs = require('querystring');
const validator = require('validator');

const user = require('../user');
const meta = require('../meta');
const topics = require('../topics');
const categories = require('../categories');
const posts = require('../posts');
const privileges = require('../privileges');
const helpers = require('./helpers');
const pagination = require('../pagination');
const utils = require('../utils');
const analytics = require('../analytics');
const activitypub = require('../activitypub');
const translator = require('../translator');
const cacheCreate = require('../cache/lru');
const crosspostCache = cacheCreate({
	name: 'crosspost',
	max: 500,
	ttl: 3600000,
});

const topicsController = module.exports;

const url = nconf.get('url');
const baseUrl = nconf.get('base_url');
const relativePath = nconf.get('relative_path');
const uploadUrl = nconf.get('upload_url');
const validSorts = ['oldest_to_newest', 'newest_to_oldest', 'most_votes'];

/**
 * Render a topic, redirecting first if the requested URL is not canonical.
 *
 * Slugs, post indices and sort order are all normalised here, so links that
 * point at a stale slug or an out-of-range post end up on the canonical page.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
topicsController.get = async function getTopic(req, res, next) {
	const tid = req.params.topic_id;
	if (
		(req.params.post_index && !utils.isNumber(req.params.post_index) && req.params.post_index !== 'unread') ||
		(!utils.isNumber(tid) && !validator.isUUID(String(tid)))
	) {
		return next();
	}
	let postIndex = parseInt(req.params.post_index, 10) || 1;
	const topicData = await topics.getTopicData(tid);
	if (!topicData) {
		return next();
	}
	const [
		userPrivileges,
		settings,
		rssToken,
	] = await Promise.all([
		privileges.topics.get(tid, req.uid),
		user.getSettings(req.uid),
		user.auth.getFeedToken(req.uid),
	]);

	let currentPage = parseInt(req.query.page, 10) || 1;
	const pageCount = Math.max(1, Math.ceil(topicData.postcount / settings.postsPerPage));
	const invalidPagination = (settings.usePagination && (currentPage < 1 || currentPage > pageCount));
	if (
		userPrivileges.disabled ||
		invalidPagination ||
		(topicData.scheduled && !userPrivileges.view_scheduled)
	) {
		return next();
	}

	if (
		!userPrivileges['topics:read'] ||
		(!topicData.scheduled && topicData.deleted && !userPrivileges.view_deleted) ||
		await shouldHideTopicFromGuest(req.uid, tid, topicData.cid)
	) {
		// Respond 404 (not 403) so restricted topics are indistinguishable from missing ones
		return next();
	}

	if (req.params.post_index === 'unread') {
		postIndex = await topics.getUserBookmark(tid, req.uid);
	}

	const hasSlug = Boolean(topicData.slug) && topicData.slug !== `${tid}/`;
	const hasStaleSlug = hasSlug && (!req.params.slug || topicData.slug !== `${tid}/${req.params.slug}`);
	if (!res.locals.isAPI && hasStaleSlug) {
		const indexSegment = postIndex ? `/${postIndex}` : '';
		return helpers.redirect(res, `/topic/${topicData.slug}${indexSegment}${generateQueryString(req.query)}`, false);
	}

	const postIndexOutOfRange = utils.isNumber(postIndex) &&
		topicData.postcount > 0 &&
		(postIndex < 1 || postIndex > topicData.postcount);
	if (postIndexOutOfRange) {
		const indexSegment = postIndex > topicData.postcount ? `/${topicData.postcount}` : '';
		return helpers.redirect(res, `/topic/${tid}/${req.params.slug}${indexSegment}${generateQueryString(req.query)}`);
	}
	postIndex = Math.max(1, postIndex);
	const selectedSort = String(req.query.sort || settings.topicPostSort);
	const sort = validSorts.includes(selectedSort) ? selectedSort : meta.config.topicPostSort;

	const set = sort === 'most_votes' ? `tid:${tid}:posts:votes` : `tid:${tid}:posts`;
	const reverse = sort === 'newest_to_oldest' || sort === 'most_votes';

	if (!req.query.page) {
		currentPage = calculatePageFromIndex(postIndex, settings);
	}
	if (settings.usePagination && req.query.page) {
		const top = ((currentPage - 1) * settings.postsPerPage) + 1;
		const bottom = top + settings.postsPerPage;
		if (!req.params.post_index || (postIndex < top || postIndex > bottom)) {
			postIndex = top;
		}
	}
	const { start, stop } = calculateStartStop(currentPage, postIndex, settings);

	await topics.getTopicWithPosts(topicData, set, req.uid, start, stop, reverse);

	topics.modifyPostsByPrivilege(topicData, userPrivileges);
	topicData.tagWhitelist = categories.filterTagWhitelist(topicData.tagWhitelist, userPrivileges.isAdminOrMod);

	topicData.privileges = userPrivileges;
	topicData.topicStaleDays = meta.config.topicStaleDays;
	topicData['reputation:disabled'] = meta.config['reputation:disabled'];
	topicData['downvote:disabled'] = meta.config['downvote:disabled'];
	topicData.upvoteVisibility = meta.config.upvoteVisibility;
	topicData.downvoteVisibility = meta.config.downvoteVisibility;
	topicData['feeds:disableRSS'] = meta.config['feeds:disableRSS'] || 0;
	topicData['signatures:hideDuplicates'] = meta.config['signatures:hideDuplicates'];
	topicData.bookmarkThreshold = meta.config.bookmarkThreshold;
	topicData.necroThreshold = meta.config.necroThreshold;
	topicData.postEditDuration = meta.config.postEditDuration;
	topicData.postDeleteDuration = meta.config.postDeleteDuration;
	topicData.scrollToMyPost = settings.scrollToMyPost;
	topicData.updateUrlWithPostIndex = settings.updateUrlWithPostIndex;
	topicData.allowMultipleBadges = meta.config.allowMultipleBadges === 1;
	topicData.privateUploads = meta.config.privateUploads === 1;
	topicData.showPostPreviewsOnHover = meta.config.showPostPreviewsOnHover === 1;
	topicData.sortOption = sort;
	topicData.sortOptionLabel = `[[topic:${sort.replace(/_/g, '-')}]]`;
	if (!meta.config['feeds:disableRSS']) {
		topicData.rssFeedUrl = `${relativePath}/topic/${topicData.tid}.rss`;
		if (req.loggedIn) {
			topicData.rssFeedUrl += `?uid=${req.uid}&token=${rssToken}`;
		}
	}

	topicData.postIndex = postIndex;
	const postAtIndex = topicData.posts.find(p => parseInt(p.index, 10) === Math.max(0, postIndex - 1));

	const [author, crossposts, canCrosspost] = await Promise.all([
		user.getUserFields(topicData.uid, ['username', 'userslug']),
		topics.crossposts.get(topicData.tid, req.uid),
		loadCrosspostPrivilege(req, topicData.cid),
		buildBreadcrumbs(topicData),
		addOldCategory(topicData, userPrivileges, settings.userLang),
		addTags(topicData, req, res, currentPage, postAtIndex),
		topics.increaseViewCount(req, tid),
		markAsRead(req, tid),
		analytics.increment([`pageviews:byCid:${topicData.category.cid}`]),
	]);

	topicData.author = author;
	topicData.crossposts = crossposts;
	topicData.canCrosspost = canCrosspost;

	// not awaited on purpose so topic loading is not blocked
	topics.crossposts.syncCrosspostedTopicCids(crossposts, topicData)
		.catch(err => winston.error(err.stack));

	topicData.pagination = pagination.create(currentPage, pageCount, req.query);
	topicData.pagination.rel.forEach((rel) => {
		rel.href = `${url}/topic/${topicData.slug}${rel.href}`;
		res.locals.linkTags.push(rel);
	});

	if (meta.config.activitypubEnabled) {
		if (postAtIndex) {
			// Include link header for richer parsing
			const { pid } = postAtIndex;
			const href = utils.isNumber(pid) ? `${nconf.get('url')}/post/${pid}` : pid;
			res.set('Link', `<${href}>; rel="alternate"; type="application/activity+json"`);
		}

		if (req.uid > 0 && !utils.isNumber(topicData.mainPid)) {
			// not awaited on purpose so topic loading is not blocked
			activitypub.notes.backfill(topicData.mainPid);
		}
	}

	res.render('topic', topicData);
};

/**
 * Whether a topic should be hidden from guests (responded to with a 404).
 *
 * Only uncategorised (`cid === -1`) topics whose posts have no numeric uid
 * (i.e. remote ActivityPub topics) are hidden; everything else stays visible.
 *
 * @param {number} uid Uid of the requesting user
 * @param {string} tid
 * @param {number} cid
 * @returns {Promise<boolean>}
 */
async function shouldHideTopicFromGuest(uid, tid, cid) {
	if (uid > 0 || cid !== -1) {
		return false;
	}
	const posterUids = await topics.getUids(tid);
	return !posterUids.some(posterUid => utils.isNumber(posterUid));
}

function generateQueryString(query) {
	const serialized = qs.stringify(query);
	return serialized.length ? `?${serialized}` : '';
}

/**
 * Calculate which page a given post index falls on, given the user's page size.
 *
 * @param {number} postIndex One-based index of the post
 * @param {object} settings User settings; uses `postsPerPage`
 * @returns {number} One-based page number
 */
function calculatePageFromIndex(postIndex, settings) {
	return 1 + Math.floor((postIndex - 1) / settings.postsPerPage);
}

/**
 * Calculate the post range to load for a page.
 *
 * Without pagination the topic is loaded from a single window centred on
 * `postIndex`, so the selected post is visible when the page is scrolled to.
 *
 * @param {number} page One-based page number
 * @param {number} postIndex One-based index of the post to centre on
 * @param {object} settings User settings; uses `usePagination` and `postsPerPage`
 * @returns {{start: number, stop: number}}
 */
function calculateStartStop(page, postIndex, settings) {
	let startPage = page;
	let startSkip = 0;

	if (!settings.usePagination) {
		if (postIndex > 1) {
			startPage = 1;
		}
		startSkip = Math.max(0, postIndex - Math.ceil(settings.postsPerPage / 2));
	}

	const start = ((startPage - 1) * settings.postsPerPage) + startSkip;
	const stop = start + settings.postsPerPage - 1;
	return { start: Math.max(0, start), stop: Math.max(0, stop) };
}

/**
 * Mark a topic and its notifications as read for the logged-in user.
 *
 * @param {import('express').Request} req
 * @param {string} tid
 * @returns {Promise<void>}
 */
async function markAsRead(req, tid) {
	if (!req.loggedIn) {
		return;
	}
	const markedRead = await topics.markAsRead([tid], req.uid);
	const promises = [topics.markTopicNotificationsRead([tid], req.uid)];
	if (markedRead) {
		promises.push(topics.pushUnreadCount(req.uid));
	}
	await Promise.all(promises);
}

/**
 * Whether the user may crosspost into any category other than `excludeCid`.
 *
 * The set of categories the user can crosspost to is cached per user.
 *
 * @param {import('express').Request} req
 * @param {number} [excludeCid] Category to exclude from the check
 * @returns {Promise<boolean>}
 */
async function loadCrosspostPrivilege(req, excludeCid) {
	const excluded = String(excludeCid || '');
	const cidsUserCanCrosspost = await crosspostCache.get(`uid:${req.uid}`, async () => {
		const cids = await categories.getAllCidsFromSet('categories:cid');
		return await privileges.categories.filterCids('topics:crosspost', cids, req.uid);
	});
	return cidsUserCanCrosspost.some(cid => cid !== excluded);
}

/**
 * Populate `topicData.breadcrumbs` from the topic's category hierarchy.
 *
 * @param {object} topicData
 * @returns {Promise<void>}
 */
async function buildBreadcrumbs(topicData) {
	const breadcrumbs = [
		{
			text: topicData.category.name,
			url: `${url}/category/${topicData.category.slug}`,
			cid: topicData.category.cid,
		},
		{
			text: translator.escape(topicData.title),
		},
	];
	const parentCrumbs = await helpers.buildCategoryBreadcrumbs(topicData.category.parentCid);
	topicData.breadcrumbs = parentCrumbs.concat(breadcrumbs);
}

/**
 * Attach the topic's previous category, for moderators only.
 *
 * @param {object} topicData
 * @param {object} userPrivileges
 * @param {string} userLang
 * @returns {Promise<void>}
 */
async function addOldCategory(topicData, userPrivileges, userLang) {
	if (!userPrivileges.isAdminOrMod || !topicData.oldCid) {
		return;
	}
	topicData.oldCategory = await categories.getCategoryFields(
		topicData.oldCid, ['cid', 'name', 'icon', 'bgColor', 'color', 'slug']
	);
	topicData.oldCategory.name = await translator.translate(topicData.oldCategory.name, userLang);
}

/**
 * Populate the page's meta and link tags for the topic.
 *
 * @param {object} topicData
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} currentPage
 * @param {object} [postAtIndex] Post at the requested index, if it was loaded
 * @returns {Promise<void>}
 */
async function addTags(topicData, req, res, currentPage, postAtIndex) {
	let mainPost = topicData.posts.find(p => parseInt(p.index, 10) === 0);
	if (!mainPost) {
		mainPost = await posts.getPostData(topicData.mainPid);
	}

	res.locals.metaTags = [
		{
			name: 'title',
			content: topicData.title,
		},
		{
			property: 'og:title',
			content: topicData.title,
		},
		{
			property: 'og:type',
			content: 'article',
		},
		{
			property: 'article:published_time',
			content: utils.toISOString(topicData.timestamp),
		},
		{
			property: 'article:modified_time',
			content: utils.toISOString(Math.max(topicData.lastposttime, mainPost && mainPost.edited)),
		},
		{
			property: 'article:section',
			content: topicData.category ? topicData.category.name : '',
		},
	];

	if (!utils.isNumber(topicData.tid)) {
		res.locals.metaTags.push({
			name: 'robots',
			content: 'noindex',
		});
	}

	const description = getDescriptionFromPost(postAtIndex);
	if (description) {
		res.locals.metaTags.push(
			{
				name: 'description',
				content: description,
			},
			{
				property: 'og:description',
				content: description,
			},
		);
	}

	await addOGImageTags(res, topicData, postAtIndex);

	const page = currentPage > 1 ? `?page=${currentPage}` : '';
	res.locals.linkTags = [
		{
			rel: 'canonical',
			href: `${url}/topic/${topicData.slug}${page}`,
		},
	];

	if (!topicData['feeds:disableRSS']) {
		res.locals.linkTags.push({
			rel: 'alternate',
			type: 'application/rss+xml',
			href: topicData.rssFeedUrl,
		});
	}

	if (topicData.category) {
		res.locals.linkTags.push({
			rel: 'up',
			href: `${url}/category/${topicData.category.slug}`,
		});
	}

	if (postAtIndex) {
		res.locals.linkTags.push({
			rel: 'author',
			href: `${url}/user/${postAtIndex.user.userslug}`,
		});
	}

	if (meta.config.activitypubEnabled && postAtIndex) {
		const { pid } = postAtIndex;
		res.locals.linkTags.push({
			rel: 'alternate',
			type: 'application/activity+json',
			href: utils.isNumber(pid) ? `${nconf.get('url')}/post/${pid}` : pid,
		});
	}
}

/**
 * Build a plain-text description from a post's content, truncated for meta tags.
 *
 * @param {object} [post]
 * @returns {string} The description, or an empty string if there is no content
 */
function getDescriptionFromPost(post) {
	if (!post || !post.content) {
		return '';
	}
	let description = utils.stripHTMLTags(utils.decodeHTMLEntities(post.content)).trim();
	if (description.length > 160) {
		description = `${description.slice(0, 157)}...`;
	}
	return description.replace(/\n/g, ' ').trim();
}

/**
 * Add `og:image` tags for post uploads, topic thumbnails, the category
 * background image and the post author's picture.
 *
 * @param {import('express').Response} res
 * @param {object} topicData
 * @param {object} [postAtIndex]
 * @returns {Promise<void>}
 */
async function addOGImageTags(res, topicData, postAtIndex) {
	const uploads = postAtIndex ? await posts.uploads.listWithSizes(postAtIndex.pid) : [];
	const images = uploads.filter(Boolean);

	if (topicData.thumbs) {
		const thumbs = topicData.thumbs.filter(
			thumb => thumb && images.every(img => path.normalize(img.name) !== path.normalize(thumb.path))
		);
		images.push(...thumbs.map(thumb => thumb.path));
	}

	if (topicData.category.backgroundImage && (!postAtIndex || !postAtIndex.index)) {
		images.push(topicData.category.backgroundImage);
	}
	if (postAtIndex && postAtIndex.user && postAtIndex.user.picture) {
		images.push(postAtIndex.user.picture);
	}
	images.forEach(image => addOGImageTag(res, image));
}

/**
 * Add `og:image` meta tags for a single image, absolutising relative URLs.
 *
 * @param {import('express').Response} res
 * @param {string|object} image Image path, or an upload object with `name`/`width`/`height`
 * @returns {void}
 */
function addOGImageTag(res, image) {
	const isObject = typeof image === 'object' && image.name;
	let imageUrl = isObject ? image.name : image;
	if (typeof imageUrl !== 'string') {
		return;
	}

	if (!imageUrl.startsWith('http')) {
		if (imageUrl.startsWith(`${relativePath}${uploadUrl}`)) {
			// (https://domain.com) + imageUrl (which starts with /relative_path/upload_url)
			imageUrl = baseUrl + imageUrl;
		} else {
			// (https://domain.com/forum) + (/assets/uploads) + (/files/imagePath)
			imageUrl = url + path.posix.join(uploadUrl, imageUrl);
		}
	}

	res.locals.metaTags.push({
		property: 'og:image',
		content: imageUrl,
	}, {
		property: 'og:image:url',
		content: imageUrl,
	});

	if (isObject && image.width && image.height) {
		res.locals.metaTags.push({
			property: 'og:image:width',
			content: String(image.width),
		}, {
			property: 'og:image:height',
			content: String(image.height),
		});
	}
}

/**
 * Respond with the summary of a topic's latest undeleted post.
 *
 * Missing, unreadable and empty topics all yield the same 404 response so that
 * private topics are indistinguishable from non-existent ones.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
topicsController.teaser = async function (req, res, next) {
	const tid = req.params.topic_id;
	if (!utils.isNumber(tid)) {
		return next();
	}
	const canRead = await privileges.topics.can('topics:read', tid, req.uid);
	if (!canRead) {
		return res.status(404).json('not-found');
	}
	const pid = await topics.getLatestUndeletedPid(tid);
	if (!pid) {
		return res.status(404).json('not-found');
	}
	const postData = await posts.getPostSummaryByPids([pid], req.uid, { stripTags: false, extraFields: ['contentWarning'] });
	if (!postData.length) {
		return res.status(404).json('not-found');
	}
	res.json(postData[0]);
};

/**
 * Respond with pagination metadata for a topic.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
topicsController.pagination = async function (req, res, next) {
	const tid = req.params.topic_id;
	const currentPage = parseInt(req.query.page, 10) || 1;

	if (!utils.isNumber(tid)) {
		return next();
	}
	const topic = await topics.getTopicData(tid);
	if (!topic) {
		return next();
	}
	if (!await privileges.topics.canRead(tid, req.uid)) {
		return next();
	}

	const settings = await user.getSettings(req.uid);
	const postCount = topic.postcount;
	const pageCount = Math.max(1, Math.ceil(postCount / settings.postsPerPage));

	const paginationData = pagination.create(currentPage, pageCount);
	paginationData.rel.forEach((rel) => {
		rel.href = `${url}/topic/${topic.slug}${rel.href}`;
	});

	res.json({ pagination: paginationData });
};
