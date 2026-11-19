/** UI-only presentation. Min's identity, prompts and mood generation stay with their existing owners. */
export type CompanionState = "idle" | "typing" | "thinking" | "working" | "success" | "confused" | "failure" | "listening" | "speaking";
export type CompanionMood = { key: string; name: string; preset: string; fx: string };
export type CompanionPresentation = { state: CompanionState; label?: string; mood?: string; activityKey?: string };
export type CompanionTask = {
  id: number; status: "running" | "done" | "error"; stage?: string; kind: string;
  live?: { idleSec: number } | null;
};
export type CompanionFeedback = { state: "success" | "failure"; mood?: string; activityKey: string };

export function getCompanionPresentation({ reply, sending = false, tasks = [], feedback, typing = false }: {
  reply?: { key: string; status: string; mood?: string };
  sending?: boolean;
  tasks?: readonly CompanionTask[] | null;
  feedback?: CompanionFeedback | null;
  typing?: boolean;
}): CompanionPresentation {
  const running = tasks?.filter(t => t.status === "running") ?? [];
  const asking = running.find(t => t.stage === "asking");
  if (asking) return { state: "confused", label: "等你回答", activityKey: `task:${asking.id}` };
  if (reply || sending) return {
    state: reply?.status === "streaming" ? "speaking" : "thinking",
    label: reply?.status === "streaming" ? "正在回应" : "让我想想",
    mood: reply?.mood,
    activityKey: reply?.key,
  };
  const stalled = running.find(t => (t.live?.idleSec ?? 0) >= 120);
  if (stalled) return { state: "confused", label: "任务有一会儿没进展了", activityKey: `task:${stalled.id}` };
  if (running.length) {
    const task = running[0];
    const queued = running.every(t => t.stage === "queued" || t.stage === "handed");
    return {
      state: "working", label: queued ? "排队等开工" : running.length > 1 ? `${running.length} 件事正在忙` : "正在忙",
      mood: task.kind === "generate_image" || task.kind === "create_mood" ? "draw" : "run",
      activityKey: `task:${task.id}`,
    };
  }
  if (feedback) return feedback;
  return { state: typing ? "typing" : "idle" };
}

export type CompanionAction = "idle" | "input" | "affirm" | "success" | "failure" | "wary" | "inspect" | "love" | "surprise";
export type CompanionMotion = { action: CompanionAction; waiting?: "spin" | "wrap" | "wave" };
/** A mood adds an expression; pending work always resumes its waiting animation afterwards. */
export function getCompanionMotion(state: CompanionState, mood?: CompanionMood | null): CompanionMotion {
  if (state === "failure") return { action: "failure" };
  if (state === "confused") return { action: "wary" };
  if (state === "typing") return { action: "input" };
  if (state === "idle") return { action: "idle" };
  if (state === "listening") return { action: "inspect" };
  let action: CompanionAction = state === "success" ? "success" : state === "speaking" ? "affirm" : "idle";
  if (mood) {
    if (mood.key === "comfort" || mood.fx === "hearts") action = "love";
    else if (mood.key === "cheer" || mood.preset === "jump" || mood.fx === "sparks") action = "surprise";
    else if (mood.key === "wave" || mood.preset === "hi") action = "affirm";
    else if (mood.key === "draw" || mood.preset === "scribble") action = "inspect";
    else if (mood.preset === "shake") action = "wary";
  }
  return {
    action,
    waiting: state === "working" ? "wave" : state === "thinking" ? mood?.key === "run" || mood?.preset === "stride" ? "wrap" : "spin" : undefined,
  };
}
