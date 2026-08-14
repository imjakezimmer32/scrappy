# Listening dictionary (Wispr Flow-style)

This fixes what Scrappy **hears**, not how he talks.

When Whisper mishears your words (like “Scrappy” → “carp” / “car”), the listening
dictionary rewrites the transcript **before** Scrappy thinks about it.

## File

`local-voice/listening-dictionary.json`

Edit that file anytime. Scrappy hot-reloads it — usually within a couple seconds.
No system-prompt changes needed.

## Two kinds of entries

### 1. Vocabulary
Names and terms Whisper should expect:

```json
"vocabulary": ["Scrappy", "Chief", "Recall", "ArrayBud"]
```

These also get fed into Whisper’s listening hint.

### 2. Replacements + phrases
Persistent mishearings:

```json
"replacements": [
  { "from": "crappy", "to": "Scrappy" }
],
"phrases": [
  { "from": "scrap he", "to": "Scrappy" }
]
```

- **replacements** = whole words (`crappy` → `Scrappy`)
- **phrases** = short word groups, especially wake-style (`hey scrap` → `hey Scrappy`)

We intentionally do **not** blindly replace every “scrap” in a sentence (so “scrap
that” stays “scrap that”). Wake phrases and rare mishearings like `scrapy` / `scrabby`
are safe.

## Seeded already

Includes Scrappy wake phrases and its common mishearings (`scrapy`, `crappy`,
`scrabby`, `snappy`, `scrap he`), plus ArrayBud, Recall, Cloudflare, Wrangler, etc.

## Add your own

1. Open `local-voice/listening-dictionary.json`
2. Add a replacement or phrase
3. Save
4. Talk to Scrappy again

Example:

```json
{ "from": "array bud", "to": "ArrayBud" }
```
