# Dead Thinkers Dialogue — What We Are Building

## The Idea

A web app where you pick 2–3 of history's greatest minds and watch them debate any topic you throw at them — in their own voice, with their own philosophy, powered by AI.

You could ask Elon Musk, Warren Buffett, and Cleopatra whether AI should control global financial markets. Each one responds as *themselves* — not a generic chatbot. You can ask follow-up questions, join the debate, and watch their ideas clash in real time.

---

## What It Looks Like

### Landing Page
A dark, cinematic page with the app name and a single call to action: choose your thinkers.

### Thinker Selection
10 character cards laid out like a PlayStation or Xbox character select screen — each card has an AI-generated portrait, the thinker's name, and their domain (Science, Finance, Strategy, etc.). You tap up to 3 cards to "summon" them. The selection feels dramatic and gamified, not like clicking checkboxes.

Once you've picked your lineup, the selection screen collapses and the debate room opens.

### The Debate Room
A full-screen dark UI with each thinker in their own column — portrait, nameplate, and their responses flowing in underneath. At the bottom, there's a chat input where you type your question or topic.

When you submit a question, all selected thinkers respond in sequence, streaming token by token so it feels alive. Each thinker's column is color-coded and styled to feel distinct.

You can click on any thinker to direct a follow-up specifically at them. You're not just watching — you're part of the conversation.

Each thinker also shows a "thinking" panel you can expand to see their reasoning process before they give their final answer.

---

## The Technical Magic

### Every Thinker Uses a Different AI Model
This is the core idea. Alan Turing runs on Llama. Einstein runs on Mistral. Elon Musk runs on Qwen. Each of the 10 thinkers is mapped to a different open-source model hosted on Nebius AI — they never share a model. The multi-model architecture is the product.

### Each Thinker Is Grounded in Their Real Words
Before every response, the app searches a text corpus of each thinker's actual writings, speeches, and quotes. It finds the most relevant passages for the question being asked, and injects those into the AI's prompt. This is called RAG (Retrieval-Augmented Generation). The result is that Einstein sounds like Einstein, not like a generic AI pretending to be Einstein.

### Portraits Are AI-Generated
At startup, the app generates oil-painting-style portraits of all 10 thinkers via Nebius image generation. These are cached and served as the character images throughout the app.

### Streaming Responses
There are no loading spinners. Responses stream token by token directly into the UI, like watching someone type — but faster and more dramatic.

---

## The Roster

| Thinker | Domain |
|---------|--------|
| Alan Turing | Technology / AI |
| Albert Einstein | Science / Physics |
| Elon Musk | Tech Entrepreneurship |
| Narendra Modi | Politics / Governance |
| Cleopatra | Leadership / Power |
| Sun Tzu | Strategy / Warfare |
| Nikola Tesla | Invention / Vision |
| Donald Trump | Business / Politics |
| Warren Buffett | Finance / Investing |
| Kevin O'Leary | Venture / Investing |

---

## The Stack

- **Backend:** Python with FastAPI — handles debate sessions, fans out questions to each thinker's model, streams responses back
- **Frontend:** HTML, CSS, and vanilla JavaScript — single-page app, no framework overhead
- **AI:** Nebius AI for everything — LLM inference (10 models), embeddings for RAG, and image generation for portraits
- **Corpus:** Pre-written text files per thinker, chunked and embedded at startup

---

## The Feel

Dark. Cinematic. Like summoning legends, not opening a chatbot. Serif fonts for names and quotes. Dramatic lighting on portraits. Responses are punchy — 2 to 4 sentences max — so the debate moves fast and stays engaging.

---

## What We Are NOT Building (in this session)

- User accounts or saved debate history
- Mobile app
- Audio or video output
- Fine-tuned models
- More than 10 thinkers
