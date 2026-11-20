// UX review 4: one name and one count per thing. The words are the glossary in engine/dash/README.md ("Words"); the counts of the same
// thing come from these functions only, so the status strip, the Inbox, the bar badge, the page title, the Lanes needs and the Talk filter agree.
// Pure, no I/O: the server (server.mjs) and the browser (ui.mjs, home.mjs) both load it.

/** an Inbox row that waits for you: every row but an answered question and a lane parked on one (they wait for the next check-in, not for you),
 * model advice (advisory: it blocks nothing), an enforce card already asked for (its directive exists) and a resolved question
 * (INBOX-REPLIES: the Resolved view keeps its thread) */
export const isNeed = i => !!i && !['answered', 'advice', 'resolved'].includes(i.type) && !(i.type === 'enforce' && i.asked) && !(i.type === 'parked' && i.ruled);   // item 8: a lane parked on an answered Q waits for the check-in
/** the rows of an Inbox list that need you */
export const needsOf = items => (items || []).filter(isNeed);
/** THE needs-you count of an Inbox list */
export const needsYou = items => needsOf(items).length;
