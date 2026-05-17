#!/usr/bin/env node
process.argv.splice(2, 0, 'send');
require('./maildir.js');
