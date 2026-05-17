#!/usr/bin/env node
process.argv.splice(2, 0, 'reply');
require('./maildir.js');
