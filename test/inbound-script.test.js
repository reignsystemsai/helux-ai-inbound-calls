"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("the inbound script never asks callers to explain their reason again", () => {
  const serverSource = fs.readFileSync(
    path.join(__dirname, "..", "server.js"),
    "utf8"
  );
  const forbiddenOwnWords = [
    ["in", "your", "own", "words"],
    ["in", "their", "own", "words"]
  ].map((words) => words.join("\\s+")).join("|");

  assert.doesNotMatch(serverSource, new RegExp(
    `(?:${forbiddenOwnWords})[\\s\\S]{0,100}(?:why|reason)[\\s\\S]{0,100}calling`,
    "i"
  ));
  assert.doesNotMatch(serverSource, new RegExp(
    `explain[\\s\\S]{0,60}(?:${forbiddenOwnWords})`,
    "i"
  ));
});
