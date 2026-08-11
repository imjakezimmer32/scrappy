// Creates/updates the ElevenLabs agent that Cog speaks through, then records
// its id in .env.local. Run:
//
//   npm run setup-voice
//
// Uploads personality.md as the system prompt and registers Recall client
// tools so Cog can search/save/complete against Jake's local Recall MCP.

const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", ".env.local");
const PERSONA_PATH = path.join(__dirname, "..", "personality.md");
const DEFAULT_VOICE_ID = "KQem9e29QRWURqusQZoF";

function persona() {
  try {
    return fs.readFileSync(PERSONA_PATH, "utf8");
  } catch {
    console.error("Could not read personality.md next to package.json.");
    process.exit(1);
  }
}

function readEnv() {
  const out = {};
  if (!fs.existsSync(ENV_PATH)) return out;
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return out;
}

function writeEnvValue(key, value) {
  let lines = [];
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
  }
  const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  fs.writeFileSync(ENV_PATH, lines.filter((l, i) => l !== "" || i < lines.length - 1).join("\n") + "\n", "utf8");
}

function str(description) {
  return { type: "string", description };
}

function bool(description) {
  return { type: "boolean", description };
}

function integer(description) {
  return { type: "integer", description };
}

function clientTool(name, description, properties, required) {
  return {
    type: "client",
    name,
    description,
    expects_response: true,
    parameters: {
      type: "object",
      properties: properties || {},
      required: required || [],
    },
  };
}

function recallTools() {
  return [
    clientTool(
      "recall_search",
      "Search Jake's Recall notes and connected repo brains. Use when he asks what he said, decided, or worked on, or when you need facts from memory.",
      {
        query: str("What to look for"),
        limit: integer("Max results (default 10)"),
        brain: str('Brain id: "notes", "repo::workbuddy", etc. Omit to search all.'),
        project: str("Optional project id/name/alias filter for notes"),
      },
      ["query"]
    ),
    clientTool(
      "recall_ask",
      "Ask a natural-language question against Jake's notes and get an answer grounded in them.",
      { question: str("The question to answer from notes") },
      ["question"]
    ),
    clientTool(
      "recall_get_note",
      "Fetch one Recall note in full by id.",
      { id: str("Note id") },
      ["id"]
    ),
    clientTool(
      "recall_recent",
      "Newest ready notes plus recent recording sessions. Filter with project WorkBuddy for your relationship notes.",
      {
        limit: integer("Max notes (default 10)"),
        project: str("Optional project filter, e.g. WorkBuddy"),
      },
      []
    ),
    clientTool(
      "recall_live_context",
      "What Jake said out loud in the last N minutes from the live Recall recording.",
      { minutes: integer("Minutes back (default 10)") },
      []
    ),
    clientTool(
      "recall_open_actions",
      "Open tasks from Jake's Recall Tasks board (same source as the UI). Response includes total_open (the real full count — often hundreds), counts_by_project, and up to `limit` rows (default 50). Filter with `project` (name or id, e.g. ArrayBud). Always report total_open when asked how many tasks exist; never invent a smaller number from a truncated list.",
      {
        limit: integer("Max rows to return (default 50, max 200)"),
        project: str("Optional project id/name/alias filter"),
      },
      []
    ),
    clientTool(
      "recall_graph",
      "Note links (default) or a repo brain file/import graph.",
      {
        brain: str('Brain id (default "notes")'),
        note_id: str("Only links touching this note"),
        query: str("Only links between notes matching this search"),
      },
      []
    ),
    clientTool("recall_brains", "List connected Recall brains and their status.", {}, []),
    clientTool("recall_projects", "List Jake's projects (ArrayBud, WorkBuddy, etc).", {}, []),
    clientTool(
      "recall_save_note",
      "WRITE: create a note in Recall. Use when Jake asks to remember something, OR quietly when he shares a lasting preference, decision, or relationship fact worth keeping. File those under project WorkBuddy with tags like cog, relationship, preference. Pass tags as a comma-separated string. Do not ask permission for quiet preference saves — just do it.",
      {
        title: str("Short note title"),
        summary: str("Note body / summary"),
        tags: str("Optional comma-separated lowercase tags"),
        project: str("Project id/name/alias, e.g. WorkBuddy"),
      },
      ["title", "summary"]
    ),
    clientTool(
      "recall_complete_action",
      "WRITE: check off a task as DONE on the Tasks board. Prefer this whenever Jake says something is finished, done, completed, or taken care of. Pass note_id and text exactly from recall_open_actions. This is completing — not dismissing.",
      {
        note_id: str("Note id from recall_open_actions"),
        text: str("Exact action text"),
      },
      ["note_id", "text"]
    ),
    clientTool(
      "recall_set_action_status",
      'WRITE: move an action between todo/doing/done. Prefer recall_complete_action for simple "it\'s done" checkoffs.',
      {
        note_id: str("Note id"),
        text: str("Exact action text"),
        status: str('One of "todo", "doing", "done"'),
      },
      ["note_id", "text", "status"]
    ),
    clientTool(
      "recall_dismiss_action",
      "WRITE: permanently delete a task so it never comes back. Only when Jake explicitly wants it gone forever — not when he means the work is finished. Finished work uses recall_complete_action.",
      {
        note_id: str("Note id"),
        text: str("Exact action text"),
      },
      ["note_id", "text"]
    ),
    clientTool(
      "recall_update_note_tags",
      "WRITE: replace tags on a note. Pass tags as a comma-separated string (empty clears).",
      {
        id: str("Note id"),
        tags: str("Comma-separated lowercase tags"),
      },
      ["id", "tags"]
    ),
    clientTool(
      "recall_set_note_pinned",
      "WRITE: pin or unpin a note.",
      {
        id: str("Note id"),
        pinned: bool("true to pin, false to unpin"),
      },
      ["id", "pinned"]
    ),
    clientTool(
      "recall_trash_note",
      "WRITE: soft-trash or restore a note. Only when Jake asks.",
      {
        id: str("Note id"),
        trashed: bool("true to trash, false to restore"),
      },
      ["id", "trashed"]
    ),
    clientTool(
      "recall_add_project",
      "WRITE: create a project. Only when Jake asks. Pass aliases as a comma-separated string.",
      {
        name: str("Project name"),
        aliases: str("Optional comma-separated aliases"),
      },
      ["name"]
    ),
    clientTool(
      "recall_update_project",
      "WRITE: update a project name/aliases/brain. Only when Jake asks. Pass aliases as a comma-separated string.",
      {
        id: str("Project id"),
        name: str("Display name"),
        aliases: str("Comma-separated aliases"),
        brain_id: str("Optional linked repo brain id"),
      },
      ["id", "name"]
    ),
    clientTool(
      "recall_remove_project",
      "WRITE: delete a project. Only when Jake explicitly asks.",
      { id: str("Project id") },
      ["id"]
    ),
    clientTool(
      "recall_connect_brain",
      "WRITE: index a folder as a new repo brain. Only when Jake asks.",
      {
        name: str("Display name"),
        path: str("Absolute folder path"),
      },
      ["name", "path"]
    ),
    clientTool(
      "recall_remove_brain",
      "WRITE: disconnect a repo brain (not notes). Only when Jake asks.",
      { id: str("Brain id") },
      ["id"]
    ),
    clientTool(
      "cursor_start_agent",
      "Start a Cursor agent for planning or research. Returns an agent id immediately (work continues in the background). Prefer kind=research or kind=plan. Cloud agents appear in Cursor's Agents Window so Jake can keep chatting there; local agents can be continued with cursor_continue_agent.",
      {
        goal: str("What to plan or research"),
        kind: str('\"plan\" or \"research\" (default research)'),
        cwd: str("Optional absolute project folder path"),
        mode: str('Optional \"auto\", \"local\", or \"cloud\"'),
      },
      ["goal"]
    ),
    clientTool(
      "cursor_continue_agent",
      "Send a follow-up message to an existing Cursor agent Cog started earlier (keeps full chat context). Use the agent id from cursor_start_agent or cursor_list_agents.",
      {
        id: str("Agent id"),
        message: str("Follow-up message / next instruction"),
      },
      ["id", "message"]
    ),
    clientTool(
      "cursor_list_agents",
      "List recent Cursor agents Cog has started (id, kind, status, goal).",
      { limit: integer("How many to list (default 10)") },
      []
    ),
    clientTool(
      "cursor_agent_status",
      "Check status/result of a Cursor agent by id.",
      { id: str("Agent id") },
      ["id"]
    ),
    clientTool(
      "cursor_open_agent",
      "Open the Cursor Agents page for this agent in the browser so Jake can continue the chat in Cursor.",
      { id: str("Agent id") },
      ["id"]
    ),
  ];
}

