const test = require('brittle')
const lt = require('../lib/semver-lt')

test('major version comparison', function (t) {
  t.ok(lt('1.0.0', '2.0.0'))
  t.ok(!lt('2.0.0', '1.0.0'))
  t.ok(!lt('1.0.0', '1.0.0'))
})

test('minor version comparison', function (t) {
  t.ok(lt('1.0.0', '1.1.0'))
  t.ok(!lt('1.1.0', '1.0.0'))
  t.ok(!lt('1.1.0', '1.1.0'))
})

test('patch version comparison', function (t) {
  t.ok(lt('1.0.0', '1.0.1'))
  t.ok(!lt('1.0.1', '1.0.0'))
  t.ok(!lt('1.0.1', '1.0.1'))
})

test('prerelease is less than release', function (t) {
  t.ok(lt('1.0.0-alpha', '1.0.0'))
  t.ok(lt('1.0.0-beta.1', '1.0.0'))
  t.ok(!lt('1.0.0', '1.0.0-alpha'))
})

test('prerelease ordering', function (t) {
  t.ok(lt('1.0.0-alpha', '1.0.0-beta'))
  t.ok(lt('1.0.0-alpha.1', '1.0.0-alpha.2'))
  t.ok(!lt('1.0.0-beta', '1.0.0-alpha'))
})

test('numeric prerelease identifiers sort numerically', function (t) {
  t.ok(lt('1.0.0-1', '1.0.0-2'))
  t.ok(lt('1.0.0-2', '1.0.0-10'))
  t.ok(!lt('1.0.0-10', '1.0.0-2'))
})

test('numeric prerelease identifiers come before string identifiers', function (t) {
  t.ok(lt('1.0.0-1', '1.0.0-alpha'))
  t.ok(!lt('1.0.0-alpha', '1.0.0-1'))
})

test('shorter prerelease is less than longer with same prefix', function (t) {
  t.ok(lt('1.0.0-alpha', '1.0.0-alpha.1'))
  t.ok(!lt('1.0.0-alpha.1', '1.0.0-alpha'))
})

test('build metadata is ignored', function (t) {
  t.ok(!lt('1.0.0+build1', '1.0.0+build2'))
  t.ok(!lt('1.0.0+build2', '1.0.0+build1'))
  t.ok(lt('1.0.0+build', '1.0.1'))
})

test('0.0.0-0 is less than everything', function (t) {
  t.ok(lt('0.0.0-0', '0.0.0'))
  t.ok(lt('0.0.0-0', '0.0.1'))
  t.ok(lt('0.0.0-0', '1.0.0'))
  t.ok(lt('0.0.0-0', '1.0.0-alpha'))
})
