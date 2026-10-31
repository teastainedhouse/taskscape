/**
 * The one error type handlers throw. The router turns it into the JSON
 * envelope: `{ error: { code, message, details? }, ...extra }`.
 * Messages never echo ids, names, titles, or submitted values.
 */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {object} [details]  goes under error.details
   * @param {object} [extra]    merged at the top level (e.g. `current` on 409)
   * @param {Record<string,string>} [headers]
   */
  constructor(status, code, message, details, extra, headers) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.extra = extra;
    this.headers = headers;
  }

  /** @returns {object} the response body */
  body() {
    const error = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error, ...(this.extra ?? {}) };
  }
}

export const notFound = () => new ApiError(404, 'not_found', 'Not found.');

export const unauthorized = () =>
  new ApiError(401, 'unauthorized', 'Sign in to use Taskscape.', undefined, undefined, {
    'WWW-Authenticate': 'Bearer realm="taskscape"',
  });

/** @param {string} message */
export const forbidden = (message = 'You are not allowed to do that.') => new ApiError(403, 'forbidden', message);

/** @param {string} message */
export const invalidState = (message) => new ApiError(400, 'invalid_state', message);

/** @param {Record<string,string>} fields  field name -> what is wrong */
export const validationFailed = (fields) =>
  new ApiError(400, 'validation_failed', 'Some fields are invalid.', { fields });

/** @param {object} current  the record as GET would return it now */
export const conflict = (current) =>
  new ApiError(
    409, 'conflict', 'This record changed since you loaded it. Reload and retry with the current version.',
    undefined, { current },
  );

/** @param {string[]} allowed */
export const methodNotAllowed = (allowed) =>
  new ApiError(405, 'method_not_allowed', 'Method not allowed.', undefined, undefined, { Allow: allowed.join(', ') });

export const payloadTooLarge = () => new ApiError(413, 'payload_too_large', 'Request body is too large.');

export const internal = () => new ApiError(500, 'internal', 'Something went wrong on the server.');
