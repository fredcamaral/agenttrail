// The scrubber every byte passes through on its way off this machine.
//
// A coding transcript is the worst thing there is to hand a third party
// unfiltered: it carries whatever the human pasted into a prompt and whatever a
// tool printed back — including the key they were told to rotate. So the rules
// below are deliberately greedy. A summary that says [redacted] one word too
// often costs a reader a detail; a summary that carries a live key costs a
// rotation, and the model provider keeps the copy either way.
//
// Zero deps, no I/O, no state: this is a pure string -> string so it can sit in
// the hot path of the adapter and of the summarizer without either one owning it.

const MASK = '[redacted]';

// Order matters. The keyed rule runs first because the KEY is what names the
// secret there — `password=hunter2` has a value no shape rule would ever catch.
const RULES = [
  // key = value / key: value / key => value, quoted or bare. The head (name,
  // separator, opening quote) is kept so the line still reads as itself; only
  // the value dies. `Bearer x` is taken as one value so it does not come back
  // as two masks.
  [/\b((?:api[_-]?key|authorization|credential|passwd|password|secret|token)s?["'`]?\s*(?:=>|[:=])\s*["'`]?)((?:Bearer\s+)?[^\s"'`,;)\]}]+)/gi, `$1${MASK}`],

  // An Authorization header pasted on its own, with no key= in front of it.
  [/\bBearer\s+[\w.~+/-]+=*/g, `Bearer ${MASK}`],

  // Vendor prefixes: here the SHAPE is the secret and no key name is needed.
  // The optional dotted tail is what makes eyJ... a whole JWT rather than its
  // header alone.
  [/\b(?:sk-|ghp_|gho_|ghu_|ghs_|github_pat_|AKIA|ASIA|xox[a-z]-|eyJ)[\w-]{8,}(?:\.[\w-]+){0,2}/g, MASK],

  // A hex run this long is a hash, a session key or an API secret. 40-hex git
  // SHAs go with them: losing a commit id from a 25-word summary is cheap, and
  // deciding "this hex is only a SHA" is exactly the judgement that leaks one.
  [/\b[0-9a-f]{32,}\b/gi, MASK],

  // The backstop for an opaque token of no known vendor shape. It fires only
  // when the run mixes lower, upper AND digits, because without that test every
  // long /Users/name/repos/Project/file path in a tool line reads as a secret —
  // and tool lines are most of what the material is made of.
  // ponytail: '/' is left out of the alphabet for that same reason, so a
  // standard-base64 blob whose every 40-char stretch is broken by a slash gets
  // through. Add '/' back here if a real leak ever takes that shape.
  [/\b(?=[\w+-]*[a-z])(?=[\w+-]*[A-Z])(?=[\w+-]*\d)[\w+-]{40,}={0,2}/g, MASK],
];

/** Every known secret shape in `text`, replaced by [redacted]. */
export function redact(text) {
  let s = String(text ?? '');
  for (const [re, to] of RULES) s = s.replace(re, to);
  return s;
}
