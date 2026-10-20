#!/usr/bin/env bash
# Starts the whole TLMS development stack in one terminal:
#   1. stops any emulators left running from an earlier session
#   2. writes the current Stripe CLI webhook secret into functions/.secret.local
#   3. starts Stripe webhook forwarding in the background (log: stripe-listen.log)
#   4. starts the Firebase emulators, keeping data between runs
# Press Ctrl+C once to stop everything (data is saved on the way out).
set -euo pipefail
cd "$(dirname "$0")"

PORTS=":9099,8080,5001,5002,4000,4400,4500,9150"
EVENTS="payment_intent.succeeded,payment_intent.payment_failed,payment_intent.canceled,charge.refunded,charge.refund.updated"
WEBHOOK_URL="localhost:5001/demo-tlms/us-central1/api/v1/webhooks/payment"

echo "• Clearing leftover emulators..."
lsof -ti "$PORTS" | xargs kill 2>/dev/null || true
sleep 1

if command -v stripe >/dev/null; then
  echo "• Updating the Stripe webhook secret in functions/.secret.local..."
  SECRET=$(stripe listen --print-secret --events "$EVENTS")
  touch functions/.secret.local
  if grep -q '^STRIPE_WEBHOOK_SECRET=' functions/.secret.local; then
    # -i.bak works with both macOS (BSD) and Linux (GNU) sed.
    sed -i.bak "s|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=$SECRET|" functions/.secret.local && rm -f functions/.secret.local.bak
  else
    printf '\nSTRIPE_WEBHOOK_SECRET=%s\n' "$SECRET" >> functions/.secret.local
  fi
  echo "• Starting Stripe webhook forwarding (output in stripe-listen.log)..."
  stripe listen --events "$EVENTS" --forward-to "$WEBHOOK_URL" > stripe-listen.log 2>&1 &
  STRIPE_PID=$!
  trap 'echo "• Stopping Stripe forwarding"; kill $STRIPE_PID 2>/dev/null || true' EXIT
else
  echo "! Stripe CLI not found: payments will stay pending (seat holds still work)."
fi

echo "• Starting Firebase emulators. Open http://localhost:5002 when you see 'All emulators ready'."
echo "  First time or empty data? In another tab: cd functions && npm run seed"
firebase emulators:start --import=./emulator-data --export-on-exit
