### Fixed

- After a plan usage limit resets, the agents it held start one at a time, 20 seconds apart, instead of all
  at once. If the window has not really reset, the first refused turn holds the rest again, so they spend
  nothing.
- A Claude agent that waited longer than an hour for a usage limit, with more than 40,000 tokens of
  context, starts its next turn in a new session from the OpenBot handoff instead of resuming the old
  session. Before, each resumed agent sent its whole session again at the cache-write price, and a few
  agents could spend a large part of the new 5-hour window within seconds of the reset.
