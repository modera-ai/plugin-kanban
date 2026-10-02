import { useState } from "react";
import { Button, Textarea, ToggleRow, useLabel } from "@modera/ui";
import { Send } from "lucide-react";
import type { KanbanTask } from "../../src/types";
import type { Action } from "./shared";

export function Clarification({ task, disabled, act }: { task: KanbanTask; disabled: boolean; act: Action }) {
  const t = useLabel();
  const questions = task.analysis?.questions ?? [];
  const [answers, setAnswers] = useState<string[]>(questions.map(() => ""));
  const [continueExecution, setContinueExecution] = useState(false);
  return <form className="kb-clarification" onSubmit={event => {
    event.preventDefault();
    if (!disabled && answers.every(answer => answer.trim())) void act("answerQuestions", {id: task.id, revision: task.revision, answers, continueExecution});
  }}>
    <h3>{t("等待你的确认", "Awaiting your answers")}</h3>
    {questions.map((question, index) => <Textarea key={index} label={question} value={answers[index] ?? ""} rows={3} maxLength={5000} disabled={disabled} onChange={event => setAnswers(current => current.map((answer, at) => at === index ? event.target.value : answer))} />)}
    <ToggleRow label={t("分析通过后继续执行", "Continue execution after successful analysis")} checked={continueExecution} disabled={disabled} onCheckedChange={setContinueExecution} />
    <Button type="submit" variant="primary" size="small" disabled={disabled || !questions.length || !answers.every(answer => answer.trim())}><Send size={14} aria-hidden />{continueExecution ? t("提交回答并继续", "Answer and continue") : t("提交回答并重新分析", "Answer and reanalyze")}</Button>
  </form>;
}

export function ClarificationHistory({ task }: { task: KanbanTask }) {
  const t = useLabel();
  if (!task.clarifications?.length) return null;
  return <section className="kb-detail-section"><h3>{t("确认记录", "Clarification history")}</h3>{task.clarifications.map(item => <dl className="kb-clarification-history" key={item.id}>{item.answers.map((entry, index) => <div key={index}><dt>{entry.question}</dt><dd className="kb-raw">{entry.answer}</dd></div>)}</dl>)}</section>;
}
