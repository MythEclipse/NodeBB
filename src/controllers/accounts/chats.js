'use strict';

const db = require('../../database');
const messaging = require('../../messaging');
const meta = require('../../meta');
const user = require('../../user');
const privileges = require('../../privileges');
const helpers = require('../helpers');

const chatsController = module.exports;

/**
 * Build the canonical path for a user's chats route.
 *
 * Empty segments are omitted, so `chatPath('foo')` points at the chat list,
 * `chatPath('foo', 12)` at room 12, and both segments at a message within it.
 *
 * @param {string} userslug
 * @param {number|string} [roomid] Room identifier, omitted for the chat list
 * @param {number|string} [index] Message index within the room
 * @returns {string}
 */
function chatPath(userslug, roomid, index) {
	const roomSegment = roomid ? `/${roomid}` : '';
	const indexSegment = index ? `/${index}` : '';
	return `/user/${userslug}/chats${roomSegment}${indexSegment}`;
}

/**
 * Render the chat list, or a single chat room, for the user identified by
 * `req.params.userslug`.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
chatsController.get = async function (req, res, next) {
	if (meta.config.disableChat) {
		return next();
	}

	const targetUid = await user.getUidByUserslug(req.params.userslug);
	if (!targetUid) {
		return next();
	}
	const canChat = await privileges.global.can(['chat', 'chat:privileged'], req.uid);
	if (!canChat.includes(true)) {
		return helpers.notAllowed(req, res);
	}

	const payload = {
		title: '[[pages:chats]]',
		uid: targetUid,
		userslug: req.params.userslug,
	};
	const isSwitch = res.locals.isAPI && parseInt(req.query.switch, 10) === 1;
	if (!isSwitch) {
		let start = 0;
		if (req.params.roomid) {
			const roomIndex = await db.sortedSetRevRank(`uid:${targetUid}:chat:rooms`, req.params.roomid);
			if (roomIndex !== null) {
				// render the list around the selected room so it is visible without paging from the top
				start = Math.max(0, roomIndex - 2);
			}
		}
		const [recentChats, publicRooms, privateRoomCount] = await Promise.all([
			messaging.getRecentChats(req.uid, targetUid, start, start + 29),
			messaging.getPublicRooms(req.uid, targetUid),
			db.sortedSetCard(`uid:${targetUid}:chat:rooms`),
		]);
		if (!recentChats) {
			return next();
		}
		payload.rooms = recentChats.rooms;
		payload.nextStart = recentChats.nextStart;
		payload.prevStart = start;
		payload.publicRooms = publicRooms;
		payload.privateRoomCount = privateRoomCount;
	}

	if (!req.params.roomid) {
		return res.render('chats', payload);
	}

	const { index } = req.params;
	let start = 0;
	payload.scrollToIndex = null;
	if (index) {
		const messageCount = await db.getObjectField(`chat:room:${req.params.roomid}`, 'messageCount');
		const messageIndex = parseInt(index, 10) || 1;
		// render the room page ending just after the selected message
		start = Math.max(0, parseInt(messageCount, 10) - index - 49);
		payload.scrollToIndex = Math.min(messageCount, Math.max(0, messageIndex));
	}
	const room = await messaging.loadRoom(req.uid, {
		uid: targetUid,
		roomId: req.params.roomid,
		start: start,
	});
	if (!room) {
		return next();
	}

	room.title = room.roomName || room.usernames || '[[pages:chats]]';
	room.bodyClasses = ['chat-loaded'];
	const [canViewInfo, canUploadImage, canUploadFile] = await privileges.global.can([
		'view:users:info', 'upload:post:image', 'upload:post:file',
	], targetUid);
	room.canViewInfo = canViewInfo;
	room.canUpload = (canUploadImage || canUploadFile) && (meta.config.maximumFileSize > 0 || room.isAdmin);
	res.render('chats', {
		...payload,
		...room,
	});
};

/**
 * Redirect `/chats/:roomid?/:index?` to the equivalent path under the current
 * user's profile.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
chatsController.redirectToChat = async function (req, res, next) {
	if (!req.loggedIn) {
		return next();
	}
	const userslug = await user.getUserField(req.uid, 'userslug');
	if (!userslug) {
		return next();
	}
	const roomid = parseInt(req.params.roomid, 10);
	const index = parseInt(req.params.index, 10);
	helpers.redirect(res, chatPath(userslug, roomid, index));
};

/**
 * Redirect `/message/:mid` to the message's position in its chat room.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
chatsController.redirectToMessage = async function (req, res, next) {
	const mid = parseInt(req.params.mid, 10);
	if (!mid) {
		return next();
	}
	const [userslug, roomId] = await Promise.all([
		user.getUserField(req.uid, 'userslug'),
		messaging.getMessageField(mid, 'roomId'),
	]);
	if (!userslug || !roomId) {
		return next();
	}
	const messageIndex = parseInt(await db.sortedSetRank(`chat:room:${roomId}:mids`, mid), 10);
	if (!(messageIndex >= 0)) {
		return next();
	}

	// indices are stored zero-based but linked to by their one-based position
	helpers.redirect(res, chatPath(userslug, roomId, messageIndex + 1), false);
};
