import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script id="converter">([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "converter script is present");
const converter = vm.runInNewContext(`${script}\n({ requireRun, segmentName, bestRealTime, createPracticeDocument })`);

class Element {
  constructor(name, text = "", attributes = {}) {
    this.localName = name;
    this.namespaceURI = null;
    this.value = text;
    this.attributes = { ...attributes };
    this.childNodes = [];
  }
  get children() { return this.childNodes; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get textContent() { return this.value + this.childNodes.map(child => child.textContent).join(""); }
  set textContent(value) { this.value = value; this.childNodes = []; }
  appendChild(child) { this.childNodes.push(child); return child; }
  removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1); return child; }
  setAttribute(name, value) { this.attributes[name] = value; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  cloneNode(deep) {
    const copy = new Element(this.localName, this.value, this.attributes);
    if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }
}

class Document {
  constructor(root) { this.documentElement = root; }
  cloneNode(deep) { return new Document(this.documentElement.cloneNode(deep)); }
  createElementNS(_namespace, name) { return new Element(name); }
  getElementsByTagName(name) {
    const found = [];
    function visit(node) {
      if (node.localName === name) found.push(node);
      for (const child of node.children) visit(child);
    }
    visit(this.documentElement);
    return found;
  }
}

function el(name, text = "", children = [], attributes = {}) {
  const element = new Element(name, text, attributes);
  for (const child of children) element.appendChild(child);
  return element;
}

function segment(name, best, game = "") {
  return el("Segment", "", [
    el("Name", name),
    el("SplitTimes", "", [el("SplitTime", "", [el("RealTime", "00:09:00")], { name: "Personal Best" })]),
    el("BestSegmentTime", "", [el("RealTime", best), ...(game ? [el("GameTime", game)] : [])]),
    el("SegmentHistory", "", [el("Time", "00:01:00")]),
  ]);
}

function sample() {
  return new Document(el("Run", "", [
    el("GameName", "Super Mario 64"),
    el("Metadata", "", [el("Run", "", [], { id: "old-run" })]),
    el("Offset", "00:00:05"),
    el("AttemptCount", "42"),
    el("AttemptHistory", "", [el("Attempt", "00:10:00")]),
    el("CustomComparisons", "", [el("Comparison", "Average")]),
    el("Segments", "", [
      segment("Start", "00:00:10"),
      segment("WF", "00:00:45", "00:00:40"),
      segment("SSL", "00:00:55", "00:00:50"),
      segment("BitDW", "00:01:30"),
    ]),
  ]));
}

function get(element, name) { return element.children.find(child => child.localName === name); }

test("middle range clears first BEST and cumulative records while retaining later BEST", () => {
  const source = sample();
  const output = converter.createPracticeDocument(source, 1, 2);
  const run = output.documentElement;
  const segments = get(run, "Segments").children;
  assert.deepEqual(segments.map(segment => get(segment, "Name").textContent), ["WF", "SSL"]);
  assert.equal(get(segments[0], "BestSegmentTime").children.length, 0);
  assert.equal(get(get(segments[1], "BestSegmentTime"), "RealTime").textContent, "00:00:55");
  assert.equal(get(get(segments[1], "BestSegmentTime"), "GameTime").textContent, "00:00:50");
  assert.equal(get(run, "Offset").textContent, "00:00:00");
  assert.equal(get(run, "AttemptCount").textContent, "0");
  assert.equal(get(run, "AttemptHistory").children.length, 0);
  assert.equal(get(get(run, "Metadata"), "Run").getAttribute("id"), "");
  assert.equal(get(run, "CustomComparisons").children.length, 0);
  for (const item of segments) {
    assert.equal(get(item, "SegmentHistory").children.length, 0);
    assert.equal(get(item, "SplitTimes").children.length, 1);
    assert.equal(get(item, "SplitTimes").children[0].children.length, 0);
  }
  assert.equal(get(get(source.documentElement, "Segments").children[1], "BestSegmentTime").children.length, 2);
});

test("one segment and invalid ranges", () => {
  const source = sample();
  const output = converter.createPracticeDocument(source, 3, 3);
  assert.equal(get(output.documentElement, "Segments").children.length, 1);
  assert.equal(get(get(output.documentElement, "Segments").children[0], "BestSegmentTime").children.length, 0);
  for (const [start, end] of [[-1, 1], [2, 1], [0, 4]]) {
    assert.throws(() => converter.createPracticeDocument(source, start, end));
  }
});

test("invalid input is rejected", () => {
  assert.throws(() => converter.requireRun(new Document(el("NotRun"))));
  assert.throws(() => converter.requireRun(new Document(el("Run"))));
});

if (process.env.LSS_REAL_FIXTURE_JSON) {
  test("real LiveSplit file follows the same conversion rules", () => {
    function fromJson(data) {
      return el(data.name, data.text, data.children.map(fromJson), data.attributes);
    }
    const data = JSON.parse(readFileSync(process.env.LSS_REAL_FIXTURE_JSON, "utf8"));
    const source = new Document(fromJson(data));
    const original = get(source.documentElement, "Segments").children;
    const output = converter.createPracticeDocument(source, 6, 16);
    const selected = get(output.documentElement, "Segments").children;
    assert.equal(original.length, 18);
    assert.equal(selected.length, 11);
    assert.equal(get(selected[0], "BestSegmentTime").children.length, 0);
    assert.equal(converter.bestRealTime(selected[1]), converter.bestRealTime(original[7]));
    assert.equal(get(output.documentElement, "AttemptCount").textContent, "0");
    assert.equal(get(output.documentElement, "AttemptHistory").children.length, 0);
  });
}
