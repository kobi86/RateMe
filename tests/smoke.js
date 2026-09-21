/*
 * Headless smoke tests for index.html.   Run:  node tests/smoke.js
 *
 * There is no build step and no browser here.  The script pulls the <script>
 * block out of index.html, runs it against small stubs for localStorage, fetch
 * and the DOM, then asserts on what the page would have rendered.
 *
 * The fetch stub deliberately behaves like the real PostgREST endpoint:
 *
 *   - GET returns ONLY the columns named in select=, so forgetting a column
 *     in the query fails a test instead of passing on a generous stub.
 *   - An upsert sent with return=minimal answers 200/201 with an EMPTY body.
 *
 * Both of those rules exist because a stub that ignored them shipped a bug:
 * see the "Past bugs" section of CLAUDE.md.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const FILE = process.argv[2] || path.join(__dirname, "..", "index.html");
const SOURCE = fs.readFileSync(FILE, "utf8").split("<script>")[1].split("</script>")[0];

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail && !ok ? "  -> " + detail : ""}`);
  if (!ok) failures++;
}

/* Boot one instance of the page with a given table and session. */
function boot(opts) {
  const table = opts.table || [];
  const session = opts.session || null;
  const state = { posted: null, selected: null, postStatus: opts.postStatus || 201 };

  global.fetch = function (url, init) {
    const method = (init && init.method) || "GET";
    if (method === "GET") {
      const cols = decodeURIComponent(url.split("select=")[1].split("&")[0]).split(",");
      state.selected = cols;
      const projected = table.map(function (row) {
        const out = {};
        cols.forEach(function (c) { if (c in row) out[c] = row[c]; });
        return out;
      });
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(projected)) });
    }
    state.posted = JSON.parse(init.body)[0];
    /* return=minimal -> empty body, the case that broke saving once */
    return Promise.resolve({ ok: true, status: state.postStatus, text: () => Promise.resolve("") });
  };

  const store = {};
  if (session) store["rateme.session.v1"] = session;
  global.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };

  const handlers = {}, nodes = {};
  const node = id => new Proxy({
    classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, style: {},
    parentNode: { classList: { toggle() {} } },
    addEventListener(ev, fn) { handlers[id + ":" + ev] = fn; },
    setAttribute() {}, appendChild() {}, querySelectorAll: () => [],
    reset() {}, focus() {}, blur() {},
    textContent: "", innerHTML: "", value: "", disabled: false
  }, { get: (t, p) => (p in t ? t[p] : undefined), set: (t, p, v) => { t[p] = v; return true; } });

  global.document = {
    getElementById: id => (nodes[id] = nodes[id] || node(id)),
    createElement: () => node("star"),
    addEventListener() {}, hidden: false, activeElement: null
  };
  global.window = { addEventListener() {}, scrollTo() {} };

  eval(SOURCE);
  return { state, handlers, nodes, store };
}

const settle = () => new Promise(r => setTimeout(r, 60));

(async function run() {
  console.log("\nlogin");
  {
    const { handlers, nodes, store } = boot({});
    const attempt = (u, p) => {
      delete store["rateme.session.v1"];
      nodes["username"].value = u;
      nodes["password"].value = p;
      handlers["login-form:submit"]({ preventDefault() {} });
      return store["rateme.session.v1"] || null;
    };
    check(attempt("Kobi", "1234560") === "kobi", "Kobi signs in");
    check(attempt("KOBI", "1234560") === "kobi", "username is case-insensitive");
    check(attempt("Sivan", "12345670") === "sivan", "Sivan signs in");
    check(attempt("Kobi", "12345670") === null, "one user's password does not open the other");
    check(attempt("Kobi", "123456") === null, "a wrong password is rejected");
    check(attempt("nobody", "1234560") === null, "an unknown user is rejected");
  }

  console.log("\nreading the shared table");
  {
    const t = [{ rater: "kobi", ratee: "sivan", stars: 4, comment: "Nice work", updated_at: "2026-09-19T12:00:00Z" }];
    const { state, nodes } = boot({ table: t, session: "sivan" });
    await settle();
    check(state.selected.includes("comment"), "the query asks for the comment column", state.selected.join(","));
    const body = nodes["received-body"].innerHTML;
    check(body.includes("Nice work"), "the receiver sees the comment");
    check(body.includes("h-comment"), "the comment renders in its own block");
    check(body.includes("4.0"), "the average is shown");
  }

  console.log("\nescaping");
  {
    const t = [{ rater: "kobi", ratee: "sivan", stars: 3, comment: "<img src=x onerror=alert(1)>", updated_at: "2026-09-19T12:00:00Z" }];
    const { nodes } = boot({ table: t, session: "sivan" });
    await settle();
    const body = nodes["received-body"].innerHTML;
    check(!body.includes("<img"), "markup in a comment is not injected");
    check(body.includes("&lt;img"), "markup in a comment is escaped");
  }

  console.log("\nsubmitting");
  for (const status of [200, 201, 204]) {
    const { state, handlers, nodes } = boot({ session: "kobi", postStatus: status });
    await settle();
    handlers["star:click"]({ currentTarget: { dataset: { value: "4" } } });
    nodes["comment"].value = "  trimmed  ";
    handlers["submit-btn:click"]();
    await settle();
    const msg = nodes["submit-msg"].textContent;
    check(!/Could not save/i.test(msg), `save succeeds on an empty ${status} body`, msg);
    if (status === 201) {
      check(state.posted.stars === 4, "the chosen stars are sent");
      check(state.posted.comment === "trimmed", "the comment is trimmed");
      check(state.posted.rater === "kobi" && state.posted.ratee === "sivan", "rater and ratee are right");
    }
  }
  {
    const { state, handlers, nodes } = boot({ session: "kobi" });
    await settle();
    handlers["star:click"]({ currentTarget: { dataset: { value: "5" } } });
    nodes["comment"].value = "   ";
    handlers["submit-btn:click"]();
    await settle();
    check(state.posted.comment === null, "a blank comment is stored as null, not an empty string");
  }

  console.log("\noffline");
  {
    const t = [{ rater: "kobi", ratee: "sivan", stars: 5, comment: "cached", updated_at: "2026-09-19T12:00:00Z" }];
    const { handlers, nodes } = boot({ table: t, session: "sivan" });
    await settle();                                   /* first load fills the cache */
    global.fetch = () => Promise.reject(new Error("network down"));
    handlers["refresh-btn:click"]();
    await settle();
    check(nodes["received-body"].innerHTML.includes("cached"),
          "a failed refresh still shows the last data this phone saw");
    check(/Offline/i.test(nodes["sync-status"].innerHTML),
          "the status line says it is offline", nodes["sync-status"].innerHTML);
  }

  console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
  process.exit(failures ? 1 : 0);
})();
