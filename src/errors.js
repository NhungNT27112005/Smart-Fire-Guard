'use strict';
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message); Object.assign(this, {status, code, details});
  }
}
const fail = (status, code, message, details) => { throw new AppError(status, code, message, details); };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
module.exports = {AppError, fail, asyncRoute};
