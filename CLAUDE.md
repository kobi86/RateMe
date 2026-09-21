# RateMe — working notes

A private two-person star-rating app. Kobi and Sivan each rate the other 1–5
stars with an optional comment, from their own phones.

| | |
|---|---|
| **Live** | https://kobi86.github.io/RateMe/ |
| **Repo** | https://github.com/kobi86/RateMe (public, `main`) |
| **Hosting** | GitHub Pages, deploy from `main` / root |
| **Data** | Supabase project `iqkhstacaabmegyayzvw` |
| **Status** | Working and in use. No known bugs. |

## Layout

```
index.html      the entire app - markup, CSS and JS in one file
README.md       user-facing: schema, policies, what was verified
CLAUDE.md       this file
tests/smoke.js  headless tests, `node tests/smoke.js`
```

There is no build step, no framework, no package.json and no dependencies.
`index.html` is served exactly as it sits in the repo. Edit it and push; that
is the whole deploy.

## How it works

Login is two hardcoded users in a `USERS` object at the top of the script.
This is not real auth — it gates the UI, nothing more. The signed-in user is
kept in `localStorage` under `rateme.session.v1` so the app does not demand a
login every time a phone reopens it.

Ratings live in Supabase and are reached over PostgREST with plain `fetch` —
no SDK, which is what keeps this one file. Everything funnels through `api()`.

Reads happen on login, on the Refresh button, when the page returns to the
foreground (`visibilitychange`) and when the phone regains connectivity. The
last successful read is cached in `localStorage` under `rateme.cache.v2`, so a
phone with no signal shows the previous data rather than an empty card.

A rating is one row per direction, keyed on `(rater, ratee)`. Submitting
upserts with `on_conflict=rater,ratee`, so re-rating **replaces** your previous
rating and its comment. There is no history of past ratings by design. If a
running log is ever wanted, that means dropping the composite primary key for a
real `id` — a schema change, worth deciding before it matters.

## Credentials

| User | Password |
|------|----------|
| Kobi | `1234560` |
| Sivan | `12345670` |

Digits only, deliberately: the password field carries `inputmode="numeric"`
and `pattern="[0-9]*"` so phones open on the number pad. Adding a symbol back
would undo that.

The Supabase **publishable** key sits in the page source. That is fine — it is
a public client key, and row-level security is what protects the data. The
`service_role`/secret key must never appear here.

Note what this means: the repo is public, so anyone can read both passwords and
the key, sign in as either user, read the ratings and overwrite one as `kobi`
or `sivan`. Accepted for an app between two people. Fixing it properly means
real Supabase Auth, not a cleverer hardcoded password.

## Database

Table `public.ratings`, RLS on, three policies:

```sql
create table public.ratings (
  rater      text     not null,
  ratee      text     not null,
  stars      smallint not null check (stars between 1 and 5),
  comment    text     check (comment is null or char_length(comment) <= 500),
  updated_at timestamptz not null default now(),
  primary key (rater, ratee)
);

alter table public.ratings enable row level security;

create policy "read ratings"   on public.ratings for select to anon using (true);
create policy "insert ratings" on public.ratings for insert to anon
  with check (rater in ('kobi','sivan') and ratee in ('kobi','sivan'));
create policy "update ratings" on public.ratings for update to anon
  using (rater in ('kobi','sivan')) with check (rater in ('kobi','sivan'));
```

There is intentionally **no delete policy**, so the public key cannot wipe the
table. A DELETE through it returns 204 having changed nothing — that is RLS
working, not a bug. Clearing rows needs the SQL editor:

```sql
delete from public.ratings;
```

Schema changes need the Supabase SQL editor; the publishable key cannot run
DDL. So a change that adds a column is always two steps, **in this order**:

1. Kobi runs the migration in the dashboard.
2. Confirm the column is really there, then push the code.

Pushing first breaks saving for both users, because writing an unknown column
is a 400.

## Testing

```bash
node tests/smoke.js              # the current index.html
node tests/smoke.js some.html    # any other copy, e.g. a past commit
```

No browser and no network. The script pulls the `<script>` block out of
`index.html`, runs it against stubs and asserts on what the page would render.

**The stubs mimic the real endpoint on purpose, and this matters:**

- A GET returns **only the columns named in `select=`**, exactly as PostgREST
  does. Forget a column in the query and a test fails.
- An upsert with `return=minimal` answers **200/201 with an empty body**, not
  204.

Both rules exist because a stub that ignored them shipped a bug. Keep them.

To check a test is worth anything, run it against the commit that had the bug
and watch it fail:

```bash
git show 5dc2fb2:index.html > /tmp/old.html && node tests/smoke.js /tmp/old.html
```

Verifying against the real database is also cheap and worth doing for anything
touching storage — curl the REST endpoint directly with the publishable key.
**Do not use `kobi`/`sivan` as test data.** The upsert key is `(rater, ratee)`,
so a test write silently overwrites a real rating. This already happened once.

## Past bugs

Both were shipped, both were found by Kobi rather than by the tests, and both
have the same root cause: **the stub was written to match an assumption about
the API instead of what the API had already been observed doing.**

1. **Saving failed with "unexpected end of JSON input."** `Prefer:
   return=minimal` answers 200/201 with an empty body; the handler only treated
   204 as bodyless and called `res.json()` on an empty string. The row was
   written every time — only parsing the reply failed. Fixed by reading the
   body as text and parsing only when there is something there. The stub had
   returned 204, the one status that happened to work.

2. **Comments saved but never appeared.** The `comment` column was added, the
   write path sent it, the renderer drew it — but `select=` was never updated,
   so `comment` came back `undefined` on every row. Fixed by adding it to the
   query. The stub had returned a comment regardless of what was asked for.

The lesson worth carrying: when the real API's behaviour has already been seen
in this session, make the stub match *that*, not what seems reasonable.

## Working style that fits this project

- Deploys are live to two real people. Check the deploy actually landed —
  Pages lags 30–90s. Compare served bytes against local rather than trusting
  the push.
- The two phones are the point. A change that works on one browser and not
  across devices is not done; this is what the whole Supabase move was for.
- Mobile first. 16px minimum on inputs or iOS zooms on focus; 48px touch
  targets; safe-area insets for the notch. Do not regress these.
- Say what was actually verified against the real database versus what was
  only checked against stubs. The difference is where both bugs lived.
