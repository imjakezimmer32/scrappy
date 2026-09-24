// Stop for a person only when the choice is destructive or ambiguous.
// Reversible work proceeds.

function needsInterrupt(input = {}) {
  if (input.destructive === true) return { interrupt: true, reason: "destructive" };
  if (input.ambiguous === true) return { interrupt: true, reason: "ambiguous" };
  if (input.reversible === true) return { interrupt: false, reason: "reversible" };
  return { interrupt: false, reason: "proceed" };
}

module.exports = { needsInterrupt };
