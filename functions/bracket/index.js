'use strict';

/**
 * Entry point for the bracket and scheduling engine. Cloud Functions import
 * from here rather than from the individual files.
 */
const singleElimination = require('./singleElimination');
const roundRobin = require('./roundRobin');

/**
 * Generates the schedule for a closed roster in the requested format.
 * format: 'single_elimination' | 'round_robin'
 */
function generateSchedule(format, playerIds, options) {
  if (format === 'single_elimination') {
    return singleElimination.generateSingleElimination(playerIds, options);
  }
  if (format === 'round_robin') {
    return roundRobin.generateRoundRobin(playerIds, options);
  }
  throw new Error(`Unknown tournament format: ${format}`);
}

module.exports = { generateSchedule, ...singleElimination, ...roundRobin };
