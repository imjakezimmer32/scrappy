# Listening dictionary (Wispr Flow-style)

This fixes what Cog **hears**, not how he talks.

When Whisper mishears your words (like “Cog” → “carp” / “car”), the listening
dictionary rewrites the transcript **before** Cog thinks about it.

## File

`local-voice/listening-dictionary.json`

Edit that file anytime. Cog hot-reloads it — usually within a couple seconds.
No system-prompt changes needed.

## Two kinds of entries

### 1. Vocabulary
Names and terms Whisper should expect:

```json
"vocabulary": ["Cog", "Chief", "Recall", "WorkBuddy"]
```

These also get fed into Whisper’s listening hint.

### 2. Replacements + phrases
Persistent mishearings:

```json
"replacements": [
  { "from": "carp", "to": "Cog" }
],
"phrases": [
  { "from": "hey car", "to": "hey Cog" }
]
```

- **replacements** = whole words (`carp` → `Cog`)
- **phrases** = short word groups, especially wake-style (`hey car` → `hey Cog`)

We intentionally do **not** blindly replace every “car” in a sentence (so “my car”
stays “my car”). Wake phrases and rare mishearings like `carp` / `kog` are safe.

## Seeded already

Includes Cog / carp / car wake phrases, plus WorkBuddy, ArrayBud, Recall,
Cloudflare, Wrangler, etc.

## Add your own

1. Open `local-voice/listening-dictionary.json`
2. Add a replacement or phrase
3. Save
4. Talk to Cog again

Example:

```json
{ "from": "array bud", "to": "ArrayBud" }
```
