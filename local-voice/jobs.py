"""Background work for Scrappy — run tools while he keeps talking.

Jobs outlive barge-in. When they finish, a spoken result is queued and delivered
only when he's idle (not mid-turn / mid-speech).
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable


ALLOWED_JOB_TOOLS = frozenset(
    {
        "recall_search",
        "recall_ask",
        "recall_recent",
        "recall_live_context",
        "recall_open_actions",
        "recall_get_note",
        "recall_save_note",
        "recall_complete_action",
        "process_recent",
        "process_search",
        "process_note",
        "conversation_recent",
        "conversation_get",
    }
)

# Slow digs — when prefer_background is on, these NEVER block the spoken turn.
BACKGROUND_AUTO_TOOLS = frozenset(
    {
        "recall_search",
        "recall_ask",
        "recall_recent",
        "recall_live_context",
        "recall_open_actions",
        "recall_get_note",
        "recall_save_note",
        "recall_complete_action",
    }
)

# Tools that should usually stay on the foreground turn (Jake wants the answer now).
FOREGROUND_TOOLS = frozenset(
    {
        "process_recent",
        "process_search",
        "conversation_recent",
        "conversation_get",
        "job_start",
        "job_status",
        "job_list",
    }
)


@dataclass
class Job:
    id: str
    label: str
    tool: str
    args: dict[str, Any]
    status: str = "running"  # running | done | error
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    ok: bool = False
    result_text: str = ""
    error: str = ""
    spoken: bool = False

    def duration_ms(self) -> int:
        end = self.finished_at or time.time()
        return int(max(0, (end - self.started_at) * 1000))

    def brief(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "tool": self.tool,
            "status": self.status,
            "ok": self.ok,
            "duration_ms": self.duration_ms(),
            "error": self.error or None,
            "spoken": self.spoken,
        }


OnDone = Callable[["Job"], Awaitable[None]]
RunTool = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]
Journal = Callable[[dict[str, Any]], Awaitable[Any]]


class JobBoard:
    """Session-scoped background jobs."""

    def __init__(
        self,
        *,
        session_id: str,
        run_tool: RunTool,
        journal: Journal,
        on_done: OnDone,
        max_jobs: int = 6,
    ) -> None:
        self.session_id = session_id
        self._run_tool = run_tool
        self._journal = journal
        self._on_done = on_done
        self._max_jobs = max_jobs
        self.jobs: dict[str, Job] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    def active(self) -> list[Job]:
        return [j for j in self.jobs.values() if j.status == "running"]

    def list_jobs(self, limit: int = 8) -> list[dict[str, Any]]:
        items = sorted(self.jobs.values(), key=lambda j: j.started_at, reverse=True)
        return [j.brief() for j in items[: max(1, limit)]]

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def start(self, *, label: str, tool: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        name = str(tool or "").strip()
        if name not in ALLOWED_JOB_TOOLS:
            return {
                "ok": False,
                "error": "invalid_job_tool",
                "text": f"Can't background {name or '(missing)'}. Use a recall_/process_/conversation_ tool.",
            }
        if len(self.active()) >= self._max_jobs:
            return {
                "ok": False,
                "error": "too_many_jobs",
                "text": "Already have a few things cooking. Wait for one to finish.",
            }
        job_id = f"job-{uuid.uuid4().hex[:8]}"
        job = Job(
            id=job_id,
            label=(label or name).strip()[:120] or name,
            tool=name,
            args=args or {},
        )
        self.jobs[job_id] = job
        self._tasks[job_id] = asyncio.create_task(self._run(job))
        return {
            "ok": True,
            "text": (
                f"Started background work '{job.label}' (id {job.id}). "
                "Keep talking — I'll pipe up when it's done if you're free, "
                "or queue it if you're mid-sentence."
            ),
            "data": job.brief(),
        }

    async def _run(self, job: Job) -> None:
        await self._journal(
            {
                "kind": "job",
                "type": "start",
                "name": job.tool,
                "session_id": self.session_id,
                "by": "local-voice",
                "reason": job.label,
                "meta": {"job_id": job.id, "args": job.args},
            }
        )
        try:
            result = await self._run_tool(job.tool, job.args)
            job.ok = bool(result.get("ok"))
            job.result_text = str(result.get("text") or "")[:6000]
            if not job.ok:
                job.error = str(result.get("error") or "failed")
                job.status = "error"
            else:
                job.status = "done"
        except Exception as err:  # noqa: BLE001
            job.ok = False
            job.error = str(err) or "exception"
            job.result_text = ""
            job.status = "error"
        job.finished_at = time.time()
        await self._journal(
            {
                "kind": "job",
                "type": "done" if job.ok else "error",
                "name": job.tool,
                "session_id": self.session_id,
                "by": "local-voice",
                "reason": job.label,
                "text": (job.result_text or job.error)[:800],
                "meta": {
                    "job_id": job.id,
                    "ok": job.ok,
                    "error": job.error or None,
                    "duration_ms": job.duration_ms(),
                },
            }
        )
        try:
            await self._on_done(job)
        except Exception:
            pass
        self._tasks.pop(job.id, None)

    def status_payload(self, job_id: str) -> dict[str, Any]:
        job = self.jobs.get(str(job_id or "").strip())
        if not job:
            return {"ok": False, "error": "not_found", "text": "No job with that id."}
        snippet = (job.result_text or job.error or "")[:1200]
        return {
            "ok": True,
            "text": (
                f"{job.label}: {job.status}"
                + (f" — {snippet}" if snippet else "")
            ),
            "data": {**job.brief(), "result": snippet},
        }

    async def cancel_all(self) -> None:
        for task in list(self._tasks.values()):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks.values(), return_exceptions=True)
        self._tasks.clear()


def parse_job_args(raw: Any) -> dict[str, Any]:
    """Accept dict or JSON string for job_start.args_json."""
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        line = raw.strip()
        if not line:
            return {}
        try:
            parsed = json.loads(line)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}
