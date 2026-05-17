#!/usr/bin/env node
process.argv.splice(2, 0, 'watch');
require('./maildir.js');
