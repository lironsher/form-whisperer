# טופס בשיחה · Form Whisperer

Upload any paper form — a PDF or a phone photo — and fill it in by talking, in plain Hebrew.

Built at **Fable 5.2 Build Day, Tel Aviv** (23 Nov 2026). Topic: accessibility. Lane: Productive.

## What it does

Forms are a wall for many people: older people, new immigrants, people with low vision or a cognitive disability. This turns the form into a conversation.

1. **Reads a form it has never seen.** No templates. Claude Fable 5.2 looks at the page image, finds every place a person is meant to write, and reads the small print.
2. **Explains and asks.** It says what the form is for and what to have at hand, then asks one simple question at a time, with big answer buttons where a choice will do. Answers can be typed, tapped or spoken; questions can be read aloud, at a slower pace if needed.
3. **Writes on the original form.** One spoken sentence can fill a dozen boxes. Sections that do not apply are skipped.
4. **Looks things up.** If you do not remember your postal code, it searches for it from your address.
5. **Tells you what happens next.** What to sign, what to attach, who to hand it to — taken from the form's own instructions. Then you print the original form, filled in.

## Run it

```bash
npm install
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env
node --env-file=.env server.mjs
```

Open http://localhost:3101 and drop a form in, or try `http://localhost:3101/?sample` for Israeli tax form 101.

The first analysis of a new form takes two to three minutes; it is cached afterwards.

## How it works

- `server.mjs` — a small Node server with two Claude calls: one per page to locate the fields (structured output, coordinates read off a ruler grid drawn over the image), and one per conversation turn, with a `find_zip_code` tool backed by web search.
- `index.html` — one page, no build step: PDF rendering, the chat, speech in and out, and the handwriting overlay on the form.

The prompt that drives the conversation is `chatSystem` in `server.mjs`. See `DEMO.md` for the two-minute demo script.

## Limits

- Very small or blurry photos reduce placement accuracy.
- Signatures stay manual, on purpose.
- Sample forms are public Israeli government forms; all personal data in the demo is made up.
