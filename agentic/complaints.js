// The same complaint twice becomes a fix goal. Once is just noted.

const store = require("./store");

function noteComplaint(filePath, text) {
  const phrase = String(text || "").trim().replace(/\s+/g, " ");
  if (!phrase) return { count: 0, shouldFix: false, goal: null };
  const key = phrase.toLowerCase();
  let result = { count: 1, shouldFix: false, goal: null };
  store.update(filePath, (doc) => {
    const base = doc && typeof doc === "object" ? doc : {};
    const complaints = base.complaints && typeof base.complaints === "object" ? base.complaints : {};
    const prev = complaints[key] && typeof complaints[key] === "object" ? complaints[key] : {};
    const count = (Number(prev.count) || 0) + 1;
    complaints[key] = { text: phrase, count, updatedAt: new Date().toISOString() };
    result = {
      count,
      shouldFix: count >= 2,
      goal: count >= 2 ? `Fix this: ${phrase}` : null,
    };
    return { ...base, complaints };
  });
  return result;
}

module.exports = { noteComplaint };
