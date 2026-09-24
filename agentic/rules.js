// Preferences stored as rules and applied on the next run.

const store = require("./store");

function learnRule(filePath, text) {
  const phrase = String(text || "").trim();
  if (!phrase) return null;
  let saved = null;
  store.update(filePath, (doc) => {
    const base = doc && typeof doc === "object" ? doc : {};
    const rules = Array.isArray(base.rules) ? base.rules : [];
    const key = phrase.toLowerCase();
    if (!rules.some((rule) => String(rule.text || "").toLowerCase() === key)) {
      saved = { text: phrase, createdAt: new Date().toISOString() };
      rules.unshift(saved);
    } else {
      saved = rules.find((rule) => String(rule.text || "").toLowerCase() === key);
    }
    return { ...base, rules: rules.slice(0, 50) };
  });
  return saved;
}

function applicableRules(filePath, context) {
  const hay = String(context || "").toLowerCase();
  const doc = store.read(filePath);
  const rules = Array.isArray(doc.rules) ? doc.rules : [];
  if (!hay) return rules;
  return rules.filter((rule) => {
    const words = String(rule.text || "")
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 3);
    return words.some((word) => hay.includes(word));
  });
}

module.exports = { learnRule, applicableRules };
