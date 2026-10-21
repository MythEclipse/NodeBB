'use strict';

const assert = require('assert');
const nconf = require('nconf');

const db = require('../mocks/databasemock');

const meta = require('../../src/meta');
const install = require('../../src/install');
const user = require('../../src/user');
const groups = require('../../src/groups');
const categories = require('../../src/categories');
const topics = require('../../src/topics');
const posts = require('../../src/posts');
const privileges = require('../../src/privileges');
const activitypub = require('../../src/activitypub');
const utils = require('../../src/utils');
const helpers = require('../helpers');
const apHelpers = require('../activitypub/helpers');

/**
 * Generates a short, unique name/username so fixtures don't collide between suites.
 *
 * @returns {string}
 */
const uniqueName = () => utils.generateUUID().slice(0, 8);

/**
 * Creates a category with a unique name.
 *
 * @returns {Promise<{cid: number, name: string}>}
 */
const createCategory = async () => categories.create({ name: uniqueName() });

/**
 * Creates a user, allowing callers to override any of the default fields.
 *
 * @param {object} [data] Fields to pass to `user.create`
 * @returns {Promise<number>} The new user's uid
 */
const createUser = async (data = {}) => user.create({ username: uniqueName(), ...data });

/**
 * Creates a topic in the given category, with generated title and content.
 *
 * @param {number} uid Author uid
 * @param {number} cid Category cid
 * @returns {Promise<object>} The created topic's data
 */
const createTopic = async (uid, cid) => {
	const { topicData } = await topics.post({
		uid,
		cid,
		title: utils.generateUUID(),
		content: utils.generateUUID(),
	});
	return topicData;
};

/**
 * Creates a user with a known password and logs them in.
 *
 * @returns {Promise<{uid: number, login: object}>}
 */
const createUserWithLogin = async () => {
	const username = uniqueName();
	const uid = await createUser({ username, password: '123456' });
	const login = await helpers.loginUser(username, '123456');
	return { uid, login };
};

