/* Is what the owner said too vague to diagnose? "It's broken", "fan not
   working", "kharab hai", "help" name no symptom, so the first try gets a
   nudge to say what the machine does or doesn't do. A second vague try
   goes ahead anyway (page.tsx), so this never blocks anyone. */

const FILLER = String.raw`(?:(?:hey|hi|ok|so|please|pls|umm?|uh)\s+)*`;
const OWNER = String.raw`(?:(?:my|the|this|our|mera|meri|ye|yeh)\s+)?`;
const THING = String.raw`(?:[a-z0-9-]+\s+){0,2}?`;
const VERB = String.raw`(?:(?:is|it'?s|its|has|got|seems|went|stopped)\s+)?(?:(?:totally|completely|just|not)\s+)?`;
const GENERIC =
  String.raw`(?:broken|broke|not\s+working|doesn'?t\s+work|does\s+not\s+work|isn'?t\s+working|won'?t\s+work|` +
  String.raw`dead|faulty|damaged|bad|messed\s+up|acting\s+up|` +
  String.raw`kharab(?:\s+(?:hai|ho\s+gaya|ho\s+gya|ho\s+gayi))?|kaam\s+nahi\s+kar\s+(?:raha|rahi)(?:\s+hai)?|` +
  String.raw`(?:having\s+)?(?:a\s+|some\s+)?(?:problems?|issues?|trouble))`;
const TAIL = String.raw`(?:\s+(?:please|pls|again|now|hai|yaar|help))*`;

const VAGUE = new RegExp(`^${FILLER}${OWNER}${THING}${VERB}${GENERIC}${TAIL}$`);
// Naming a part is already a symptom ("the screen is broken").
const PART = /\b(?:screen|display|keys?|keyboard|buttons?|door|lid|light|chain|filter|battery|wheel|tyres?|tires?|cable|cord|plug|switch|remote|blades?|handle|pipe|hose|motor|belt|brakes?|knob|hinge|speaker|mic|camera|charger|port|tray|drum|compressor)\b/;
const ASK = /^(?:please\s+)?(?:help(?:\s+me)?|fix\s+(?:it|this|me)|what'?s\s+wrong(?:\s+with\s+(?:it|this))?|check\s+(?:it|this))$/;

export function isVague(said: string): boolean {
  const s = said.toLowerCase().replace(/[.,!?'"’]+/g, (m) => (m.includes("'") || m.includes("’") ? "'" : " ")).replace(/\s+/g, " ").trim();
  if (!s) return true;
  if (s.split(" ").length === 1) return true; // just "laptop"
  if (ASK.test(s)) return true;
  return VAGUE.test(s) && !PART.test(s);
}
