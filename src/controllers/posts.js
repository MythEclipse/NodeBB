'use strict';

const nconf = require('nconf');
const querystring = require('querystring');

const meta = require('../meta');
const posts = require('../posts');
const privileges = require('../privileges');
const activitypub = require('../activitypub');
const utils = require('../utils');

const helpers = require('./helpers');

const postsController = module.exports;

/**
 * Route a request for a single post to that post's canonical path.
 *
 * Local posts are addressed by numeric pid; remote (ActivityPub) posts are
 * addressed by their URI and are proxied or asserted as needed.
 *
 * Requests are handed off to the next middleware (`next()`) whenever the
 * target is missing or unreadable, so that normal routing/404 handling takes
 * over instead of redirecting.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
postsController.redirectToPost = async function (req, res, next) {
	const isLocalPost = utils.isNumber(req.params.pid);
	const pid = isLocalPost ? parseInt(req.params.pid, 10) : req.params.pid;
	if (!pid) {
		return next();
	}

	// Kickstart note assertion if applicable
	if (!isLocalPost && req.uid && meta.config.activitypubEnabled) {
		const exists = await posts.exists(pid);
		if (!exists) {
			await activitypub.notes.assert(req.uid, pid);
		}
	}

	if (!req.loggedIn && meta.config.activitypubEnabled && !res.locals.isAPI && !isLocalPost) {
		return helpers.redirect(res, `/outgoing?url=${encodeURIComponent(pid)}`);
	}

	const [canRead, path] = await Promise.all([
		privileges.posts.can('topics:read', pid, req.uid),
		posts.generatePostPath(pid, req.uid),
	]);
	if (!path || !canRead) {
		return next();
	}

	if (meta.config.activitypubEnabled) {
		// Include link header for richer parsing
		res.set('Link', `<${nconf.get('url')}/post/${req.params.pid}>; rel="alternate"; type="application/activity+json"`);
	}

	const query = querystring.stringify(req.query);
	helpers.redirect(res, query ? `${path}?${query}` : path, false);
};

/**
 * Return a page of the most recent posts as JSON, optionally filtered by term.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
postsController.getRecentPosts = async function (req, res) {
	const page = parseInt(req.query.page, 10) || 1;
	const postsPerPage = 20;
	const start = Math.max(0, (page - 1) * postsPerPage);
	const stop = start + postsPerPage - 1;
	const data = await posts.getRecentPosts(req.uid, start, stop, req.params.term);
	res.json(data);
};