describe('Crossposting (& related logic)', () => {
	before(async () => {
		meta.config.activitypubEnabled = 1;
		await install.giveWorldPrivileges();
	});

	describe('topic already in multiple categories', () => {
		let tid;
		let cid1;
		let cid2;
		let uid;

		before(async () => {
			({ cid: cid1 } = await createCategory());
			uid = await createUser();
			const topicData = await createTopic(uid, cid1);
			tid = topicData.tid;

			// Add topic to another category's zset
			({ cid: cid2 } = await createCategory());
			await db.sortedSetAdd(`cid:${cid2}:tids`, topicData.timestamp, tid);
		});

		it('should contain the topic in both categories when requested', async () => {
			const tids1 = await categories.getTopicIds({
				uid,
				cid: cid1,
				start: 0,
				stop: 1,
			});

			const tids2 = await categories.getTopicIds({
				uid,
				cid: cid2,
				start: 0,
				stop: 1,
			});

			assert.deepStrictEqual(tids1, tids2);
		});
	});

	describe('crosspost', () => {
		let tid;
		let cid1;
		let cid2;
		let uid;

		before(async () => {
			({ cid: cid1 } = await createCategory());
			({ cid: cid2 } = await createCategory());
			uid = await createUser();
			tid = (await createTopic(uid, cid1)).tid;
		});

		it('should not allow a spider (uid -1) to crosspost', async () => {
			await assert.rejects(
				topics.crossposts.add(tid, cid2, -1),
				{ message: '[[error:not-allowed]]' }
			);
		});

		it('should not allow a crosspost if privilege is missing', async () => {
			await privileges.categories.rescind(['groups:topics:crosspost'], cid2, 'registered-users');
			await assert.rejects(
				topics.crossposts.add(tid, cid2, uid),
				{ message: '[[error:not-allowed]]' }
			);
			await privileges.categories.give(['groups:topics:crosspost'], cid2, 'registered-users');
		});

		it('should not allow a crosspost if user lacks topics:read on source category', async () => {
			await privileges.categories.rescind(['groups:topics:read'], cid1, 'registered-users');
			await assert.rejects(
				topics.crossposts.add(tid, cid2, uid),
				{ message: '[[error:not-allowed]]' }
			);
			await privileges.categories.give(['groups:topics:read'], cid1, 'registered-users');
		});

		it('should successfully crosspost to another cid', async () => {
			const crossposts = await topics.crossposts.add(tid, cid2, uid);

			assert(Array.isArray(crossposts));
			assert.strictEqual(crossposts.length, 1);

			const actual = crossposts[0];
			assert.deepStrictEqual({
				uid: actual.uid,
				tid: actual.tid,
				cid: actual.cid,
			}, {
				uid,
				tid,
				cid: String(cid2),
			});
		});

		it('should show the tid in both categories when requested', async () => {
			const tids1 = await categories.getTopicIds({
				uid,
				cid: cid1,
				start: 0,
				stop: 1,
			});

			const tids2 = await categories.getTopicIds({
				uid,
				cid: cid2,
				start: 0,
				stop: 1,
			});

			assert.deepStrictEqual(tids1, tids2);
		});

		it('should throw on cross-posting again when already cross-posted', async () => {
			await assert.rejects(
				topics.crossposts.add(tid, cid2, uid),
				{ message: '[[error:topic-already-crossposted]]' },
			);
		});
	});

	describe('uncrosspost', () => {
		let tid;
		let cid1;
		let cid2;
		let uid;

		before(async () => {
			({ cid: cid1 } = await createCategory());
			({ cid: cid2 } = await createCategory());
			uid = await createUser();
			tid = (await createTopic(uid, cid1)).tid;

			await topics.crossposts.add(tid, cid2, uid);
		});

		it('should not let another user uncrosspost', async () => {
			const uid2 = await createUser();
			await assert.rejects(
				topics.crossposts.remove(tid, cid2, uid2),
				{ message: '[[error:invalid-data]]' },
			);
		});

		it('should successfully uncrosspost from a cid', async () => {
			const crossposts = await topics.crossposts.remove(tid, cid2, uid);

			assert(Array.isArray(crossposts));
			assert.strictEqual(crossposts.length, 0);
		});

		it('should not contain the topic in the category the topic was uncrossposted from', async () => {
			const tids = await categories.getTopicIds({
				uid,
				cid: cid2,
				start: 0,
				stop: 1,
			});

			assert(!tids.includes(tid));
		});

		it('should throw on uncrossposting if already uncrossposted', async () => {
			await assert.rejects(
				topics.crossposts.remove(tid, cid2, uid),
				{ message: '[[error:invalid-data]]' },
			);
		});
	});

	describe('uncrosspost (as administrator)', () => {
		let tid;
		let cid1;
		let cid2;
		let uid;
		let privUid;

		before(async () => {
			({ cid: cid1 } = await createCategory());
			({ cid: cid2 } = await createCategory());
			uid = await createUser();
			privUid = await createUser();
			await groups.join('administrators', privUid);

			tid = (await createTopic(uid, cid1)).tid;

			await topics.crossposts.add(tid, cid2, uid);
		});

		it('should successfully uncrosspost from a cid', async () => {
			const crossposts = await topics.crossposts.remove(tid, cid2, privUid);

			assert(Array.isArray(crossposts));
			assert.strictEqual(crossposts.length, 0);
		});
	});

	describe('uncrosspost (as global moderator)', () => {
		let tid;
		let cid1;
		let cid2;
		let uid;
		let privUid;

		before(async () => {
			({ cid: cid1 } = await createCategory());
			({ cid: cid2 } = await createCategory());
			uid = await createUser();
			privUid = await createUser();
			await groups.join('Global Moderators', privUid);

			tid = (await createTopic(uid, cid1)).tid;

			await topics.crossposts.add(tid, cid2, uid);
		});

		it('should successfully uncrosspost from a cid', async () => {
			const crossposts = await topics.crossposts.remove(tid, cid2, privUid);

			assert(Array.isArray(crossposts));
			assert.strictEqual(crossposts.length, 0);
		});
	});

	describe('uncrosspost (as category moderator)', () => {
		let tid;
		let cid1;
		let cid2;
		let uid;
		let privUid;

		before(async () => {
			({ cid: cid1 } = await createCategory());
			({ cid: cid2 } = await createCategory());
			uid = await createUser();
			privUid = await createUser();

			tid = (await createTopic(uid, cid1)).tid;

			await topics.crossposts.add(tid, cid2, uid);
		});

		it('should fail to uncrosspost if not mod of passed-in category', async () => {
			await privileges.categories.give(['moderate'], cid1, [privUid]);
			await assert.rejects(
				topics.crossposts.remove(tid, cid2, privUid),
				{ message: '[[error:invalid-data]]' },
			);
		});

		it('should successfully uncrosspost from a cid if proper mod', async () => {
			await privileges.categories.give(['moderate'], cid2, [privUid]);
			const crossposts = await topics.crossposts.remove(tid, cid2, privUid);

			assert(Array.isArray(crossposts));
			assert.strictEqual(crossposts.length, 0);
		});
	});

	describe('Deletion', () => {
		let tid;
		let cid1;
		let cid2;
		let uid;

		before(async () => {
			({ cid: cid1 } = await createCategory());
			({ cid: cid2 } = await createCategory());
			uid = await createUser();
			tid = (await createTopic(uid, cid1)).tid;

			await topics.crossposts.add(tid, cid2, uid);
			await topics.delete(tid, uid);
		});

		it('should maintain crossposts when topic is deleted', async () => {
			const crossposts = await topics.crossposts.get(tid);
			assert(Array.isArray(crossposts));
			assert.strictEqual(crossposts.length, 1);
		});
	});

	describe('Purging', () => {
		let tid;
		let cid1;
		let cid2;
		let uid;

		before(async () => {
			({ cid: cid1 } = await createCategory());
			({ cid: cid2 } = await createCategory());
			uid = await createUser();
			tid = (await createTopic(uid, cid1)).tid;

			await topics.crossposts.add(tid, cid2, uid);
			await topics.purge(tid, uid);
		});

		it('should remove crossposts when topic is purged', async () => {
			const crossposts = await topics.crossposts.get(tid);
			assert(Array.isArray(crossposts));
			assert.strictEqual(crossposts.length, 0);
		});
	});

	describe('category sync; integration with', () => {
		let cid;
		let remoteCid;
		let pid;
		let post;

		before(async () => {
			({ cid } = await createCategory());
			({ id: remoteCid } = apHelpers.mocks.group());
			({ id: pid, note: post } = apHelpers.mocks.note({
				audience: [remoteCid],
			}));

			// Mock a group follow/accept
			const timestamp = Date.now();
			await Promise.all([
				db.sortedSetAdd(`cid:${cid}:following`, timestamp, remoteCid),
				db.sortedSetAdd(`followersRemote:${remoteCid}`, timestamp, `cid|${cid}`),
			]);
		});

		it('should automatically cross-post the topic when the remote category announces', async () => {
			const { activity: body } = apHelpers.mocks.announce({
				actor: remoteCid,
				object: post,
			});

			await activitypub.inbox.announce({ body });

			const tid = await posts.getPostField(pid, 'tid');
			const crossposts = await topics.crossposts.get(tid);

			assert.strictEqual(crossposts.length, 1);

			const actual = crossposts[0];
			assert.deepStrictEqual({
				uid: actual.uid,
				tid: actual.tid,
				cid: actual.cid,
			}, {
				uid: 0,
				tid,
				cid: cid,
			});
		});
	});

	describe('auto-categorization; integration with', () => {
		let cid;
		let remoteCid;
		let pid;
		let post;

		before(async () => {
			const preferredUsername = uniqueName();
			({ cid } = await createCategory());
			({ id: remoteCid } = apHelpers.mocks.group({
				preferredUsername,
			}));
			({ id: pid, note: post } = apHelpers.mocks.note({
				audience: [remoteCid],
				tag: [
					{
						type: 'Hashtag',
						name: `#${preferredUsername}`,
					},
				],
			}));

			await activitypub.rules.upsert('hashtag', preferredUsername, cid);
		});

		it('note assertion should automatically cross-post', async () => {
			await activitypub.notes.assert(0, pid, { skipChecks: true });

			const tid = await posts.getPostField(pid, 'tid');
			const crossposts = await topics.crossposts.get(tid);
			assert.strictEqual(crossposts.length, 1);

			const actual = crossposts[0];
			assert.deepStrictEqual({
				uid: actual.uid,
				tid: actual.tid,
				cid: actual.cid,
			}, {
				uid: 0,
				tid,
				cid: cid,
			});
		});
	});

	describe('ActivityPub effects (or lack thereof)', () => {
		describe('local canonical category', () => {
			let tid;
			let cid1;
			let cid2;
			let uid;
			let pid;

			before(async () => {
				({ cid: cid1 } = await createCategory());
				({ cid: cid2 } = await createCategory());
				uid = await createUser();
				const topicData = await createTopic(uid, cid1);
				tid = topicData.tid;
				pid = topicData.mainPid;

				// Add some remote followers
				await Promise.all([cid1, cid2].map(async (cid) => {
					const { activity } = apHelpers.mocks.follow({
						object: {
							id: `${nconf.get('url')}/category/${cid}`,
						},
					});
					await activitypub.inbox.follow({
						body: activity,
					});
				}));

				activitypub._sent.clear();
			});

			afterEach(() => {
				activitypub._sent.clear();
			});

			it('should not federate out any events on crosspost', async () => {
				await topics.crossposts.add(tid, cid2, uid);
				assert.strictEqual(activitypub._sent.size, 0);
			});

			it('should not federate out anything on uncrosspost', async () => {
				await topics.crossposts.remove(tid, cid2, uid);
				assert.strictEqual(activitypub._sent.size, 0);
			});

			it('should only federate an Announce on a remote reply from the canonical cid', async () => {
				const { note: object } = apHelpers.mocks.note({
					audience: `${nconf.get('url')}/category/${cid1}`,
					inReplyTo: `${nconf.get('url')}/post/${pid}`,
				});
				const { activity } = apHelpers.mocks.create(object);
				await activitypub.inbox.create({
					body: activity,
				});

				assert.strictEqual(activitypub._sent.size, 1);

				const actual = Array.from(activitypub._sent).pop()[1];
				assert.deepStrictEqual({
					type: actual.payload.type,
					actor: actual.payload.actor,
					object: actual.payload.object,
				}, {
					type: 'Announce',
					actor: `${nconf.get('url')}/category/${cid1}`,
					object: activity,
				});
			});

			it('should only federate an Announce on a remote like from the canonical cid', async () => {
				const { activity: body } = apHelpers.mocks.like({
					object: {
						id: `${nconf.get('url')}/post/${pid}`,
					},
				});
				await activitypub.inbox.like({ body });

				assert.strictEqual(activitypub._sent.size, 1);

				const actual = Array.from(activitypub._sent).pop()[1];
				assert.deepStrictEqual({
					type: actual.payload.type,
					actor: actual.payload.actor,
					object: actual.payload.object,
				}, {
					type: 'Announce',
					actor: `${nconf.get('url')}/category/${cid1}`,
					object: body,
				});
			});
		});

		describe('remote canonical category', () => {
			let tid;
			let cid;
			let remoteCid;
			let uid;
			let pid;

			before(async () => {
				({ id: remoteCid } = apHelpers.mocks.group());
				await activitypub.actors.assertGroup(remoteCid);
				({ cid } = await createCategory());
				uid = await createUser();

				({ id: pid } = apHelpers.mocks.note());
				await activitypub.notes.assert(0, pid, { skipChecks: true, cid: remoteCid });

				tid = await posts.getPostField(pid, 'tid');

				await topics.crossposts.add(tid, cid, uid);
			});

			it('should properly address the remote category when federating out a local reply', async () => {
				const postData = await topics.reply({
					uid,
					cid,
					tid,
					content: utils.generateUUID(),
				});
				const mocked = await activitypub.mocks.notes.public(postData);
				assert(mocked.to.includes(remoteCid));
			});

			it('should send an Announce to the topic author when crossposted to a local category', async () => {
				const { uid: crossposter, login } = await createUserWithLogin();
				activitypub._sent.clear();

				const crosspostCid = (await createCategory()).cid;
				const result = await helpers.request('post', `/api/v3/topics/${tid}/crossposts`, {
					jar: login.jar,
					csrf_token: login.csrf_token,
					body: { cid: crosspostCid },
				});

				assert.strictEqual(result.response.statusCode, 200);
				assert.strictEqual(activitypub._sent.size, 1);

				const actual = Array.from(activitypub._sent).pop()[1];
				assert.strictEqual(actual.payload.type, 'Announce');
				assert.strictEqual(actual.payload.actor, `${nconf.get('url')}/uid/${crossposter}`);
				assert.strictEqual(actual.payload.object, pid);

				const authorUrl = await posts.getPostField(pid, 'uid');
				assert(actual.payload.cc.includes(authorUrl));
				assert(actual.targets.includes(authorUrl));
			});

			it('should not send an Announce when crossposted to a non-federated category', async () => {
				const { login } = await createUserWithLogin();
				activitypub._sent.clear();

				const crosspostCid = (await createCategory()).cid;
				await privileges.categories.rescind(['groups:topics:read'], crosspostCid, 'fediverse');
				const result = await helpers.request('post', `/api/v3/topics/${tid}/crossposts`, {
					jar: login.jar,
					csrf_token: login.csrf_token,
					body: { cid: crosspostCid },
				});

				assert.strictEqual(result.response.statusCode, 200);
				assert.strictEqual(activitypub._sent.size, 0);
			});
		});

		describe('world canonical category (cid -1)', () => {
			let tid;
			let cid;
			let uid;
			let pid;

			before(async () => {
				({ cid } = await createCategory());
				uid = await createUser();

				({ id: pid } = apHelpers.mocks.note());
				await activitypub.notes.assert(0, pid, { skipChecks: true });

				tid = await posts.getPostField(pid, 'tid');
			});

			it('should send an Announce to the topic author when crossposted to a local category', async () => {
				const { uid: crossposter, login } = await createUserWithLogin();
				activitypub._sent.clear();

				const crosspostCid = (await createCategory()).cid;
				const result = await helpers.request('post', `/api/v3/topics/${tid}/crossposts`, {
					jar: login.jar,
					csrf_token: login.csrf_token,
					body: { cid: crosspostCid },
				});

				assert.strictEqual(result.response.statusCode, 200);
				assert.strictEqual(activitypub._sent.size, 1);

				const actual = Array.from(activitypub._sent).pop()[1];
				assert.strictEqual(actual.payload.type, 'Announce');
				assert.strictEqual(actual.payload.actor, `${nconf.get('url')}/uid/${crossposter}`);
				assert.strictEqual(actual.payload.object, pid);

				const authorUrl = await posts.getPostField(pid, 'uid');
				assert(actual.payload.cc.includes(authorUrl));
				assert(actual.targets.includes(authorUrl));
			});
		});
	});
});
