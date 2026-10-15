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
| Firestore data model and security rules | Implemented; rules tests run on the Firestore emulator |
| Cloud Functions API (tournaments, registration, close roster, results, swap, leaderboard) | Implemented and integration tested |
| Player portal and administrator dashboard (`public/`) | Implemented; first live run pending |
| Stripe test-mode payments, signed webhook, withdrawal with refund, reconciliation | Implemented; tested with recorded Stripe responses, live check pending |
| Email receipts, refund confirmations and match reminders (Resend adapter) | Implemented; tested with a recording mailer |
| Paper Golf scoring adapter | Implemented; unit and integration tested |

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

## Running the app locally

Start everything with one command from the project root:

```
./dev.sh
```

It clears leftover emulators, writes the Stripe CLI's webhook secret into
`functions/.env`, starts Stripe webhook forwarding in the background (output
in `stripe-listen.log`), and starts the emulators with data kept between runs.
Press Ctrl+C once to stop everything. The first time (or after clearing
data), load the demo data from a second terminal:

```
cd functions && npm run seed
```

Then open http://localhost:5002 and sign in with an emulator-only test account:
`player@venue.test` / `Password123` (player) or `admin@venue.test` /
`AdminPassword123` (administrator). Pay with Stripe's test card
`4242 4242 4242 4242`, any future expiry and any CVC. The Emulator Suite UI
is at http://localhost:4000.

To simulate the Paper Golf engine reporting a match after an administrator
has closed the Fall Classic roster, run `npm run test:scoring` (in `functions`).

Front-end structure (`public/js`): `models/` (Firebase setup and the API
client), `views/` (rendering helpers), and `controllers/` (authentication,
catalog, registration, live view and administration).

## Firebase setup

Development runs entirely on the Firebase Local Emulator Suite under the
project ID `demo-tlms`. The `demo-` prefix means the emulators can never reach
a real cloud project, so nothing here can affect Paper Golf's live Firebase
project. A separate production project will be created for deployment.

## Running the tests

Requirements: Node.js 22+, the Firebase CLI (`npm install -g firebase-tools`),
and Java 21+ for the Firestore emulator.

```
cd functions
npm install
npm test            # bracket engine unit tests (no emulator needed)
npm run test:rules  # Firestore security rules, on the Firestore emulator
npm run test:api    # REST API integration tests, on the Auth + Firestore emulators
npm run test:all    # all three
```

The engine suite checks every participant count from 2 through 128 for both
formats. The API tests use real emulator ID tokens and admin claims and cover
the 400/401/403/404/409 responses from the design's interface contract.

## API (v1)

All requests need `Authorization: Bearer <Firebase ID token>`.

| Method and path | Who | Purpose |
| --- | --- | --- |
| `POST /v1/tournaments` | Admin | Create and publish an event |
| `GET /v1/tournaments` | Player | List events |
| `POST /v1/registrations` | Player | Hold a seat (409 if duplicate, full, closed or past deadline) |
| `POST /v1/tournaments/:id/close` | Admin | Close roster, seed paid players by registration time, generate schedule |
| `POST /v1/tournaments/:id/matches/:matchId/result` | Admin | Record or correct a score and advance the bracket |
| `POST /v1/tournaments/:id/swap` | Admin | Swap two players in unplayed first-round matches |
| `GET /v1/tournaments/:id/leaderboard` | Player | Bracket and champion, or round-robin standings |
| `POST /v1/registrations/:id/withdraw` | Player (own) or Admin | Withdraw before the roster closes; refunds paid entries |
| `POST /v1/webhooks/payment` | Stripe (signature) | Payment succeeded/failed/canceled and refund events |
| `POST /v1/tournaments/:id/matches/:matchId/paper-golf` | Admin or scorer service account | Submit a player's Paper Golf round; when both are in, the lower total wins |
| `POST /v1/admin/reminders` | Admin | Send match reminders now (also scheduled hourly); `npm run send:reminders` calls this |
| `POST /v1/admin/reconcile` | Admin | Run the pending-payment reconciliation now (also scheduled every 5 minutes) |

## Stripe setup (test mode)

Create `functions/.env` (never committed):

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...   # printed by `stripe listen`
RESEND_API_KEY=re_...             # optional; without it emails are only logged
EMAIL_REDIRECT_TO=you@example.com # optional; send every email to this address
```

Email goes through an adapter (`src/adapters/emailAdapter.js`). The design
named SendGrid, but SendGrid retired its free plan in 2025, so the adapter
uses Resend; no other code depends on the provider. Until a sending domain is
verified, Resend only delivers to the account owner's address, which is what
`EMAIL_REDIRECT_TO` is for.

Every charge and refund uses an idempotency key built from the registration
ID and attempt number, and webhook events are recorded by event ID, so
retries and duplicate deliveries cannot double-charge, double-refund or
double-confirm.
