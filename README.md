# Tournament & League Management System (TLMS)

CSC425 Business Systems Integration project, Trident University International.

TLMS replaces the paper-based way a small golf or game venue runs paid
tournaments: registration, entry-fee payment, bracket generation, results, and
standings. It integrates Firebase (Authentication, Cloud Firestore, Cloud
Functions), Stripe (test mode), an email provider, and the existing
[Paper Golf](https://github.com/manthemanipulator/Paper-Golf) scoring engine.

## Current status

| Component | Status |
| --- | --- |
| Bracket and scheduling engine (`functions/bracket`) | Implemented and unit tested |
| Firestore data model and security rules | Not started |
| Cloud Functions API (registration, results, leaderboard) | Not started |
| Player portal and administrator dashboard | Not started |
| Stripe test-mode payments and webhook | Not started |
| Email notifications | Not started |
| Paper Golf scoring adapter | Not started |

This table is updated as each component is completed.

## Bracket and scheduling engine

`functions/bracket` contains pure functions with no database access, so the
same roster always produces the same schedule and every case can be unit
tested.

- **Single elimination** (`singleElimination.js`): bracket size is the
  smallest power of two at or above the field; byes go to the highest seeds
  and appear only in round one; standard seed placement keeps seeds 1 and 2
  apart until the final. Supports result recording, score corrections while
  the next match is unplayed, and administrator swaps between unplayed
  first-round matches.
- **Round robin** (`roundRobin.js`): circle method; odd fields get a rotating
  bye so each player sits out exactly once. Standings rank by points, then
  head-to-head among tied players, then score differential, then seed.
- Both formats support low-score-wins (golf) and high-score-wins games.

### Running the tests

Requires Node.js 22 or later. No dependencies need to be installed.

```
cd functions
npm test
```

The suite checks every participant count from 2 through 128 for both formats.
