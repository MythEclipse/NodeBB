'use strict';

/**
 * The middlewares here strictly act to "expose" certain values from the database,
 * into `res.locals` for use in middlewares and/or controllers down the line
 */

const user = require('../user');
const privileges = require('../privileges');

module.exports = function (middleware) {
	// Exposes whether the current user is an administrator, as `res.locals.isAdmin`
	middleware.exposeAdmin = async (req, res, next) => {
		// Unlike `requireAdmin`, this middleware just checks the uid, and sets `isAdmin` in `res.locals`
		res.locals.isAdmin = false;

		// This middleware also runs on guest-accessible routes, where `req.user` is not set
		if (!req.user) {
			return next();
		}

		res.locals.isAdmin = await user.isAdministrator(req.user.uid);
		next();
	};

	// Exposes a hash of the current user's ranks (admin, gmod, etc.), as `res.locals.privileges`
	middleware.exposePrivileges = async (req, res, next) => {
		const [isAdmin, isGmod, isPrivileged] = await Promise.all([
			user.isAdministrator(req.uid),
			user.isGlobalModerator(req.uid),
			user.isPrivileged(req.uid),
		]);

		res.locals.privileges = {
			isAdmin,
			isGmod,
			isPrivileged,
			// `req.params.uid` is a string, while `req.uid` is a number
			isSelf: req.params.uid ? req.params.uid === String(req.uid) : false,
		};
		next();
	};

	// Exposes a user's global and admin privilege sets, as `res.locals.privileges`
	middleware.exposePrivilegeSet = async (req, res, next) => {
		const [globalPrivs, adminPrivs] = await Promise.all([
			privileges.global.get(req.uid),
			privileges.admin.get(req.uid),
		]);
		res.locals.privileges = { ...globalPrivs, ...adminPrivs };
		next();
	};
};
