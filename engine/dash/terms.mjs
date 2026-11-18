// UX review 4: one name and one count per thing. The words are the glossary in engine/dash/README.md ("Words"); the counts of the same
// thing come from these functions only, so the Overview card, the Inbox, the tab badge, the page title and the Home filter agree.
// Pure, no I/O: the server (server.mjs) and the browser (ui.mjs, home.mjs) both load it.

/** an Inbox row that waits for you: every row but an answered question (it waits for the next check-in, not for you) and model advice
 * (advisory: it blocks nothing) */
export const isNeed = i => !!i && i.type !== 'answered' && i.type !== 'advice';
/** the rows of an Inbox list that need you */
export const needsOf = items => (items || []).filter(isNeed);
/** THE needs-you count of an Inbox list */
export const needsYou = items => needsOf(items).length;
