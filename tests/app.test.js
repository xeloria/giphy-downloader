const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const parserStart = source.indexOf('const RESERVED');
const parserEnd = source.indexOf('// --- Fetch helpers ---');
const parserSource = parserStart >= 0 && parserEnd > parserStart ? source.slice(parserStart, parserEnd) : null;

if (!parserSource) throw new Error('Unable to locate parseGiphyUrl in app.js');

const context = { URL };
vm.runInNewContext(`${parserSource}\nparser = parseGiphyUrl;`, context);
const parseGiphyUrl = context.parser;
const parsed = input => JSON.parse(JSON.stringify(parseGiphyUrl(input)));

test('parses supported Giphy GIF and profile URLs', () => {
    assert.deepEqual(parsed('https://giphy.com/gifs/everyone-brown-shaun-LyJ6KPlrFdKnK'), { type: 'single', gifId: 'LyJ6KPlrFdKnK' });
    assert.deepEqual(parsed('https://i.giphy.com/media/LyJ6KPlrFdKnK/giphy.gif'), { type: 'single', gifId: 'LyJ6KPlrFdKnK' });
    assert.deepEqual(parsed('giphy.com/neilsanders'), { type: 'user', username: 'neilsanders' });
    assert.deepEqual(parsed('@neilsanders'), { type: 'user', username: 'neilsanders' });
    assert.deepEqual(parsed('happy dance'), { type: 'search', query: 'happy dance' });
    assert.deepEqual(parsed('celebration'), { type: 'search', query: 'celebration' });
});

test('rejects lookalike domains', () => {
    assert.deepEqual(parsed('https://evilgiphy.com/gifs/test-LyJ6KPlrFdKnK'), { type: 'invalid' });
    assert.deepEqual(parsed('https://giphy.com.evil.example/gifs/test-LyJ6KPlrFdKnK'), { type: 'invalid' });
});

test('keeps selection downloads disabled until something is selected', () => {
    assert.match(source, /\$\('#download-selected'\)\.prop\('disabled', selectedIds\.size === 0\)/);
});

test('uses cancellable, versioned content requests', () => {
    assert.match(source, /new AbortController\(\)/);
    assert.match(source, /requestId !== requestVersion/);
});
