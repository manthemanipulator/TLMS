'use strict';

/**
 * Authentication middleware. Every request must carry a Firebase
 * Authentication ID token in the Authorization header:
 *   Authorization: Bearer <idToken>
 * The token is verified with the Admin SDK before any handler runs, and the
 * caller's uid, display name, email and admin claim are attached to req.user.
 */
const { unauthorized, forbidden } = require('./errors');

function requireUser(auth) {
  return async (req, res, next) => {
    try {
      const header = req.get('Authorization') || '';
      const match = header.match(/^Bearer (.+)$/);
      if (!match) throw unauthorized();
      let decoded;
      try {
        decoded = await auth.verifyIdToken(match[1]);
      } catch {
        throw unauthorized();
      }
      req.user = {
        uid: decoded.uid,
        name: decoded.name || decoded.email || 'Player',
        email: decoded.email || null,
        admin: decoded.admin === true,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Use after requireUser on routes that only administrators may call. */
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.admin) return next(forbidden());
  next();
}

module.exports = { requireUser, requireAdmin };