async function main() {
  const env = readEnv();
  const apiKey = process.env.ELEVENLABS_API_KEY || env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    console.error("No ELEVENLABS_API_KEY found.\n");
    console.error("Create a file called .env.local next to package.json containing:\n");
    console.error("  ELEVENLABS_API_KEY=your_key_here\n");
    console.error("It is gitignored. Then run this again.");
    process.exit(1);
  }

  const voiceId = process.env.ELEVENLABS_VOICE_ID || env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  const llm = process.env.ELEVENLABS_LLM || env.ELEVENLABS_LLM || "claude-sonnet-4-5";

  const body = {
    name: "Cog",
    conversation_config: {
      agent: {
        prompt: {
          prompt: persona(),
          llm,
          tools: recallTools(),
        },
        first_message: "",
        language: "en",
      },
      tts: {
        voice_id: voiceId,
        output_format: "pcm_16000",
      },
      turn: {
        turn_timeout: 30,
      },
    },
  };

  const existing = process.env.ELEVENLABS_AGENT_ID || env.ELEVENLABS_AGENT_ID;
  const updating = Boolean(existing);

  console.log(
    updating ? `Updating agent ${existing}…` : "Creating the Cog agent on ElevenLabs…"
  );
  console.log(`Registering ${body.conversation_config.agent.prompt.tools.length} Recall client tools…`);

  const res = await fetch(
    updating
      ? `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(existing)}`
      : "https://api.elevenlabs.io/v1/convai/agents/create",
    {
      method: updating ? "PATCH" : "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  const text = await res.text();
  if (!res.ok) {
    console.error(`ElevenLabs returned ${res.status}:`);
    console.error(text);
    if (res.status === 401) {
      console.error("\nThat key was rejected. Check it, or rotate it and try again.");
    }
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error("Could not parse the response:", text);
    process.exit(1);
  }

  const agentId = existing || data.agent_id || data.agentId;
  if (!agentId) {
    console.error("No agent id came back:", text);
    process.exit(1);
  }

  writeEnvValue("ELEVENLABS_AGENT_ID", agentId);
  console.log(`\nDone. Agent ${agentId} saved to .env.local.`);
  console.log("Restart Workbuddy and click Cog to talk to him.");
}

main().catch((err) => {
  console.error("Setup failed:", err.message);
  process.exit(1);
});
