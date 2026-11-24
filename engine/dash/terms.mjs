// UX review 4: one name and one count per thing. The words are the glossary in engine/dash/README.md ("Words"); the counts of the same
// thing come from these functions only, so the status strip, the Inbox, the bar badge, the page title, the Lanes needs and the Controller filter agree.
// Pure, no I/O: the server (server.mjs) and the browser (ui.mjs, home.mjs) both load it.

/** an Inbox row that waits for you: every row but a resolved question (INBOX-REPLIES: the Resolved view keeps its thread) and an
 * enforce card already asked for (its directive exists). The Inbox holds only what the owner must answer (UI redesign 2026-11-20). */
export const isNeed = i => !!i && i.type !== 'resolved' && !(i.type === 'enforce' && i.asked);
/** the rows of an Inbox list that need you */
export const needsOf = items => (items || []).filter(isNeed);
/** THE needs-you count of an Inbox list */
export const needsYou = items => needsOf(items).length;
