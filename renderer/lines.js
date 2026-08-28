// Scrappy's voice. Short, earnest, a little dry. Never mean, never a paragraph.

const LINES = {
  done: [
    "Agent's done. Your move.",
    "It finished. I checked twice.",
    "Back to it — the machine stopped typing.",
    "Done. Go read what it did to your code.",
    "That's a wrap on the agent. You're up.",
    "Finished. I've been holding this for you.",
    "It's done and I have been standing here.",
  ],

  doneAgain: [
    "Still done. Still waiting.",
    "I'm going to keep doing this, you know.",
    "Hello. The agent finished. Some time ago.",
    "I have nothing else going on. I can wait.",
    "This is the part where you come back.",
    "I'll assume you're on your way.",
  ],

  ack: [
    "There you are.",
    "Good. Let's go.",
    "Knew you'd show up.",
    "Back on it. Nice.",
    "Excellent. Resuming duties.",
    "That's the one.",
  ],

  nag: [
    "Still working, or…?",
    "Checking in. That's my whole job.",
    "You've got one thing open. Is it the right one?",
    "Small nudge. Carry on.",
    "How's the thing going? The thing.",
    "Not judging. Observing.",
    "This is a friendly ping.",
    "Ten more minutes on it. Then a break.",
  ],

  chatter: [
    "Just walking.",
    "Nice desktop.",
    "I could do this all day. I do.",
    "Don't mind me.",
    "Stretching my gears.",
  ],

  thrown: [
    "Rude.",
    "I have a gyroscope, you know.",
    "Wheeee. Ow.",
    "Do that again.",
    "Structural integrity: fine.",
    "I'm telling the taskbar.",
    "Ten out of ten landing.",
  ],

  cling: [
    "Got it.",
    "Mine now.",
    "I live here too.",
    "Sharing is a myth.",
    "This is my mouse.",
  ],

  clingMiss: [
    "Come back.",
    "I almost had it.",
    "Coward.",
    "Bring that down here.",
  ],

  clingOff: [
    "Fine.",
    "You win.",
    "I'm telling the glass.",
    "That was vigorous.",
    "Ow. Okay.",
  ],

  wake: ["Oh — I'm up.", "I'm awake. I was awake.", "Rebooting my enthusiasm."],

  sleepy: ["Quiet around here.", "I'll be right here.", "Powering down a bit."],

  off: ["Alright. I'll sit this one out.", "Going quiet. Tray if you need me.", "Powering down."],
};

const lastPicked = new Map();

// Never say the same line twice in a row from the same bucket.
function pick(bucket) {
  const pool = LINES[bucket] || LINES.chatter;
  if (pool.length === 1) return pool[0];
  const prev = lastPicked.get(bucket);
  let line = prev;
  while (line === prev) {
    line = pool[Math.floor(Math.random() * pool.length)];
  }
  lastPicked.set(bucket, line);
  return line;
}

window.ScrappyLines = { LINES, pick };
