// SPDX-License-Identifier: MIT
'use strict';

// Pure diff logic for partial-replacement typing.
// Given the text we've typed so far and a new target, return the number of
// backspaces and the suffix to type so the prompt ends up showing newText.

function diff(typedText, newText) {
  const max = Math.min(typedText.length, newText.length);
  let p = 0;
  while (p < max && typedText.charCodeAt(p) === newText.charCodeAt(p)) p += 1;
  return {
    backspaces: typedText.length - p,
    insert: newText.slice(p),
  };
}

module.exports = { diff };
