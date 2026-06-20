import asyncio
import json
import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI
from pydantic import BaseModel

from thinkers import THINKERS, get_thinker_list

load_dotenv()

app = FastAPI()

NEBIUS_API_KEY = (os.environ.get("NEBIUS_API_KEY") or "").strip()

client = AsyncOpenAI(
    base_url="https://api.studio.nebius.ai/v1/",
    api_key=NEBIUS_API_KEY,
)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


# ── Static files ──────────────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.get("/")
async def root():
    return FileResponse(FRONTEND_DIR / "index.html")


# ── API ───────────────────────────────────────────────────────────────────────

@app.get("/api/thinkers")
async def list_thinkers():
    return get_thinker_list()


class Message(BaseModel):
    role: str
    content: str


class DebateRequest(BaseModel):
    question: str
    thinkers: list[str]
    histories: Optional[dict[str, list[Message]]] = None


async def stream_thinker(thinker_id: str, question: str, history: list[dict]):
    thinker = THINKERS.get(thinker_id)
    if not thinker:
        return

    messages = [{"role": "system", "content": thinker["system_prompt"]}]
    for msg in (history or []):
        messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": question})

    yield f"data: {json.dumps({'type': 'start', 'thinker': thinker_id})}\n\n"

    try:
        extra = thinker.get("extra_body")
        stream = await client.chat.completions.create(
            model=thinker["model"],
            messages=messages,
            stream=True,
            max_tokens=700,
            temperature=0.85,
            **({"extra_body": extra} if extra else {}),
        )

        buffer = ""
        in_think = False

        async for chunk in stream:
            delta = chunk.choices[0].delta.content or ""
            buffer += delta

            while True:
                if not in_think:
                    think_start = buffer.find("<think>")
                    if think_start == -1:
                        # No opening tag in buffer — safe to emit everything
                        # except hold the last 7 chars in case tag is split
                        safe = buffer[:-7] if len(buffer) > 7 else ""
                        if safe:
                            yield f"data: {json.dumps({'type': 'chunk', 'thinker': thinker_id, 'content': safe, 'is_thinking': False})}\n\n"
                            buffer = buffer[-7:]
                        break
                    else:
                        if think_start > 0:
                            yield f"data: {json.dumps({'type': 'chunk', 'thinker': thinker_id, 'content': buffer[:think_start], 'is_thinking': False})}\n\n"
                        buffer = buffer[think_start + 7:]
                        in_think = True
                else:
                    think_end = buffer.find("</think>")
                    if think_end == -1:
                        safe = buffer[:-8] if len(buffer) > 8 else ""
                        if safe:
                            yield f"data: {json.dumps({'type': 'chunk', 'thinker': thinker_id, 'content': safe, 'is_thinking': True})}\n\n"
                            buffer = buffer[-8:]
                        break
                    else:
                        if think_end > 0:
                            yield f"data: {json.dumps({'type': 'chunk', 'thinker': thinker_id, 'content': buffer[:think_end], 'is_thinking': True})}\n\n"
                        buffer = buffer[think_end + 8:]
                        in_think = False
                        yield f"data: {json.dumps({'type': 'think_end', 'thinker': thinker_id})}\n\n"

        # Flush remaining buffer
        if buffer.strip():
            yield f"data: {json.dumps({'type': 'chunk', 'thinker': thinker_id, 'content': buffer, 'is_thinking': in_think})}\n\n"

    except Exception as e:
        yield f"data: {json.dumps({'type': 'error', 'thinker': thinker_id, 'message': str(e)})}\n\n"

    yield f"data: {json.dumps({'type': 'end', 'thinker': thinker_id})}\n\n"


async def debate_generator(req: DebateRequest):
    # Fan out to every thinker concurrently and interleave their events as they
    # arrive, so all of them think and stream in parallel instead of waiting in
    # a queue behind each other.
    queue: asyncio.Queue = asyncio.Queue()

    async def run(thinker_id: str):
        history = []
        if req.histories and thinker_id in req.histories:
            history = [{"role": m.role, "content": m.content} for m in req.histories[thinker_id]]
        async for event in stream_thinker(thinker_id, req.question, history):
            await queue.put(event)

    async def runner():
        await asyncio.gather(*(run(t) for t in req.thinkers))
        await queue.put(None)  # sentinel: all thinkers done

    task = asyncio.create_task(runner())

    try:
        while True:
            event = await queue.get()
            if event is None:
                break
            yield event
    finally:
        task.cancel()

    yield f"data: {json.dumps({'type': 'done'})}\n\n"


@app.post("/api/debate/ask")
async def debate_ask(req: DebateRequest):
    if not NEBIUS_API_KEY:
        raise HTTPException(status_code=500, detail="NEBIUS_API_KEY not configured")

    missing = [t for t in req.thinkers if t not in THINKERS]
    if missing:
        raise HTTPException(status_code=400, detail=f"Unknown thinkers: {missing}")

    return StreamingResponse(
        debate_generator(req),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
