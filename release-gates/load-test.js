'use strict';

/**
 * Release gate: latency and concurrency against the DEPLOYED API.
 *
 *   node release-gates/load-test.js            # burst: 200 clients, back-to-back requests
 *   node release-gates/load-test.js 50         # a smaller burst
 *   node release-gates/load-test.js 200 --think
 *        realistic profile: each simulated user pauses 1-5 seconds between
 *        actions, as a person browsing the site would
 *
 * Phase 1 measures single-request latency: one cold request, then 100
 * requests one after another, reporting the median and 95th percentile
 * against the design target (95th percentile under 800 ms).
 * Phase 2 starts N simulated clients at once (default 200, the design's
 * concurrency target); each signs nothing new but reuses the demo player's
 * session and makes 5 read requests (tournament list and a leaderboard).
 *
 * All requests are reads, so no data is changed. About 1,100 requests in
 * total, well within Firebase's no-cost usage.
 */
const { SITE, askHidden, signIn, saveResults } = require('./common');

const TARGET_P95_MS = 800;
const clients = Number(process.argv.find((a) => /^\d+$/.test(a))) || 200;
const THINK = process.argv.includes('--think');
const pause = () => new Promise((r) => setTimeout(r, THINK ? 1000 + Math.random() * 4000 : 0));
const PROFILE = THINK ? 'realistic (1-5 s think time between actions)' : 'burst (back-to-back requests)';
const PER_CLIENT = 5;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
function stats(ms) {
  const s = [...ms].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { count: s.length, min: s[0], median: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s[s.length - 1], mean: Math.round(mean) };
}

async function timed(url, token) {
  const t0 = performance.now();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  await res.arrayBuffer();
  return { ms: Math.round(performance.now() - t0), status: res.status };
}

async function main() {
  const password = await askHidden('Password for player@venue.test: ');
  const { token } = await signIn('player@venue.test', password);
  const list = `${SITE}/api/v1/tournaments`;
  const board = `${SITE}/api/v1/tournaments/fall-classic/leaderboard`;

  // Phase 1: latency.
  const cold = await timed(list, token);
  console.log(`First request (may include a cold start): ${cold.ms} ms, HTTP ${cold.status}`);
  const sequential = [];
  for (let i = 0; i < 100; i++) sequential.push((await timed(list, token)).ms);
  const latency = stats(sequential);
  console.log(`Sequential latency over 100 requests: median ${latency.median} ms, p95 ${latency.p95} ms, max ${latency.max} ms`);

  // Phase 2: concurrency.
  console.log(`Starting ${clients} concurrent clients x ${PER_CLIENT} requests, ${PROFILE}...`);
  const started = performance.now();
  const outcomes = await Promise.all(
    Array.from({ length: clients }, async (_, c) => {
      const mine = [];
      for (let i = 0; i < PER_CLIENT; i++) {
        await pause();
        try {
          mine.push(await timed(i % 2 === 0 ? list : board, token));
        } catch (err) {
          mine.push({ ms: null, status: 'network-error' });
        }
      }
      return mine;
    })
  );
  const wall = Math.round(performance.now() - started);
  const all = outcomes.flat();
  const ok = all.filter((o) => o.status === 200);
  const failures = all.length - ok.length;
  const load = stats(ok.map((o) => o.ms));
  const errorCodes = Object.entries(all.filter((o) => o.status !== 200).reduce((m, o) => ({ ...m, [o.status]: (m[o.status] || 0) + 1 }), {}));
  console.log(`Concurrent (${(all.length / (wall / 1000)).toFixed(1)} requests/s): ${ok.length}/${all.length} succeeded in ${wall} ms; median ${load.median} ms, p95 ${load.p95} ms, p99 ${load.p99} ms, max ${load.max} ms`);
  if (failures) console.log(`Failures by status: ${errorCodes.map(([k, v]) => `${k}: ${v}`).join(', ')}`);

  const verdict = {
    latencyP95UnderTarget: latency.p95 < TARGET_P95_MS,
    concurrentP95UnderTarget: load.p95 < TARGET_P95_MS,
    concurrentAllSucceeded: failures === 0,
  };
  console.log(`\nTarget p95 < ${TARGET_P95_MS} ms: sequential ${verdict.latencyP95UnderTarget ? 'MET' : 'NOT MET'}, under load ${verdict.concurrentP95UnderTarget ? 'MET' : 'NOT MET'}; ${clients} concurrent clients ${verdict.concurrentAllSucceeded ? 'all succeeded' : 'had failures'}.`);
  const file = saveResults(THINK ? 'load-test-realistic' : 'load-test-burst', {
    site: SITE, runAt: new Date().toISOString(), profile: PROFILE, targetP95Ms: TARGET_P95_MS,
    coldRequestMs: cold.ms, sequential: latency,
    concurrent: { clients, requestsPerClient: PER_CLIENT, wallClockMs: wall, succeeded: ok.length, total: all.length, failuresByStatus: Object.fromEntries(errorCodes), latency: load },
    verdict,
  });
  console.log(`Results saved to ${file}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
