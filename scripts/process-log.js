// List recent Scrappy process-log events (starts, stops, kills, notes, chat beats).

const processJournal = require("../process-journal");
const path = require("path");

processJournal.init({ projectRoot: path.join(__dirname, "..") });

const limit = Number(process.argv[2] || 40);
const events = processJournal.recent(limit);

console.log(`Process log dir: ${processJournal.dir()}`);
console.log(`Showing last ${events.length} events:\n`);

for (const e of events) {
  const when = e.iso || "";
  const kills = e.kills && e.kills.length ? ` kills=[${e.kills.join(", ")}]` : "";
  const text = e.text ? ` :: ${String(e.text).slice(0, 120)}` : "";
  const reason = e.reason ? ` (${e.reason})` : "";
  const pid = e.pid != null ? ` pid=${e.pid}` : "";
  console.log(`${when}  [${e.kind}/${e.type}]  ${e.name}${pid}${reason}${kills}${text}`);
}

console.log(`\nAdd your own notes: open ${processJournal.inbox()}`);
console.log("Or tray menu → Add note to process log…");
