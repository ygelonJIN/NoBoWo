import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classIndexFromShortcut,
  isTextShortcutTarget,
} from '../dist/annotationShortcuts.js';

test('number keys map to ordered annotation classes', () => {
  assert.equal(classIndexFromShortcut('1', 3), 0);
  assert.equal(classIndexFromShortcut('2', 3), 1);
  assert.equal(classIndexFromShortcut('3', 3), 2);
});

test('number shortcuts reject missing classes and unrelated keys', () => {
  assert.equal(classIndexFromShortcut('4', 3), null);
  assert.equal(classIndexFromShortcut('0', 10), null);
  assert.equal(classIndexFromShortcut('a', 3), null);
});

test('typing surfaces do not trigger annotation shortcuts', () => {
  assert.equal(isTextShortcutTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTextShortcutTarget({ tagName: 'textarea' }), true);
  assert.equal(isTextShortcutTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTextShortcutTarget({ tagName: 'DIV' }), false);
  assert.equal(isTextShortcutTarget(null), false);
});
