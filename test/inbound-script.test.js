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

test("home price and purchase timeframe answers have explicit save instructions", () => {
  const serverSource = fs.readFileSync(
    path.join(__dirname, "..", "server.js"),
    "utf8"
  );

  assert.match(
    serverSource,
    /About how much are the homes you're considering\?[\s\S]{0,160}Save estimated_home_price/
  );
  assert.match(
    serverSource,
    /How soon would you like to become a homeowner\?[\s\S]{0,160}Save the exact answer as homebuying_timeline/
  );
  assert.match(
    serverSource,
    /Never say[\s\S]{0,500}Let me think about what we need to do next/i
  );
});
