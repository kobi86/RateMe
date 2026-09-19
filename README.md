# RateMe

A two-person star-rating page. Static `index.html`, hosted on GitHub Pages,
with ratings kept in a Supabase table so both phones see the same data.

Live: https://kobi86.github.io/RateMe/

## Users

| Username | Password |
|----------|----------|
| Kobi     | 123456   |
| Sivan    | 1234567  |

These are in the page source and the repo is public. Do not reuse them anywhere.

## How it works

The page talks to Supabase's PostgREST endpoint directly with `fetch` - no SDK,
no build step, one file. Ratings load on login, on refresh, and whenever the app
returns to the foreground. A copy of the last successful read is cached in
`localStorage` so the app still shows something with no signal.

Config lives at the top of the script in `index.html`:

```js
var SUPABASE_URL      = "https://iqkhstacaabmegyayzvw.supabase.co";
var SUPABASE_ANON_KEY = "sb_publishable_...";
```

The publishable key is a public client key and is meant to be in page source.
Row-level security is what protects the data.

## Database schema

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

The primary key on `(rater, ratee)` is what makes re-rating an update rather
than a new row - the client upserts with `on_conflict=rater,ratee`.

There is deliberately no delete policy, so the public key cannot wipe the table.
To clear it, use the SQL editor:

```sql
delete from public.ratings;
```

## Migrations

Applied to an existing table in this order:

```sql
-- adds the optional comment that accompanies a rating
alter table public.ratings
  add column comment text check (comment is null or char_length(comment) <= 500);
```

Policies did not need changing - RLS is per row, not per column.

## Verified behaviour

- read returns the shared table to both phones
- re-rating updates the existing row instead of duplicating
- a `rater` outside the allowlist is rejected by RLS (401)
- `stars` outside 1-5 is rejected by the check constraint (400)
- delete through the public key silently affects no rows
- a comment round-trips and is shown under the stars it belongs to
- a blank comment is stored as null rather than an empty string
- comment text is escaped on render, so markup in a comment stays inert
