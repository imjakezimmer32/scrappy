// Celebrate only when every check passed. Otherwise send the work back.

function shouldCelebrate(input = {}) {
  if (!input || input.claimedDone !== true) {
    return { celebrate: false, sendBack: false, reason: "not claimed done" };
  }
  const checks = Array.isArray(input.checks) ? input.checks : [];
  if (!checks.length) {
    return { celebrate: false, sendBack: true, reason: "no checks ran" };
  }
  const failed = checks.find((check) => !check || check.ok !== true);
  if (failed) {
    const name = failed.name || "a check";
    return { celebrate: false, sendBack: true, reason: `${name} failed` };
  }
  return { celebrate: true, sendBack: false, reason: "checks passed" };
}

module.exports = { shouldCelebrate };
