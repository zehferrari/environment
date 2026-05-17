#!/usr/bin/env node
process.argv.splice(2, 0, 'mark-read');
require('./maildir.js');
