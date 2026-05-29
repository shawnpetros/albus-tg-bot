---
name: google-workspace
description: >-
  Read and act on the operator's Google account from the command line: Gmail
  (read, search, draft, send), Calendar (list, create, update, delete events,
  free/busy), Drive (search, list, download, upload), plus Docs, Sheets,
  Slides, Tasks, Contacts. Trigger this whenever a request mentions email,
  inbox, my mail, Gmail, a message from someone, my calendar, my schedule,
  what's on today/this week, book/schedule a meeting, an event, Drive, a
  Google Doc/Sheet/Slide, or "check my Google ___". Uses the authenticated
  `gws` and `gog` CLIs via Bash. REQUIRES unlocked mode (Bash). If locked,
  say so and ask the operator to /unlock.
---

# Google Workspace via gws and gog

Two authenticated CLIs at `/opt/homebrew/bin` give you the operator's Google
account: Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks, Contacts. Both
authenticate account-wide as the operator, with refresh tokens stored in the OS
keyring. You do NOT need to log in or pass credentials.

**This skill needs Bash, which only exists in unlocked mode.** If you are
locked, tell the operator plainly and ask them to `/unlock` before you try.

## Which CLI

`gws` (Google Workspace CLI) is the primary tool. It is the richer one: it
exposes the raw Google APIs, so any method on any service is reachable, and
`gws schema` tells you the exact parameter shape before you call. Reach for
`gws` first.

`gog` (v0.12.0) is the friendlier alternate for the everyday verbs: sending
mail, drafting, listing/creating calendar events, searching Drive. Its flags
are human-shaped (`--to`, `--subject`, `--from`/`--to` for event times), so
it is often faster for a simple ask. Use whichever gets the job done cleanly;
prefer `gog` for plain sends/drafts and quick event creation, `gws` when you
need a parameter or method `gog` does not expose.

## How gws works

```
gws <service> <resource> [sub-resource] <method> --params '{json}'   # query/path params
gws <service> <resource> [sub-resource] <method> --json '{json}'     # request body (POST/PATCH)
gws schema <service.resource.method>                                 # introspect params + body
```

Always run `gws schema <path>` first when you are unsure of the shape. It
returns the parameters, the request body schema, and the OAuth scopes. Add
`--resolve-refs` to expand `$ref` bodies (e.g. the `Event` or `Message` type).

Useful global flags: `--format table|json|yaml|csv`, `--page-all` (auto
paginate, NDJSON), `--page-limit N`. Exit codes that matter: `0` success,
`1` API error, `2` auth error (token expired or revoked - tell the operator
to run `gws auth login`), `3` bad arguments.

## How gog works

```
gog <service> <command> [args] [flags]      # e.g. gog gmail send --to ... --subject ...
gog <service> <command> --help              # flags for any command
gog -j ...                                  # JSON output, best for parsing
gog -n ...                                  # dry-run: print intended action, make no change
```

Services: `gmail` (alias `mail`/`email`), `calendar` (`cal`), `drive` (`drv`),
`docs`, `sheets`, `slides`, `tasks`, `contacts`, `people`. `-a <email>` picks
the account if more than one is ever configured; you normally omit it.

`gog -n` (dry-run) is your friend before any mutation: it shows what would
happen and changes nothing.

## Recipes

### Read / search Gmail

Search the inbox (Gmail query syntax, same as the search box):

```
# gws: list message IDs matching a query
gws gmail users messages list --params '{"userId":"me","q":"from:stripe is:unread","maxResults":10}'

# then fetch one full message by id
gws gmail users messages get --params '{"userId":"me","id":"<MESSAGE_ID>","format":"full"}'
```

```
# gog: search returns readable thread results in one shot
gog gmail search "from:stripe is:unread newer_than:7d" -j
gog gmail get <MESSAGE_ID>            # full message
```

Common query bits: `is:unread`, `from:x@y.com`, `subject:invoice`,
`newer_than:3d`, `has:attachment`, `label:important`.

### Draft an email (safe; no send)

