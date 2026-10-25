// Small signs of life on resting avatars: now and then one visible avatar blinks or makes a small move.
//
// A resting avatar is a frozen Bloub frame (see `AgentAvatar`), because running every Bloub clock on
// screen cost a style recalculation per avatar per frame. This keeps that: nothing runs per frame. One
// timer for all avatars picks a single visible resting one per beat and adds a class whose animation
// plays once - a blink scales its eyes for a fraction of a second, a move shifts the whole box - and
// the class goes when the animation ends. A list of agents then reads as alive at the cost of one
// short animation every couple of seconds.

/** The small move each agent makes, picked from its seed so the same agent always moves the same way. */
export const RESTING_MOVES = ["hop", "sway", "stretch", "look"] as const;
export type RestingMove = (typeof RESTING_MOVES)[number];

// Time between beats, in milliseconds. A random point in the range, so the beats do not tick.
const BEAT_MIN_MS = 1_600;
const BEAT_MAX_MS = 3_400;
// Share of the beats that blink; the rest make the agent's move.
const BLINK_SHARE = 0.7;
// The longest animation; its class is taken off after this even if `animationend` never arrives
// (an avatar that left the page, or a style that did not load).
const LIFE_CLASS_MS = 1_200;
const BLINK_CLASS = "agent-avatar-life-blink";
const MOVE_CLASSES: Readonly<Record<RestingMove, string>> = {
  hop: "agent-avatar-life-hop",
  sway: "agent-avatar-life-sway",
  stretch: "agent-avatar-life-stretch",
  look: "agent-avatar-life-look",
};
const LIFE_CLASSES = [BLINK_CLASS, ...Object.values(MOVE_CLASSES)];

const visible = new Set<HTMLElement>();
let registered = 0;
let observer: IntersectionObserver | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let reducedMotion: MediaQueryList | undefined;

/** The move of a seed: the same agent always makes the same move. */
export function restingMove(seed: string): RestingMove {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return RESTING_MOVES[(hash >>> 0) % RESTING_MOVES.length] ?? "hop";
}

function quiet(): boolean {
  return document.hidden || reducedMotion?.matches === true;
}

function schedule(): void {
  if (timer !== undefined || visible.size === 0 || quiet()) return;
  timer = setTimeout(beat, BEAT_MIN_MS + Math.random() * (BEAT_MAX_MS - BEAT_MIN_MS));
}

function stop(): void {
  if (timer === undefined) return;
  clearTimeout(timer);
  timer = undefined;
}

function beat(): void {
  timer = undefined;
  // Only an avatar that rests right now: one that is hovered or busy is playing its Bloub clock.
  const candidates = [...visible].filter((element) => element.dataset.life === "rest" && element.isConnected);
  const element = candidates[Math.floor(Math.random() * candidates.length)];
  if (element) play(element);
  schedule();
}

function play(element: HTMLElement): void {
  if (LIFE_CLASSES.some((name) => element.classList.contains(name))) return;
  const move = RESTING_MOVES.find((candidate) => candidate === element.dataset.lifeMove);
  const name = Math.random() < BLINK_SHARE || !move ? BLINK_CLASS : MOVE_CLASSES[move];
  element.classList.add(name);
  const done = () => {
    clearTimeout(fallback);
    element.removeEventListener("animationend", done);
    element.classList.remove(name);
  };
  const fallback = setTimeout(done, LIFE_CLASS_MS);
  element.addEventListener("animationend", done);
}

function onVisibility(): void {
  if (quiet()) stop();
  else schedule();
}

function start(): void {
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!(entry.target instanceof HTMLElement)) continue;
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    }
    if (visible.size === 0) stop();
    else schedule();
  });
  reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  reducedMotion?.addEventListener?.("change", onVisibility);
  document.addEventListener("visibilitychange", onVisibility);
}

function end(): void {
  stop();
  observer?.disconnect();
  observer = undefined;
  visible.clear();
  reducedMotion?.removeEventListener?.("change", onVisibility);
  reducedMotion = undefined;
  document.removeEventListener("visibilitychange", onVisibility);
}

/**
 * Lets one avatar take part in the beats while it is on screen. The element carries
 * `data-life="rest"` while it shows a frozen frame and `data-life-move` with its move.
 * Returns the release.
 */
export function attachRestingLife(element: HTMLElement): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  if (registered === 0) start();
  registered += 1;
  observer?.observe(element);
  return () => {
    observer?.unobserve(element);
    visible.delete(element);
    for (const name of LIFE_CLASSES) element.classList.remove(name);
    registered -= 1;
    if (registered === 0) end();
  };
}
