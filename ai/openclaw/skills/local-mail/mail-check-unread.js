#!/usr/bin/env node
process.argv.splice(2, 0, 'check');
require('./maildir.js');
