# Future work

Ideas worth keeping that aren't being built yet. Add one whenever it comes up,
while developing or while looking at other sites. Say where it came from and
why it might be worth doing. Nothing here is a commitment.

## Workshops and classes

Members post an in-person workshop or class: what skill, when, where (by
postcode, like projects), and how many places. Others RSVP. Running one earns a
teaching award on the teacher's profile.

- **Source:** the owner's note on profile awards, 2026-10-05, which mentioned
  teaching classes. There's no feature for it yet.
- **Why:** it moves the site from "find a collaborator" to "learn from someone
  near you", which is the most direct form of human cognitive engagement the
  site could offer.

## Written commendations from project owners

A project owner gives a teammate a short commendation in their own words
("taught me to TIG weld"), shown on the teammate's profile beside the automatic
awards.

- **Source:** an option weighed and set aside on 2026-10-05, when awards were
  settled as earned from activity only.
- **Why:** a commendation is human-written recognition, which fits the site's
  philosophy. It needs rules first, such as one per teammate per project and
  only after the project is done, so it can't turn into a popularity contest.

## Follow a project

Members follow a project and see its new updates in a personal feed.

- **Source:** Hackaday.io's project pages, seen during the 2026-10-05 prior-art
  search.
- **Why:** progress updates are the inspiration half of the site, and a follow
  is a low-effort way to keep people coming back to a build.

## Pin projects to a profile

People choose one to three projects to sit at the top of their profile, so it
opens with the work they're proudest of rather than the most recent.

- **Source:** suggested by the worker that built profiles and awards,
  2026-10-05.
- **Why:** profiles have no photos, so what someone has made is their face. It
  should be their pick.

## Search projects and questions

Full-text search with SQLite's built-in FTS5 index, so no new dependency.

- **Source:** recommended in planning, 2026-10-05.
- **Why:** people would find an existing answer before asking again, which
  fits a site that values working things out.

## Tool and workshop sharing

Members list tools or workshop access by region, for example "lathe available
in Belconnen, weekends".

- **Source:** recommended in planning, 2026-10-05.
- **Why:** it's very local and very DIY, and it lowers the barrier for people
  who have ideas but no garage.

## Team meetups

A team proposes a time and place, and members RSVP. The safety advice appears
at the point of planning.

- **Source:** recommended in planning, 2026-10-05.
- **Why:** meeting in person is where the 18+ rule and the "parents may
  accompany kids" policy actually matter.

## Download or delete my data

A privacy page, plus a way to export or delete your own posts and the
behaviour signals the site keeps about them.

- **Source:** recommended in planning, 2026-10-05.
- **Why:** the honest counterpart to collecting provenance signals, and a
  strong point in the "good" argument.

## Instruments dashboard

An admin health page showing live connection counts, slow requests and
errors, database and volume size against the 256 MB machine, and trends in
the honesty signals.

- **Source:** recommended in planning, 2026-10-05, with crit 10 ("Fly by
  instruments") in mind.
- **Why:** you can't fly a live app blind. It also gives spec checks for
  real-time latency and persistence something to protect.

## Leaving a team, and handing over leadership

Members of a lobby-formed team can leave it, and a leader can hand leadership
to another member directly instead of waiting for votes to shift.

- **Source:** suggested by the worker that built lobbies, 2026-10-05.
- **Why:** teams formed by strangers will sometimes not gel. A graceful way
  out stops dead teams piling up with a leader who has wandered off.

## Block-aware lobbies

When a lobby forms a team, skip pairing two people where one has blocked the
other, and hold the later joiner for the next team.

- **Source:** a known limitation flagged by the worker that built report and
  block, 2026-10-05.
- **Why:** today a blocked pair can still end up on the same team, which
  undercuts what blocking is for.

## Report status for reporters

People who filed a report can see whether it was resolved. They see the
outcome only, not admin notes.

- **Source:** suggested by the worker that built report and block, 2026-10-05.
- **Why:** a report that disappears into silence teaches people not to bother
  reporting.

# Mission Control

## Open crews on the home page

A "crew wanted" list of lobbies with free seats, so a stranger with only the
URL can join a mission instead of starting an empty one.

- **Source:** the phase 4 worker, 2026-10-12, noting the home page lists only
  your own missions.
- **Why:** week 11's crit has two classmates testing from the URL alone, and
  markers arrive cold. Without this, two strangers can't find each other.

## Re-claim a callsign on a second device

A short one-time code shown on your profile lets another browser take over the
same callsign.

- **Source:** the phase 3 worker, 2026-10-12; the cookie is the only identity.
- **Why:** clearing cookies or switching laptop loses your record, which
  matters once crew records count go-on-caution reports.

## Replay playhead

Play a finished mission back on the timeline bar, consoles side by side,
revealing what each seat saw at the moment it reported.

- **Source:** the phase 5 worker, 2026-10-12.
- **Why:** the argument is "you could see it and said GO anyway"; showing the
  console at that instant makes it land harder than a table row.

## Sound cues

A tone when a caution lights and when a poll opens.

- **Source:** the phase 4 worker, 2026-10-12.
- **Why:** under time pressure eyes are on your own panel; a sound pulls
  attention without anyone shouting.

## Agency history chart

Budget and reputation over time on the Agency page, with outcomes marked.

- **Source:** the phase 7 worker, 2026-10-12.
- **Why:** it makes the shared consequence visible: you can see the dip the
  crew before you caused.
