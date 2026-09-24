// Tiny JSON document Scrappy's agentic behaviors share.
// Callers pass an absolute path. Missing or corrupt files read as {}.

const fs = require("fs");

function read(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function write(filePath, data) {
  fs.mkdirSync(require("path").dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  return data;
}

function update(filePath, mutate) {
  const next = mutate(read(filePath)) || {};
  return write(filePath, next);
}

module.exports = { read, write, update };
