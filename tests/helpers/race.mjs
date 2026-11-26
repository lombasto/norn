// RM-26 S1: a race against a timeout. The timer is cleared once the race settles: a live setTimeout keeps node's event loop up, so
// a test file whose page loaded in 1 s still waited out its 15 / 60 / 90 s load timer before it could exit.
// timed(p, ms, v) = p's value, or v when p has not settled within ms.
export const timed = (p, ms, v) => { let t; return Promise.race([p, new Promise(r => { t = setTimeout(() => r(v), ms); })]).finally(() => clearTimeout(t)); };