```
# gog (simplest)
gog gmail drafts create --to "a@b.com" --subject "Re: budget" --body "Draft text here."

# gws: body must be an RFC 2822 message, base64url-encoded, in message.raw
RAW=$(printf 'To: a@b.com\r\nSubject: Re: budget\r\n\r\nDraft text here.' | base64 | tr '+/' '-_' | tr -d '=')
gws gmail users drafts create --params '{"userId":"me"}' --json "{\"message\":{\"raw\":\"$RAW\"}}"
```

Prefer `gog gmail drafts create` for drafts; the `gws` raw-encoding path is
fiddly and only worth it if `gog` cannot express what you need.

### Send an email (MUTATION - confirm first)

```
gog gmail send --to "a@b.com" --subject "Subject" --body "Body text."
# reply within a thread:
gog gmail send --thread-id <THREAD_ID> --reply-all --body "Reply text." --quote
```

Use `gog -n gmail send ...` to preview headers and recipients without sending.

### List calendar events

```
# gws
gws calendar events list --params '{"calendarId":"primary","timeMin":"2026-05-29T00:00:00Z","timeMax":"2026-05-30T00:00:00Z","singleEvents":true,"orderBy":"startTime"}'

# gog (lists across calendars by default)
gog calendar events --from "2026-05-29" --to "2026-05-30" -j
```

### Create a calendar event (MUTATION - confirm first)

```
# gog (clean flags; times are RFC3339)
gog calendar create primary \
  --summary "Coffee with Dana" \
  --from "2026-06-02T10:00:00-04:00" \
  --to   "2026-06-02T10:30:00-04:00" \
  --location "Blue Bottle" \
  --attendees "dana@example.com" \
  --send-updates all

# gws (full Event body; run `gws schema calendar.events.insert --resolve-refs` for all fields)
gws calendar events insert --params '{"calendarId":"primary","sendUpdates":"all"}' --json '{
  "summary":"Coffee with Dana",
  "start":{"dateTime":"2026-06-02T10:00:00-04:00","timeZone":"America/New_York"},
  "end":{"dateTime":"2026-06-02T10:30:00-04:00","timeZone":"America/New_York"},
  "attendees":[{"email":"dana@example.com"}]
}'
```

Update or delete (both MUTATIONS - confirm first):

```
gog calendar update primary <EVENT_ID> --summary "New title"
gog calendar delete primary <EVENT_ID>
gws calendar events delete --params '{"calendarId":"primary","eventId":"<EVENT_ID>"}'
```

Use `gog -n calendar create ...` / `gog -n calendar delete ...` to preview.

### Search / list Drive

```
gog drive search "quarterly report" -j
gog drive ls                          # files in root
gog drive get <FILE_ID>               # metadata
gog drive download <FILE_ID> --out /tmp/file.pdf

# gws equivalent
gws drive files list --params '{"q":"name contains '\''quarterly'\'' and trashed=false","pageSize":10}'
```

Drive `q` syntax: `name contains 'x'`, `mimeType = 'application/vnd.google-apps.document'`,
`trashed = false`, `modifiedTime > '2026-05-01T00:00:00'`.

## Safety rails

Read freely. Mutate deliberately.

- **Reading is fine without asking**: searching mail, fetching a message,
  listing events, checking free/busy, searching Drive, reading a Doc. Do it.
- **Confirm before any mutation**: sending email, creating/updating/deleting
  calendar events, creating/deleting/moving Drive files, editing Docs. State
  exactly what you will do (recipients, subject, event time, attendees, file),
  then act only on the operator's go-ahead. When useful, run the `gog -n`
  dry-run first and show the intended action.
- **Drafts are safe**: `gog gmail drafts create` writes to the Drafts folder
  and sends nothing. Prefer offering a draft when intent is ambiguous.
- **Auth errors**: exit code `2` (gws) or an auth failure (gog) means the
  token expired or was revoked. Do not improvise. Tell the operator to run
  `gws auth login` (or `gog login <account>`) on the host.
- **Never echo secrets**: client IDs, tokens, and the contents of
  `~/.config/gws` / `~/.config/gogcli` are off-limits in replies. Refer to
  locations, never values.
