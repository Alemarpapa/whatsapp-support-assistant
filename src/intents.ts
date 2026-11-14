export type Intent = 'human' | 'greeting' | 'hours' | 'location' | 'thanks' | 'unknown';

// Order matters: asking for a person wins over everything else in the same message.
// Keyword matching, English and Spanish. This is routing, not language understanding.
const RULES: Array<[Exclude<Intent, 'unknown'>, RegExp]> = [
  ['human', /\b(human|agent|person|representative|someone real|operator|humano|persona|asesor|agente|operador)\b/i],
  ['hours', /\b(hours?|open|close[ds]?|schedule|horarios?|abren|abierto|cierran|atienden)\b/i],
  ['location', /\b(address|located|location|where are you|direcci[oó]n|ubicaci[oó]n|d[oó]nde (est[aá]n|queda))\b/i],
  ['thanks', /\b(thanks|thank you|gracias)\b/i],
  ['greeting', /^\s*(hi|hello|hey|good (morning|afternoon|evening)|hola|buen[oa]s( d[ií]as| tardes| noches)?)\b/i]
];

export function detectIntent(text: string): Intent {
  for (const [intent, pattern] of RULES) if (pattern.test(text)) return intent;
  return 'unknown';
}

/** Placeholder answers for the demo. A real deployment would load these from its own settings. */
export const REPLIES: Record<Exclude<Intent, 'human'>, string> = {
  greeting: 'Hi! I am an automated assistant. Ask me about our hours or location, or type "agent" to talk to a person.',
  hours: 'We are open Monday to Friday, 9:00 to 18:00.',
  location: 'You can find us at 123 Example Street.',
  thanks: 'You are welcome!',
  unknown: 'Sorry, I did not understand that. You can ask about our hours or location, or type "agent" to talk to a person.'
};

export const HANDOFF_NOTICE = 'I am handing this chat to a person from our team. They will reply here. I will stay quiet from now on.';

/** Consecutive messages the bot fails to understand before it hands the chat to a person. */
export const MAX_UNKNOWN_STREAK = 2;
