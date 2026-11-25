const a = require('./a.mjs');
const path = require('path');
log('./not-an-import');
module.exports = { a, path };
