'use strict';

/**
 * HTTP error type and Express error handler. Route handlers throw HttpError
 * with one of the status codes defined in the Module 2 interface contract:
 *   400 validation failure, 401 missing or expired token, 403 role violation,
 *   404 unknown resource, 409 capacity/duplicate/state conflict,
 *   502 external provider unreachable.
 */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (msg) => new HttpError(400, msg);
const unauthorized = (msg = 'Sign in again; your session token is missing or expired') => new HttpError(401, msg);
const forbidden = (msg = 'You do not have permission for this action') => new HttpError(403, msg);
const notFound = (msg) => new HttpError(404, msg);
const conflict = (msg) => new HttpError(409, msg);

/** Final Express middleware: converts thrown errors into JSON responses. */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  // Errors thrown by the bracket engine describe an invalid action (for
  // example, recording a tie in elimination play), so they map to 409.
  if (err && err.engineError) {
    return res.status(409).json({ error: err.message });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }
  console.error(err);
  return res.status(500).json({ error: 'Unexpected server error' });
}

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict, errorHandler };
